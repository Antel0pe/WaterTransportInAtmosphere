#!/usr/bin/env python3
"""Export ERA5 divergence and vertical velocity to per-hour RGB PNG files.

This script reads:
  data/era5_2021-nov_250-500-925_divergence_vertical_velocity.nc

And writes:
  public/divergence-rg/<pressure>/<timestamp>.png
  public/vertical-velocity-rg/<pressure>/<timestamp>.png

Encoding:
  - R channel: linearly scaled data across the full signed range per variable+pressure.
  - G/B channels: zero.
  - Longitude is half-rolled by default to match globe layer conventions.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import h5py
import imageio.v2 as imageio
import numpy as np
from tqdm import tqdm

TIME_BLOCK_FALLBACK = 24


@dataclass(frozen=True)
class VariableConfig:
    var_name: str
    out_folder_name: str
    range_filename: str


VAR_CONFIGS = (
    VariableConfig(
        var_name="d",
        out_folder_name="divergence-rg",
        range_filename="divergence_ranges.json",
    ),
    VariableConfig(
        var_name="w",
        out_folder_name="vertical-velocity-rg",
        range_filename="vertical_velocity_ranges.json",
    ),
)


def parse_levels(raw_levels: list[str]) -> list[int]:
    out: list[int] = []
    for raw in raw_levels:
        p = int(raw)
        if p <= 0:
            raise ValueError(f"Invalid pressure level: {raw}")
        out.append(p)
    return out


def ensure_level_index(level_values: np.ndarray, target_hpa: int) -> tuple[int, float]:
    lv = np.asarray(level_values, dtype=np.float64)
    if lv.size == 0:
        raise ValueError("Level coordinate is empty")

    med = float(np.median(lv))
    values_hpa = lv / 100.0 if med > 2000.0 else lv

    idx = int(np.argmin(np.abs(values_hpa - float(target_hpa))))
    picked_hpa = float(values_hpa[idx])
    return idx, picked_hpa


def make_timestamp_str(unix_seconds: np.int64) -> str:
    ts64 = np.datetime64(int(unix_seconds), "s")
    return np.datetime_as_string(ts64, unit="s").replace(":", "-")


def to_u8(x: np.ndarray, data_min: float, data_max: float) -> np.ndarray:
    denom = data_max - data_min
    if not np.isfinite(denom) or denom <= 0.0:
        return np.zeros_like(x, dtype=np.uint8)
    y = (x - data_min) * (255.0 / denom)
    y = np.clip(y, 0.0, 255.0)
    return y.astype(np.uint8)


def compute_ranges_for_var(
    f: h5py.File,
    var_name: str,
    level_idx_by_hpa: dict[int, int],
    time_block: int,
    do_lon_half_roll: bool,
) -> dict[int, tuple[float, float]]:
    var = f[var_name]
    n_times = int(var.shape[0])
    half = int(var.shape[-1] // 2)

    mins: dict[int, float] = {p: float("inf") for p in level_idx_by_hpa}
    maxs: dict[int, float] = {p: float("-inf") for p in level_idx_by_hpa}

    for pressure_hpa, lev_idx in level_idx_by_hpa.items():
        for t0 in tqdm(
            range(0, n_times, time_block),
            desc=f"{var_name} {pressure_hpa}hPa range",
        ):
            t1 = min(t0 + time_block, n_times)
            blk = np.asarray(var[t0:t1, lev_idx, :, :], dtype=np.float32)
            if do_lon_half_roll:
                blk = np.roll(blk, shift=-half, axis=2)

            bmin = float(np.nanmin(blk))
            bmax = float(np.nanmax(blk))

            if bmin < mins[pressure_hpa]:
                mins[pressure_hpa] = bmin
            if bmax > maxs[pressure_hpa]:
                maxs[pressure_hpa] = bmax

    return {p: (mins[p], maxs[p]) for p in level_idx_by_hpa}


def write_frames_for_var(
    f: h5py.File,
    var_name: str,
    out_dir_base: Path,
    level_idx_by_hpa: dict[int, int],
    ranges_by_hpa: dict[int, tuple[float, float]],
    times: np.ndarray,
    time_block: int,
    do_lon_half_roll: bool,
) -> None:
    var = f[var_name]
    n_times = int(var.shape[0])
    half = int(var.shape[-1] // 2)

    for pressure_hpa, lev_idx in level_idx_by_hpa.items():
        p_out_dir = out_dir_base / f"{pressure_hpa}"
        p_out_dir.mkdir(parents=True, exist_ok=True)

        data_min, data_max = ranges_by_hpa[pressure_hpa]
        print(
            f"[{var_name}] pressure={pressure_hpa}hPa | data range: min={data_min} max={data_max}"
        )

        for t0 in tqdm(
            range(0, n_times, time_block),
            desc=f"{var_name} {pressure_hpa}hPa frames",
        ):
            t1 = min(t0 + time_block, n_times)
            blk = np.asarray(var[t0:t1, lev_idx, :, :], dtype=np.float32)

            if do_lon_half_roll:
                blk = np.roll(blk, shift=-half, axis=2)

            r = to_u8(blk, data_min, data_max)
            g = np.zeros_like(r, dtype=np.uint8)
            b = np.zeros_like(r, dtype=np.uint8)
            rgb = np.stack([r, g, b], axis=-1)

            for j in range(t1 - t0):
                ti = t0 + j
                ts_str = make_timestamp_str(times[ti])
                out_path = p_out_dir / f"{ts_str}.png"
                imageio.imwrite(out_path, rgb[j])


def write_ranges_json(
    out_dir_base: Path,
    range_filename: str,
    level_idx_by_hpa: dict[int, int],
    ranges_by_hpa: dict[int, tuple[float, float]],
) -> None:
    payload = {
        "levels_hpa": sorted(level_idx_by_hpa.keys()),
        "ranges": {
            str(p): {
                "min": ranges_by_hpa[p][0],
                "max": ranges_by_hpa[p][1],
            }
            for p in sorted(level_idx_by_hpa.keys())
        },
    }
    out_path = out_dir_base / range_filename
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export ERA5 divergence + vertical velocity to PNG RGB per pressure level."
    )
    parser.add_argument(
        "--input",
        default="../data/era5_2021-nov_250-500-925_divergence_vertical_velocity.nc",
        help="Input netCDF path",
    )
    parser.add_argument(
        "--out-public-dir",
        default="../public",
        help="Output public directory root",
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
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    levels_hpa = parse_levels(args.levels)
    do_lon_half_roll = not args.no_lon_half_roll
    script_dir = Path(__file__).resolve().parent
    in_path = Path(args.input)
    if not in_path.is_absolute():
        in_path = (script_dir / in_path).resolve()
    out_public_dir = Path(args.out_public_dir)
    if not out_public_dir.is_absolute():
        out_public_dir = (script_dir / out_public_dir).resolve()

    with h5py.File(in_path, "r") as f:
        required_coords = {"pressure_level", "valid_time"}
        missing_coords = sorted(required_coords - set(f.keys()))
        if missing_coords:
            raise KeyError(f"Missing required coordinate(s): {missing_coords}")

        levels = np.asarray(f["pressure_level"][:], dtype=np.float64)
        times = np.asarray(f["valid_time"][:], dtype=np.int64)

        print("IN_PATH:", str(in_path))
        print("OUT_PUBLIC_DIR:", str(out_public_dir))
        print("levels_hpa:", levels_hpa)
        print("TIME_BLOCK:", args.time_block)
        print("DO_LON_HALF_ROLL:", do_lon_half_roll)
        print("time_count:", int(times.size))

        level_idx_by_hpa: dict[int, int] = {}
        picked_levels_hpa: dict[int, float] = {}
        for p in levels_hpa:
            idx, picked = ensure_level_index(levels, p)
            level_idx_by_hpa[p] = idx
            picked_levels_hpa[p] = picked
        print("picked_levels_hpa:", picked_levels_hpa)

        for cfg in VAR_CONFIGS:
            if cfg.var_name not in f:
                raise KeyError(
                    f"Variable '{cfg.var_name}' not found in input file. Available: {list(f.keys())}"
                )

            out_dir_base = out_public_dir / cfg.out_folder_name
            out_dir_base.mkdir(parents=True, exist_ok=True)

            print(f"\n=== {cfg.var_name} -> {out_dir_base} ===")
            ranges_by_hpa = compute_ranges_for_var(
                f=f,
                var_name=cfg.var_name,
                level_idx_by_hpa=level_idx_by_hpa,
                time_block=args.time_block,
                do_lon_half_roll=do_lon_half_roll,
            )
            write_ranges_json(
                out_dir_base=out_dir_base,
                range_filename=cfg.range_filename,
                level_idx_by_hpa=level_idx_by_hpa,
                ranges_by_hpa=ranges_by_hpa,
            )
            write_frames_for_var(
                f=f,
                var_name=cfg.var_name,
                out_dir_base=out_dir_base,
                level_idx_by_hpa=level_idx_by_hpa,
                ranges_by_hpa=ranges_by_hpa,
                times=times,
                time_block=args.time_block,
                do_lon_half_roll=do_lon_half_roll,
            )

    print("All exports complete.")


if __name__ == "__main__":
    main()
