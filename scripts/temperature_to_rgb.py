#!/usr/bin/env python3
"""Export ERA5 temperature to per-hour RGB PNG files by pressure level.

Input:
  ../data/era5_2021-nov_250-500-925_temperature.nc

Outputs:
  ../public/temperature-rg/<pressure>/<timestamp>.png
  ../public/temperature-rg/temperature_ranges.json

Encoding:
  - R channel: linearly scaled temperature (K).
  - G/B channels: zero.
  - Longitude is half-rolled by default to match globe layer conventions.
"""

import argparse
import json
import os
from pathlib import Path

import h5py
import imageio.v2 as imageio
import numpy as np
from tqdm import tqdm

TIME_BLOCK_FALLBACK = 24
VAR_NAME = "t"
RANGE_FILENAME = "temperature_ranges.json"

# Keep all levels on the same absolute Kelvin range so level-to-level comparisons
# remain meaningful (e.g., 925 hPa should look warmer than 250 hPa).
DEFAULT_TEMP_RANGE_BY_LEVEL = {
    250: (180.0, 330.0),
    500: (180.0, 330.0),
    925: (180.0, 330.0),
}


def ensure_level_index(level_values, target_hpa):
    lv = np.asarray(level_values, dtype=np.float64)
    if lv.size == 0:
        raise ValueError("Level coordinate is empty")

    med = float(np.median(lv))
    values_hpa = lv / 100.0 if med > 2000.0 else lv

    idx = int(np.argmin(np.abs(values_hpa - float(target_hpa))))
    picked_hpa = float(values_hpa[idx])
    return idx, picked_hpa


def parse_levels(raw_levels):
    out = []
    for raw in raw_levels:
        p = int(raw)
        if p <= 0:
            raise ValueError(f"Invalid pressure level: {raw}")
        out.append(p)
    return out


def make_timestamp_str(unix_seconds):
    ts64 = np.datetime64(int(unix_seconds), "s")
    return np.datetime_as_string(ts64, unit="s").replace(":", "-")


def to_u8(x, data_min, data_max):
    denom = data_max - data_min
    if not np.isfinite(denom) or denom <= 0.0:
        return np.zeros_like(x, dtype=np.uint8)
    y = (x - data_min) * (255.0 / denom)
    y = np.clip(y, 0.0, 255.0)
    return y.astype(np.uint8)


def range_for_level(level_hpa):
    if level_hpa in DEFAULT_TEMP_RANGE_BY_LEVEL:
        return DEFAULT_TEMP_RANGE_BY_LEVEL[level_hpa]
    return 180.0, 330.0


def process_level(
    f,
    out_dir_base,
    pressure_hpa,
    levels,
    times,
    time_block,
    do_lon_half_roll,
):
    idx, picked_hpa = ensure_level_index(levels, pressure_hpa)
    t_min, t_max = range_for_level(pressure_hpa)

    out_dir = os.path.join(out_dir_base, f"{int(pressure_hpa)}")
    os.makedirs(out_dir, exist_ok=True)

    temp_var = f[VAR_NAME]
    n_times = temp_var.shape[0]
    half = temp_var.shape[-1] // 2

    print(f"\n=== processing pressure={pressure_hpa} hPa ===")
    print("OUT_DIR:", out_dir)
    print("picked level in file:", picked_hpa, "hPa")
    print("display scaling (K):", {"min": t_min, "max": t_max})

    for t0 in tqdm(range(0, n_times, time_block), desc=f"{int(pressure_hpa)} hPa blocks"):
        t1 = min(t0 + time_block, n_times)

        temp_block = np.array(temp_var[t0:t1, idx, :, :], dtype=np.float32)

        if do_lon_half_roll:
            temp_block = np.roll(temp_block, shift=-half, axis=2)

        r = to_u8(temp_block, t_min, t_max)
        g = np.zeros_like(r, dtype=np.uint8)
        b = np.zeros_like(r, dtype=np.uint8)
        rgb_block = np.stack([r, g, b], axis=-1)

        for j in range(t1 - t0):
            ti = t0 + j
            ts_str = make_timestamp_str(times[ti])
            out_path = os.path.join(out_dir, f"{ts_str}.png")
            imageio.imwrite(out_path, rgb_block[j])

    return t_min, t_max


def write_ranges_json(out_dir_base, ranges_by_hpa):
    payload = {
        "levels_hpa": sorted(ranges_by_hpa.keys()),
        "ranges": {
            str(p): {"min": ranges_by_hpa[p][0], "max": ranges_by_hpa[p][1]}
            for p in sorted(ranges_by_hpa.keys())
        },
    }
    out_path = Path(out_dir_base) / RANGE_FILENAME
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(
        description="Export ERA5 temperature to PNG RGB frames by pressure level."
    )
    parser.add_argument(
        "--input",
        default="../data/era5_2021-nov_250-500-925_temperature.nc",
        help="Input netCDF path",
    )
    parser.add_argument(
        "--out-dir-base",
        default="../public/temperature-rg",
        help="Output base dir (subdir per pressure level is created)",
    )
    parser.add_argument(
        "--levels",
        nargs="+",
        default=["250", "500", "925"],
        help="Pressure levels in hPa (e.g. --levels 250 500 925)",
    )
    parser.add_argument(
        "--time-block",
        type=int,
        default=TIME_BLOCK_FALLBACK,
        help="Number of timesteps to process per block.",
    )
    parser.add_argument(
        "--no-lon-half-roll",
        action="store_true",
        help="Disable half-longitude roll.",
    )
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    in_path = Path(args.input)
    if not in_path.is_absolute():
        in_path = (script_dir / in_path).resolve()
    out_dir_base = Path(args.out_dir_base)
    if not out_dir_base.is_absolute():
        out_dir_base = (script_dir / out_dir_base).resolve()

    levels_hpa = parse_levels(args.levels)
    do_lon_half_roll = not args.no_lon_half_roll

    with h5py.File(in_path, "r") as f:
        if VAR_NAME not in f:
            raise KeyError(f"Variable '{VAR_NAME}' not found in input file")
        if "pressure_level" not in f:
            raise KeyError("Coordinate 'pressure_level' not found in input file")
        if "valid_time" not in f:
            raise KeyError("Coordinate 'valid_time' not found in input file")

        levels = np.array(f["pressure_level"][:], dtype=np.float64)
        times = np.array(f["valid_time"][:], dtype=np.int64)

        print("IN_PATH:", str(in_path))
        print("OUT_DIR_BASE:", str(out_dir_base))
        print("levels_hpa:", levels_hpa)
        print("TIME_BLOCK:", args.time_block)
        print("DO_LON_HALF_ROLL:", do_lon_half_roll)
        print(f"{VAR_NAME} shape:", f[VAR_NAME].shape)

        ranges_by_hpa = {}
        for pressure_hpa in levels_hpa:
            data_min, data_max = process_level(
                f=f,
                out_dir_base=str(out_dir_base),
                pressure_hpa=pressure_hpa,
                levels=levels,
                times=times,
                time_block=args.time_block,
                do_lon_half_roll=do_lon_half_roll,
            )
            ranges_by_hpa[pressure_hpa] = (data_min, data_max)

        write_ranges_json(str(out_dir_base), ranges_by_hpa)

    print("All exports complete.")


if __name__ == "__main__":
    main()
