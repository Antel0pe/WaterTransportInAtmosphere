#!/usr/bin/env python3
"""
Generate a single wind UV RGB PNG from the NetCDF source and write it to stdout.

This mirrors the encode logic used in scripts/wind_to_rgb.py:
  - R channel: U wind
  - G channel: V wind
  - B channel: 0
  - uint8 scale from configurable uv_min/uv_max
"""

from __future__ import annotations

import argparse
import io
import re
import sys
from pathlib import Path

import numpy as np
import xarray as xr
from PIL import Image


DEFAULT_IN_PATH = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "era5_2021-nov_250-500-925_uv_pv_gph.nc"
)


def pick_time_coord(ds: xr.Dataset) -> str:
    for name in ("valid_time", "time", "datetime", "date"):
        if name in ds.coords or name in ds.dims:
            return name
    raise KeyError("Could not find a time coordinate.")


def pick_lon_name(ds: xr.Dataset) -> str:
    for name in ("longitude", "lon", "LONGITUDE", "x"):
        if name in ds.coords or name in ds.dims:
            return name
    raise KeyError("Could not find a longitude coordinate.")


def pick_level_name(ds: xr.Dataset) -> str:
    for name in ("pressure_level", "level", "isobaricInhPa", "plev", "lev"):
        if name in ds.coords or name in ds.dims:
            return name
    raise KeyError("Could not find a pressure level coordinate.")


def pick_u_var(ds: xr.Dataset) -> str:
    for name in ("u", "u_component_of_wind", "UGRD", "U", "ua"):
        if name in ds.data_vars:
            return name
    raise KeyError("Could not find a u-wind variable.")


def pick_v_var(ds: xr.Dataset) -> str:
    for name in ("v", "v_component_of_wind", "VGRD", "V", "va"):
        if name in ds.data_vars:
            return name
    raise KeyError("Could not find a v-wind variable.")


def level_values_in_hpa(level_vals: np.ndarray) -> tuple[np.ndarray, str]:
    lv = np.asarray(level_vals, dtype=np.float64)
    if lv.size == 0:
        raise ValueError("Pressure level coordinate is empty.")
    median_val = float(np.median(lv))
    if median_val > 2000.0:
        return lv / 100.0, "pa"
    return lv, "hpa"


def ensure_level_value(level_vals: np.ndarray, target_hpa: float) -> float:
    vals_hpa, mode = level_values_in_hpa(level_vals)
    idx = int(np.argmin(np.abs(vals_hpa - float(target_hpa))))
    picked_hpa = float(vals_hpa[idx])
    return picked_hpa * 100.0 if mode == "pa" else picked_hpa


def default_uv_range_for_level_hpa(level_hpa: float) -> tuple[float, float]:
    level_hpa = float(level_hpa)
    if level_hpa <= 300.0:
        return -100.0, 100.0
    if level_hpa <= 600.0:
        return -80.0, 80.0
    return -40.0, 40.0


def to_u8(array: np.ndarray, uv_min: float, uv_max: float) -> np.ndarray:
    scale = 255.0 / (uv_max - uv_min)
    out = (array - uv_min) * scale
    out = np.clip(out, 0.0, 255.0)
    return out.astype(np.uint8)


TIME_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z)?$")


def parse_time_iso_to_np64(value: str) -> np.datetime64:
    match = TIME_RE.match(value)
    if not match:
        raise ValueError("datehour must look like YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS")

    year = int(match.group(1))
    month = int(match.group(2))
    day = int(match.group(3))
    hour = int(match.group(4))
    minute = int(match.group(5))
    second = int(match.group(6) or 0)

    if not (1 <= month <= 12):
        raise ValueError("Invalid month.")
    if not (1 <= day <= 31):
        raise ValueError("Invalid day.")
    if not (0 <= hour <= 23):
        raise ValueError("Invalid hour.")
    if not (0 <= minute <= 59):
        raise ValueError("Invalid minute.")
    if not (0 <= second <= 59):
        raise ValueError("Invalid second.")

    return np.datetime64(
        f"{year:04d}-{month:02d}-{day:02d}T{hour:02d}:{minute:02d}:{second:02d}", "s"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create a wind UV RGB PNG for one timestamp and level.")
    parser.add_argument("--in-path", default=str(DEFAULT_IN_PATH), help="Path to NetCDF/GRIB-backed file.")
    parser.add_argument("--datehour", required=True, help="Timestamp in UTC.")
    parser.add_argument("--pressure-level", required=True, type=float, help="Pressure level in hPa.")
    parser.add_argument("--uv-min", type=float, default=None, help="Lower decode range (m/s).")
    parser.add_argument("--uv-max", type=float, default=None, help="Upper decode range (m/s).")
    parser.add_argument(
        "--lon-half-roll",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Apply longitude half roll to align 0..360 source with -180..180 output.",
    )
    return parser


def create_png_bytes(
    in_path: Path,
    datehour: str,
    pressure_level_hpa: float,
    uv_min: float | None,
    uv_max: float | None,
    lon_half_roll: bool,
) -> bytes:
    target_time = parse_time_iso_to_np64(datehour)

    try:
        # Prefer h5netcdf to avoid backend shell warnings from netcdf4 in this environment.
        ds = xr.open_dataset(in_path, engine="h5netcdf", chunks="auto")
    except Exception:
        ds = xr.open_dataset(in_path, chunks="auto")
    try:
        t_name = pick_time_coord(ds)
        lon_name = pick_lon_name(ds)
        lev_name = pick_level_name(ds)
        u_name = pick_u_var(ds)
        v_name = pick_v_var(ds)

        times = np.asarray(ds[t_name].values).astype("datetime64[s]")
        idx = np.where(times == target_time)[0]
        if idx.size == 0:
            first = str(times[0]) if times.size else "n/a"
            last = str(times[-1]) if times.size else "n/a"
            raise ValueError(f"Requested time {target_time} not found. Available range: {first} .. {last}")
        time_index = int(idx[0])

        lev_pick = ensure_level_value(np.asarray(ds[lev_name].values), pressure_level_hpa)

        if uv_min is None or uv_max is None:
            default_min, default_max = default_uv_range_for_level_hpa(pressure_level_hpa)
            if uv_min is None:
                uv_min = default_min
            if uv_max is None:
                uv_max = default_max

        if not np.isfinite(uv_min) or not np.isfinite(uv_max):
            raise ValueError("uv_min and uv_max must be finite.")
        if float(uv_max) <= float(uv_min):
            raise ValueError("uv_max must be > uv_min.")

        u_da = ds[u_name].isel({t_name: time_index}).sel({lev_name: lev_pick})
        v_da = ds[v_name].isel({t_name: time_index}).sel({lev_name: lev_pick})

        if lon_half_roll:
            half = ds.sizes[lon_name] // 2
            u_da = u_da.roll({lon_name: -half}, roll_coords=False)
            v_da = v_da.roll({lon_name: -half}, roll_coords=False)

        u_np = np.asarray(u_da.data, dtype=np.float32)
        v_np = np.asarray(v_da.data, dtype=np.float32)

        r = to_u8(u_np, float(uv_min), float(uv_max))
        g = to_u8(v_np, float(uv_min), float(uv_max))
        b = np.zeros_like(r, dtype=np.uint8)

        rgb = np.stack((r, g, b), axis=-1)
        image = Image.fromarray(rgb, mode="RGB")

        out = io.BytesIO()
        image.save(out, format="PNG")
        return out.getvalue()
    finally:
        ds.close()


def main() -> int:
    args = build_parser().parse_args()

    try:
        payload = create_png_bytes(
            in_path=Path(args.in_path),
            datehour=args.datehour,
            pressure_level_hpa=args.pressure_level,
            uv_min=args.uv_min,
            uv_max=args.uv_max,
            lon_half_roll=args.lon_half_roll,
        )
    except Exception as exc:
        print(f"wind_uv_dynamic_png error: {exc}", file=sys.stderr)
        return 1

    sys.stdout.buffer.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
