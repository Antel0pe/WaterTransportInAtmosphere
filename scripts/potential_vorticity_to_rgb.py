import argparse
import os

import h5py
import imageio.v2 as imageio
import numpy as np
from tqdm import tqdm

TIME_BLOCK_FALLBACK = 24


def ensure_level_index(level_values, target_hpa):
    lv = np.asarray(level_values, dtype=np.float64)
    if lv.size == 0:
        raise ValueError("Level coordinate is empty")

    med = float(np.median(lv))
    values_hpa = lv / 100.0 if med > 2000.0 else lv

    idx = int(np.argmin(np.abs(values_hpa - float(target_hpa))))
    picked_hpa = float(values_hpa[idx])
    return idx, picked_hpa


def default_pv_range_for_level_hpa(level_hpa):
    level_hpa = float(level_hpa)
    if level_hpa <= 300:
        return -2e-6, 2.4e-5
    if level_hpa <= 700:
        return -1e-6, 1.2e-5
    return -2e-7, 4e-6


def to_u8(x, pv_min, pv_max):
    scale = 255.0 / (pv_max - pv_min)
    y = (x - pv_min) * scale
    y = np.clip(y, 0.0, 255.0)
    return y.astype(np.uint8)


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
    pv_min, pv_max = default_pv_range_for_level_hpa(pressure_hpa)

    out_dir = os.path.join(out_dir_base, f"{int(pressure_hpa)}")
    os.makedirs(out_dir, exist_ok=True)

    pv_var = f["pv"]
    n_times = pv_var.shape[0]
    half = pv_var.shape[-1] // 2

    print(f"\n=== processing pressure={pressure_hpa} hPa ===")
    print("OUT_DIR:", out_dir)
    print("picked level in file:", picked_hpa, "hPa")
    print("display scaling (SI units):", {"min": pv_min, "max": pv_max})

    for t0 in tqdm(range(0, n_times, time_block), desc=f"{int(pressure_hpa)} hPa blocks"):
        t1 = min(t0 + time_block, n_times)

        pv_block = np.array(pv_var[t0:t1, idx, :, :], dtype=np.float32)

        if do_lon_half_roll:
            pv_block = np.roll(pv_block, shift=-half, axis=2)

        r = to_u8(pv_block, pv_min, pv_max)
        g = np.zeros_like(r, dtype=np.uint8)
        b = np.zeros_like(r, dtype=np.uint8)
        rgb_block = np.stack([r, g, b], axis=-1)

        for j in range(t1 - t0):
            ti = t0 + j
            ts_str = make_timestamp_str(times[ti])
            out_path = os.path.join(out_dir, f"{ts_str}.png")
            imageio.imwrite(out_path, rgb_block[j])


def main():
    parser = argparse.ArgumentParser(
        description="Export ERA5 potential vorticity to PNG RGB frames by pressure level."
    )
    parser.add_argument(
        "--input",
        default="../data/era5_2021-nov_250-500-925_uv_pv_gph.nc",
        help="Input netCDF path",
    )
    parser.add_argument(
        "--out-dir-base",
        default="../public/potential-vorticity-rg",
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

    levels_hpa = parse_levels(args.levels)
    do_lon_half_roll = not args.no_lon_half_roll

    with h5py.File(args.input, "r") as f:
        if "pv" not in f:
            raise KeyError("Variable 'pv' not found in input file")
        if "pressure_level" not in f:
            raise KeyError("Coordinate 'pressure_level' not found in input file")
        if "valid_time" not in f:
            raise KeyError("Coordinate 'valid_time' not found in input file")

        levels = np.array(f["pressure_level"][:], dtype=np.float64)
        times = np.array(f["valid_time"][:], dtype=np.int64)

        print("IN_PATH:", args.input)
        print("OUT_DIR_BASE:", args.out_dir_base)
        print("levels_hpa:", levels_hpa)
        print("TIME_BLOCK:", args.time_block)
        print("DO_LON_HALF_ROLL:", do_lon_half_roll)
        print("pv shape:", f["pv"].shape)

        for pressure_hpa in levels_hpa:
            process_level(
                f=f,
                out_dir_base=args.out_dir_base,
                pressure_hpa=pressure_hpa,
                levels=levels,
                times=times,
                time_block=args.time_block,
                do_lon_half_roll=do_lon_half_roll,
            )


if __name__ == "__main__":
    main()
