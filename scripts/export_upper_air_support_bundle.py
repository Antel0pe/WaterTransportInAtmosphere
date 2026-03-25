#!/usr/bin/env python3
"""Export hourly upper-air support frames for the explainable layer."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import xarray as xr

try:
    from tqdm.auto import tqdm
except ImportError:  # pragma: no cover - convenience fallback for thin envs
    def tqdm(iterable=None, **_: Any):
        return iterable


def _fmt_utc(ts: Any) -> str:
    stamp = pd.Timestamp(ts)
    if stamp.tzinfo is None:
        stamp = stamp.tz_localize("UTC")
    else:
        stamp = stamp.tz_convert("UTC")
    return stamp.strftime("%Y-%m-%dT%H:%M:%SZ")


def _hour_key(ts: Any) -> str:
    stamp = pd.Timestamp(ts).round("h")
    return stamp.strftime("%Y-%m-%dT%H:00")


def _frame_filename(ts: Any) -> str:
    return f"{_hour_key(ts).replace(':', '-')}.json"


def _lat_slice_for_dataset(
    ds: xr.Dataset | xr.DataArray, lat_min: float, lat_max: float
) -> slice:
    lat0 = float(ds["latitude"].values[0])
    lat1 = float(ds["latitude"].values[-1])
    return slice(lat_max, lat_min) if lat0 > lat1 else slice(lat_min, lat_max)


def _hemisphere_subset_bounds(
    *,
    start_lat: float,
    start_lon_360: float,
    ds_lat_min: float = -89.75,
    ds_lat_max: float = 89.75,
    ds_lon_min: float = 0.0,
    ds_lon_max: float = 359.75,
) -> tuple[float, float, float, float]:
    if float(start_lat) >= 0.0:
        lat_min = max(0.0, float(ds_lat_min))
        lat_max = float(ds_lat_max)
    else:
        lat_min = float(ds_lat_min)
        lat_max = min(0.0, float(ds_lat_max))

    lon_half_start = 180.0 * np.floor(float(start_lon_360) / 180.0)
    lon_min = max(float(ds_lon_min), lon_half_start)
    lon_max = min(float(ds_lon_max), lon_half_start + 179.75)
    return lat_min, lat_max, lon_min, lon_max


def backward_integrate_trajectory_uv_regional(
    ds: xr.Dataset,
    *,
    start_lat: float,
    start_lon: float,
    start_time: str,
    pressure_level: int,
    hours_back: int,
    substeps: int,
) -> pd.DataFrame:
    """Backward trajectory using a broad regional subset instead of a global slab."""
    ds_uv = ds[["u", "v"]].sel(pressure_level=pressure_level)
    t0 = pd.Timestamp(start_time).to_datetime64()
    t_nearest = ds_uv["valid_time"].sel(valid_time=t0, method="nearest").values

    start_lon_360 = float(start_lon) % 360.0
    lat_min, lat_max, lon_min, lon_max = _hemisphere_subset_bounds(
        start_lat=float(start_lat),
        start_lon_360=start_lon_360,
        ds_lat_min=float(np.nanmin(np.asarray(ds_uv["latitude"].values, dtype=float))),
        ds_lat_max=float(np.nanmax(np.asarray(ds_uv["latitude"].values, dtype=float))),
        ds_lon_min=float(np.nanmin(np.asarray(ds_uv["longitude"].values, dtype=float))),
        ds_lon_max=float(np.nanmax(np.asarray(ds_uv["longitude"].values, dtype=float))),
    )
    window_start = np.datetime64(t_nearest) - np.timedelta64(hours_back + 2, "h")

    ds_uv = (
        ds_uv.sel(
            valid_time=slice(window_start, np.datetime64(t_nearest)),
            latitude=_lat_slice_for_dataset(ds_uv, lat_min, lat_max),
            longitude=slice(lon_min, lon_max),
        )
        .load()
    )

    times = pd.to_datetime(ds_uv["valid_time"].values)
    lat = float(start_lat)
    lon = start_lon_360

    records = [
        {
            "step_hour": 0,
            "valid_time": pd.Timestamp(t_nearest),
            "latitude": lat,
            "longitude": lon,
        }
    ]

    dt_hour_s = 3600.0
    dt_sub_s = dt_hour_s / substeps
    earth_radius_m = 6_371_000.0

    t_curr = np.datetime64(t_nearest)
    t_min = np.datetime64(times.min().to_datetime64())

    for h in tqdm(range(1, hours_back + 1), desc="Backward integration", unit="h"):
        if t_curr - np.timedelta64(1, "h") < t_min:
            break

        lat_step = lat
        lon_step = lon

        for s in range(substeps):
            sec_back = (s + 0.5) * dt_sub_s
            t_mid = t_curr - np.timedelta64(int(sec_back), "s")

            uv = ds_uv.interp(
                valid_time=xr.DataArray([t_mid], dims="point"),
                latitude=xr.DataArray([lat_step], dims="point"),
                longitude=xr.DataArray([lon_step], dims="point"),
                kwargs={"bounds_error": False, "fill_value": None},
            )

            u_ms = float(np.asarray(uv["u"].values).reshape(-1)[0])
            v_ms = float(np.asarray(uv["v"].values).reshape(-1)[0])
            if not (np.isfinite(u_ms) and np.isfinite(v_ms)):
                break

            dlat_deg = np.degrees((v_ms * dt_sub_s) / earth_radius_m)
            coslat = max(np.cos(np.radians(lat_step)), 1e-6)
            dlon_deg = np.degrees((u_ms * dt_sub_s) / (earth_radius_m * coslat))

            lat_step = float(np.clip(lat_step - dlat_deg, -89.75, 89.75))
            lon_step = float((lon_step - dlon_deg) % 360.0)

        t_curr = t_curr - np.timedelta64(1, "h")
        lat = lat_step
        lon = lon_step

        records.append(
            {
                "step_hour": h,
                "valid_time": pd.Timestamp(t_curr),
                "latitude": lat,
                "longitude": lon,
            }
        )

    return pd.DataFrame(records)


def _finite_percentile(values: list[np.ndarray], q: float, fallback: float) -> float:
    merged = np.concatenate(values) if values else np.array([], dtype=float)
    merged = merged[np.isfinite(merged)]
    if merged.size == 0:
        return float(fallback)
    return float(np.percentile(merged, q))


def _safe_positive(values: np.ndarray) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    arr = arr[np.isfinite(arr)]
    return arr[arr > 0.0]


def build_export_payload(
    *,
    era5_uvz_ds: xr.Dataset,
    upper_air_ds: xr.Dataset,
    start_lat: float,
    start_lon: float,
    start_time: str,
    trajectory_pressure_level: int,
    vertical_velocity_level: int,
    divergence_level: int,
    wind_level: int,
    hours_back: int,
    substeps: int,
    field_half_span_lat_deg: float,
    field_half_span_lon_deg: float,
    sample_spacing_deg: float,
    box_size: int,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    if box_size < 1 or box_size % 2 == 0:
        raise ValueError("box_size must be a positive odd integer")

    trajectory_df = backward_integrate_trajectory_uv_regional(
        era5_uvz_ds,
        start_lat=start_lat,
        start_lon=start_lon,
        start_time=start_time,
        pressure_level=trajectory_pressure_level,
        hours_back=hours_back,
        substeps=substeps,
    )

    trajectory = trajectory_df.copy().sort_values("step_hour").reset_index(drop=True)
    trajectory["valid_time"] = pd.to_datetime(trajectory["valid_time"])
    trajectory["longitude_360"] = trajectory["longitude"] % 360.0

    time_pad = np.timedelta64(1, "h")
    lat_pad = float(field_half_span_lat_deg) + 1.0
    lon_pad = float(field_half_span_lon_deg) + 1.0

    time_min = np.datetime64(trajectory["valid_time"].min()) - time_pad
    time_max = np.datetime64(trajectory["valid_time"].max()) + time_pad
    lat_min = float(trajectory["latitude"].min()) - lat_pad
    lat_max = float(trajectory["latitude"].max()) + lat_pad
    lon_min = max(0.0, float(trajectory["longitude_360"].min()) - lon_pad)
    lon_max = min(359.75, float(trajectory["longitude_360"].max()) + lon_pad)

    needed_upper_levels = sorted({int(vertical_velocity_level), int(divergence_level)})
    needed_wind_levels = sorted({int(wind_level)})

    upper_air_subset = (
        upper_air_ds[["d", "w"]]
        .sel(
            pressure_level=needed_upper_levels,
            valid_time=slice(time_min, time_max),
            latitude=_lat_slice_for_dataset(upper_air_ds, lat_min, lat_max),
            longitude=slice(lon_min, lon_max),
        )
        .load()
    )
    wind_subset = (
        era5_uvz_ds[["u", "v"]]
        .sel(
            pressure_level=needed_wind_levels,
            valid_time=slice(time_min, time_max),
            latitude=_lat_slice_for_dataset(era5_uvz_ds, lat_min, lat_max),
            longitude=slice(lon_min, lon_max),
        )
        .load()
    )

    frame_times = pd.to_datetime(trajectory["valid_time"]).dt.round("h")
    frame_times_da = xr.DataArray(frame_times.to_numpy(dtype="datetime64[ns]"), dims="frame")

    upper_air_frames = upper_air_subset.sel(valid_time=frame_times_da, method="nearest").rolling(
        latitude=box_size,
        longitude=box_size,
        center=True,
        min_periods=1,
    ).mean()
    wind_frames = wind_subset.sel(valid_time=frame_times_da, method="nearest").rolling(
        latitude=box_size,
        longitude=box_size,
        center=True,
        min_periods=1,
    ).mean()

    lat_offsets = np.arange(
        -float(field_half_span_lat_deg),
        float(field_half_span_lat_deg) + 0.5 * float(sample_spacing_deg),
        float(sample_spacing_deg),
        dtype=float,
    )
    lon_offsets = np.arange(
        -float(field_half_span_lon_deg),
        float(field_half_span_lon_deg) + 0.5 * float(sample_spacing_deg),
        float(sample_spacing_deg),
        dtype=float,
    )

    frames_by_hour: dict[str, dict[str, Any]] = {}
    ascent_values_all: list[np.ndarray] = []
    divergence_values_all: list[np.ndarray] = []
    wind_values_all: list[np.ndarray] = []

    for frame_index, row in enumerate(
        tqdm(
            trajectory.itertuples(index=False),
            total=len(trajectory),
            desc="Building upper-air support bundle",
            unit="frame",
        )
    ):
        valid_time = pd.Timestamp(row.valid_time).round("h")
        lat0 = float(row.latitude)
        lon0 = float(row.longitude_360)

        local_lats = np.clip(lat0 + lat_offsets, -89.75, 89.75)
        local_lons_unwrapped = lon0 + lon_offsets
        local_lons_mod = local_lons_unwrapped % 360.0

        lat_da = xr.DataArray(local_lats, dims="latitude")
        lon_da = xr.DataArray(local_lons_mod, dims="longitude")

        w_grid = np.asarray(
            upper_air_frames["w"]
            .sel(pressure_level=float(vertical_velocity_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        )
        d_grid = np.asarray(
            upper_air_frames["d"]
            .sel(pressure_level=float(divergence_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        )
        u_grid = np.asarray(
            wind_frames["u"]
            .sel(pressure_level=float(wind_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        )
        v_grid = np.asarray(
            wind_frames["v"]
            .sel(pressure_level=float(wind_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        )

        ascent_grid = np.maximum(-w_grid, 0.0)
        divergence_grid = np.maximum(d_grid, 0.0)
        wind_speed_grid = np.hypot(u_grid, v_grid)

        ascent_values_all.append(_safe_positive(ascent_grid))
        divergence_values_all.append(_safe_positive(divergence_grid))
        wind_values_all.append(_safe_positive(wind_speed_grid))

        samples: list[dict[str, Any]] = []
        for lat_idx, lat_val in enumerate(local_lats):
            for lon_idx, lon_val_unwrapped in enumerate(local_lons_unwrapped):
                ascent_val = float(ascent_grid[lat_idx, lon_idx])
                divergence_val = float(divergence_grid[lat_idx, lon_idx])
                u_val = float(u_grid[lat_idx, lon_idx])
                v_val = float(v_grid[lat_idx, lon_idx])
                wind_val = float(wind_speed_grid[lat_idx, lon_idx])
                if not (
                    np.isfinite(ascent_val)
                    and np.isfinite(divergence_val)
                    and np.isfinite(u_val)
                    and np.isfinite(v_val)
                    and np.isfinite(wind_val)
                ):
                    continue
                samples.append(
                    {
                        "latitude": round(float(lat_val), 4),
                        "longitude": round(float(lon_val_unwrapped), 4),
                        "longitude_360": round(float(lon_val_unwrapped) % 360.0, 4),
                        "ascent_pa_s": round(ascent_val, 8),
                        "divergence_s1": round(divergence_val, 10),
                        "u_wind_ms": round(u_val, 4),
                        "v_wind_ms": round(v_val, 4),
                        "wind_speed_ms": round(wind_val, 4),
                    }
                )

        hour_key = _hour_key(valid_time)
        frames_by_hour[hour_key] = {
            "step_hour": int(row.step_hour),
            "valid_time": _fmt_utc(valid_time),
            "hour_key": hour_key,
            "latitude": round(lat0, 5),
            "longitude": round(float(row.longitude), 5),
            "longitude_360": round(lon0, 5),
            "grid_latitudes": [round(float(x), 4) for x in local_lats],
            "grid_longitudes": [round(float(x), 4) for x in local_lons_unwrapped],
            "samples": samples,
        }

    ascent_p75 = _finite_percentile(ascent_values_all, 75.0, 0.0)
    ascent_p90 = _finite_percentile(ascent_values_all, 90.0, max(ascent_p75, 1e-6))
    ascent_p95 = _finite_percentile(ascent_values_all, 95.0, max(ascent_p90, 1e-6))
    divergence_p75 = _finite_percentile(divergence_values_all, 75.0, 0.0)
    divergence_p90 = _finite_percentile(
        divergence_values_all, 90.0, max(divergence_p75, 1e-9)
    )
    divergence_p95 = _finite_percentile(
        divergence_values_all, 95.0, max(divergence_p90, 1e-9)
    )
    wind_p75 = _finite_percentile(wind_values_all, 75.0, 0.0)
    wind_p90 = _finite_percentile(wind_values_all, 90.0, max(wind_p75, 1e-6))
    wind_p95 = _finite_percentile(wind_values_all, 95.0, max(wind_p90, 1e-6))

    manifest = {
        "metadata": {
            "target_name": "Vancouver",
            "start_lat": float(start_lat),
            "start_lon": float(start_lon),
            "start_lon_360": float(start_lon) % 360.0,
            "requested_start_time": str(start_time),
            "resolved_start_time": _fmt_utc(trajectory["valid_time"].iloc[0]),
            "trajectory_pressure_level_hpa": int(trajectory_pressure_level),
            "vertical_velocity_level_hpa": int(vertical_velocity_level),
            "divergence_level_hpa": int(divergence_level),
            "wind_level_hpa": int(wind_level),
            "hours_back_requested": int(hours_back),
            "hours_back_actual": int(trajectory["step_hour"].max()),
            "substeps": int(substeps),
            "field_half_span_lat_deg": float(field_half_span_lat_deg),
            "field_half_span_lon_deg": float(field_half_span_lon_deg),
            "sample_spacing_deg": float(sample_spacing_deg),
            "box_size": int(box_size),
            "source_grid_spacing_deg": 0.25,
            "generated_at_utc": _fmt_utc(pd.Timestamp.now(tz="UTC")),
        },
        "summary": {
            "point_count": int(len(trajectory)),
            "frame_count": int(len(frames_by_hour)),
            "sample_count_per_frame": int(len(next(iter(frames_by_hour.values()))["samples"]))
            if frames_by_hour
            else 0,
            "ascent_p75_pa_s": round(ascent_p75, 8),
            "ascent_p90_pa_s": round(ascent_p90, 8),
            "ascent_p95_pa_s": round(ascent_p95, 8),
            "ascent_max_pa_s": round(
                _finite_percentile(ascent_values_all, 100.0, max(ascent_p95, 1e-6)),
                8,
            ),
            "divergence_p75_s1": round(divergence_p75, 10),
            "divergence_p90_s1": round(divergence_p90, 10),
            "divergence_p95_s1": round(divergence_p95, 10),
            "divergence_max_s1": round(
                _finite_percentile(
                    divergence_values_all, 100.0, max(divergence_p95, 1e-9)
                ),
                10,
            ),
            "wind_p75_ms": round(wind_p75, 4),
            "wind_p90_ms": round(wind_p90, 4),
            "wind_p95_ms": round(wind_p95, 4),
            "wind_max_ms": round(
                _finite_percentile(wind_values_all, 100.0, max(wind_p95, 1e-6)),
                4,
            ),
        },
        "points": [
            {
                "step_hour": int(row.step_hour),
                "valid_time": _fmt_utc(row.valid_time),
                "hour_key": _hour_key(row.valid_time),
                "latitude": round(float(row.latitude), 5),
                "longitude": round(float(row.longitude), 5),
                "longitude_360": round(float(row.longitude_360), 5),
                "frame_file": _frame_filename(row.valid_time),
            }
            for row in trajectory.itertuples(index=False)
        ],
    }
    manifest["points_by_hour"] = {
        point["hour_key"]: point for point in manifest["points"]
    }
    manifest["available_hour_keys"] = [point["hour_key"] for point in manifest["points"]]

    return manifest, frames_by_hour


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export the hourly upper-air support bundle."
    )
    parser.add_argument(
        "--era5-uvz-path",
        type=Path,
        default=Path("data/era5_2021-nov_250-500-925_uv_pv_gph.nc"),
        help="Path to ERA5 u/v/gph NetCDF.",
    )
    parser.add_argument(
        "--upper-air-path",
        type=Path,
        default=Path("data/era5_2021-nov_250-500-925_divergence_vertical_velocity.nc"),
        help="Path to ERA5 divergence / vertical velocity NetCDF.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("public/upper_air_support"),
        help="Output directory for manifest + hourly frames.",
    )
    parser.add_argument("--start-lat", type=float, default=49.28)
    parser.add_argument("--start-lon", type=float, default=-123.12)
    parser.add_argument("--start-time", type=str, default="2021-11-12T15:00:00")
    parser.add_argument("--trajectory-pressure-level", type=int, default=925)
    parser.add_argument("--vertical-velocity-level", type=int, default=500)
    parser.add_argument("--divergence-level", type=int, default=250)
    parser.add_argument("--wind-level", type=int, default=250)
    parser.add_argument("--hours-back", type=int, default=100)
    parser.add_argument("--substeps", type=int, default=4)
    parser.add_argument("--field-half-span-lat-deg", type=float, default=14.0)
    parser.add_argument("--field-half-span-lon-deg", type=float, default=22.0)
    parser.add_argument("--sample-spacing-deg", type=float, default=1.0)
    parser.add_argument("--box-size", type=int, default=25)
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    with xr.open_dataset(args.era5_uvz_path) as era5_uvz_ds:
        with xr.open_dataset(args.upper_air_path) as upper_air_ds:
            manifest, frames_by_hour = build_export_payload(
                era5_uvz_ds=era5_uvz_ds,
                upper_air_ds=upper_air_ds,
                start_lat=args.start_lat,
                start_lon=args.start_lon,
                start_time=args.start_time,
                trajectory_pressure_level=args.trajectory_pressure_level,
                vertical_velocity_level=args.vertical_velocity_level,
                divergence_level=args.divergence_level,
                wind_level=args.wind_level,
                hours_back=args.hours_back,
                substeps=args.substeps,
                field_half_span_lat_deg=args.field_half_span_lat_deg,
                field_half_span_lon_deg=args.field_half_span_lon_deg,
                sample_spacing_deg=args.sample_spacing_deg,
                box_size=args.box_size,
            )

    output_dir = args.output_dir
    frames_dir = output_dir / "frames"
    output_dir.mkdir(parents=True, exist_ok=True)
    frames_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = output_dir / "current.json"
    with manifest_path.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False)

    for hour_key, frame in frames_by_hour.items():
        frame_path = frames_dir / _frame_filename(hour_key)
        with frame_path.open("w", encoding="utf-8") as f:
            json.dump(frame, f, ensure_ascii=False)

    print(f"Wrote manifest: {manifest_path}")
    print(f"Wrote frames: {len(frames_by_hour)}")
    if manifest["points"]:
        print(
            "Range:",
            manifest["points"][-1]["valid_time"],
            "->",
            manifest["points"][0]["valid_time"],
        )


if __name__ == "__main__":
    main()
