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


G0 = 9.80665


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


def _depth_below_local_mean(values: np.ndarray) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    if not np.any(np.isfinite(arr)):
        return np.zeros_like(arr, dtype=float)
    mean_val = float(np.nanmean(arr))
    return np.maximum(mean_val - arr, 0.0)


def _positive_anomaly_from_local_median(values: np.ndarray) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    if not np.any(np.isfinite(arr)):
        return np.zeros_like(arr, dtype=float)
    median_val = float(np.nanmedian(arr))
    return np.maximum(arr - median_val, 0.0)


def _feature_point(
    values: np.ndarray,
    local_lats: np.ndarray,
    local_lons_unwrapped: np.ndarray,
    *,
    mode: str,
    positive_only: bool = False,
    value_ndigits: int = 4,
) -> dict[str, float] | None:
    arr = np.asarray(values, dtype=float)
    if arr.ndim != 2 or not np.any(np.isfinite(arr)):
        return None

    work = arr.copy()
    if positive_only:
        work[~np.isfinite(work)] = np.nan
        finite = work[np.isfinite(work)]
        if finite.size == 0 or float(np.nanmax(finite)) <= 0.0:
            return None

    if mode == "max":
        flat_idx = int(np.nanargmax(work))
    elif mode == "min":
        flat_idx = int(np.nanargmin(work))
    else:
        raise ValueError(f"Unsupported feature mode: {mode}")

    lat_idx, lon_idx = np.unravel_index(flat_idx, work.shape)
    value = float(arr[lat_idx, lon_idx])
    if not np.isfinite(value):
        return None

    return {
        "latitude": round(float(local_lats[lat_idx]), 2),
        "longitude": round(float(local_lons_unwrapped[lon_idx]), 2),
        "value": round(value, value_ndigits),
    }


def build_export_payload(
    *,
    era5_uvz_ds: xr.Dataset,
    upper_air_ds: xr.Dataset,
    gph_ds: xr.Dataset,
    humidity_ds: xr.Dataset,
    start_lat: float,
    start_lon: float,
    start_time: str,
    trajectory_pressure_level: int,
    pv_level: int,
    upper_trough_level: int,
    lower_low_level: int,
    vertical_velocity_level: int,
    upper_divergence_level: int,
    lower_convergence_level: int,
    upper_wind_level: int,
    moisture_flux_level: int,
    thickness_upper_level: int,
    thickness_lower_level: int,
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

    needed_upper_levels = sorted(
        {int(vertical_velocity_level), int(upper_divergence_level), int(lower_convergence_level)}
    )
    needed_uvz_levels = sorted(
        {int(pv_level), int(upper_trough_level), int(lower_low_level), int(upper_wind_level)}
    )
    needed_thickness_levels = sorted({int(thickness_upper_level), int(thickness_lower_level)})
    needed_humidity_levels = sorted({int(moisture_flux_level)})

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
    uvz_subset = (
        era5_uvz_ds[["pv", "u", "v", "z"]]
        .sel(
            pressure_level=needed_uvz_levels,
            valid_time=slice(time_min, time_max),
            latitude=_lat_slice_for_dataset(era5_uvz_ds, lat_min, lat_max),
            longitude=slice(lon_min, lon_max),
        )
        .load()
    )
    gph_subset = (
        gph_ds[["z"]]
        .sel(
            pressure_level=needed_thickness_levels,
            valid_time=slice(time_min, time_max),
            latitude=_lat_slice_for_dataset(gph_ds, lat_min, lat_max),
            longitude=slice(lon_min, lon_max),
        )
        .load()
    )
    humidity_subset = (
        humidity_ds[["q", "u", "v"]]
        .sel(
            pressure_level=needed_humidity_levels,
            valid_time=slice(time_min, time_max),
            latitude=_lat_slice_for_dataset(humidity_ds, lat_min, lat_max),
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
    uvz_frames = uvz_subset.sel(valid_time=frame_times_da, method="nearest").rolling(
        latitude=box_size,
        longitude=box_size,
        center=True,
        min_periods=1,
    ).mean()
    gph_frames = gph_subset.sel(valid_time=frame_times_da, method="nearest").rolling(
        latitude=box_size,
        longitude=box_size,
        center=True,
        min_periods=1,
    ).mean()
    humidity_frames = humidity_subset.sel(valid_time=frame_times_da, method="nearest").rolling(
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
    pv_values_all: list[np.ndarray] = []
    trough_depth_values_all: list[np.ndarray] = []
    low925_depth_values_all: list[np.ndarray] = []
    ascent_values_all: list[np.ndarray] = []
    divergence250_values_all: list[np.ndarray] = []
    convergence925_values_all: list[np.ndarray] = []
    thickness_deficit_values_all: list[np.ndarray] = []
    jet250_values_all: list[np.ndarray] = []
    moisture_flux_values_all: list[np.ndarray] = []

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

        pv250_grid = np.asarray(
            uvz_frames["pv"]
            .sel(pressure_level=float(pv_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        )
        z250_grid = np.asarray(
            uvz_frames["z"]
            .sel(pressure_level=float(upper_trough_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        ) / G0
        z925_grid = np.asarray(
            uvz_frames["z"]
            .sel(pressure_level=float(lower_low_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        ) / G0
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
            .sel(pressure_level=float(upper_divergence_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        )
        d925_grid = np.asarray(
            upper_air_frames["d"]
            .sel(pressure_level=float(lower_convergence_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        )
        z500_grid = np.asarray(
            gph_frames["z"]
            .sel(pressure_level=float(thickness_upper_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        ) / G0
        z1000_grid = np.asarray(
            gph_frames["z"]
            .sel(pressure_level=float(thickness_lower_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        ) / G0
        u250_grid = np.asarray(
            uvz_frames["u"]
            .sel(pressure_level=float(upper_wind_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        )
        v250_grid = np.asarray(
            uvz_frames["v"]
            .sel(pressure_level=float(upper_wind_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        )
        q925_grid = np.asarray(
            humidity_frames["q"]
            .sel(pressure_level=float(moisture_flux_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        )
        uq925_grid = np.asarray(
            humidity_frames["u"]
            .sel(pressure_level=float(moisture_flux_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        )
        vq925_grid = np.asarray(
            humidity_frames["v"]
            .sel(pressure_level=float(moisture_flux_level), method="nearest")
            .isel(frame=frame_index)
            .interp(
                latitude=lat_da,
                longitude=lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )
            .values,
            dtype=float,
        )

        pv250_excess_grid = _positive_anomaly_from_local_median(pv250_grid * 1e6)
        trough250_depth_grid = _depth_below_local_mean(z250_grid)
        low925_depth_grid = _depth_below_local_mean(z925_grid)
        ascent_grid = np.maximum(-w_grid, 0.0)
        divergence250_grid = np.maximum(d_grid, 0.0)
        convergence925_grid = np.maximum(-d925_grid, 0.0)
        thickness_grid = z500_grid - z1000_grid
        thickness_deficit_grid = _depth_below_local_mean(thickness_grid)
        jet250_grid = np.hypot(u250_grid, v250_grid)
        moisture_flux_u_grid = q925_grid * uq925_grid * 1000.0
        moisture_flux_v_grid = q925_grid * vq925_grid * 1000.0
        moisture_flux_mag_grid = np.hypot(moisture_flux_u_grid, moisture_flux_v_grid)

        pv_values_all.append(_safe_positive(pv250_excess_grid))
        trough_depth_values_all.append(_safe_positive(trough250_depth_grid))
        low925_depth_values_all.append(_safe_positive(low925_depth_grid))
        ascent_values_all.append(_safe_positive(ascent_grid))
        divergence250_values_all.append(_safe_positive(divergence250_grid))
        convergence925_values_all.append(_safe_positive(convergence925_grid))
        thickness_deficit_values_all.append(_safe_positive(thickness_deficit_grid))
        jet250_values_all.append(_safe_positive(jet250_grid))
        moisture_flux_values_all.append(_safe_positive(moisture_flux_mag_grid))

        cells: list[list[float] | None] = []
        for lat_idx, lat_val in enumerate(local_lats):
            for lon_idx, lon_val_unwrapped in enumerate(local_lons_unwrapped):
                pv_val = float(pv250_excess_grid[lat_idx, lon_idx])
                trough_val = float(trough250_depth_grid[lat_idx, lon_idx])
                low925_val = float(low925_depth_grid[lat_idx, lon_idx])
                ascent_val = float(ascent_grid[lat_idx, lon_idx])
                divergence_val = float(divergence250_grid[lat_idx, lon_idx])
                convergence_val = float(convergence925_grid[lat_idx, lon_idx])
                thickness_val = float(thickness_deficit_grid[lat_idx, lon_idx])
                u250_val = float(u250_grid[lat_idx, lon_idx])
                v250_val = float(v250_grid[lat_idx, lon_idx])
                jet250_val = float(jet250_grid[lat_idx, lon_idx])
                moisture_u_val = float(moisture_flux_u_grid[lat_idx, lon_idx])
                moisture_v_val = float(moisture_flux_v_grid[lat_idx, lon_idx])
                moisture_mag_val = float(moisture_flux_mag_grid[lat_idx, lon_idx])
                if not (
                    np.isfinite(pv_val)
                    and np.isfinite(trough_val)
                    and np.isfinite(low925_val)
                    and np.isfinite(ascent_val)
                    and np.isfinite(divergence_val)
                    and np.isfinite(convergence_val)
                    and np.isfinite(thickness_val)
                    and np.isfinite(u250_val)
                    and np.isfinite(v250_val)
                    and np.isfinite(jet250_val)
                    and np.isfinite(moisture_u_val)
                    and np.isfinite(moisture_v_val)
                    and np.isfinite(moisture_mag_val)
                ):
                    cells.append(None)
                    continue
                cells.append(
                    [
                        round(pv_val, 4),
                        round(trough_val, 2),
                        round(low925_val, 2),
                        round(ascent_val, 4),
                        round(divergence_val, 8),
                        round(convergence_val, 8),
                        round(thickness_val, 2),
                        round(u250_val, 2),
                        round(v250_val, 2),
                        round(jet250_val, 2),
                        round(moisture_u_val, 4),
                        round(moisture_v_val, 4),
                        round(moisture_mag_val, 4),
                    ]
                )

        hour_key = _hour_key(valid_time)
        frames_by_hour[hour_key] = {
            "step_hour": int(row.step_hour),
            "valid_time": _fmt_utc(valid_time),
            "hour_key": hour_key,
            "latitude": round(lat0, 2),
            "longitude": round(float(row.longitude), 2),
            "grid_latitudes": [round(float(x), 2) for x in local_lats],
            "grid_longitudes": [round(float(x), 2) for x in local_lons_unwrapped],
            "cells": cells,
            "features": {
                "pv250_peak": _feature_point(
                    pv250_excess_grid,
                    local_lats,
                    local_lons_unwrapped,
                    mode="max",
                    positive_only=True,
                    value_ndigits=4,
                ),
                "trough250_min": _feature_point(
                    z250_grid,
                    local_lats,
                    local_lons_unwrapped,
                    mode="min",
                    value_ndigits=2,
                ),
                "low925_min": _feature_point(
                    z925_grid,
                    local_lats,
                    local_lons_unwrapped,
                    mode="min",
                    value_ndigits=2,
                ),
                "divergence250_peak": _feature_point(
                    divergence250_grid,
                    local_lats,
                    local_lons_unwrapped,
                    mode="max",
                    positive_only=True,
                    value_ndigits=8,
                ),
                "ascent500_peak": _feature_point(
                    ascent_grid,
                    local_lats,
                    local_lons_unwrapped,
                    mode="max",
                    positive_only=True,
                    value_ndigits=4,
                ),
                "convergence925_peak": _feature_point(
                    convergence925_grid,
                    local_lats,
                    local_lons_unwrapped,
                    mode="max",
                    positive_only=True,
                    value_ndigits=8,
                ),
                "thickness_deficit_peak": _feature_point(
                    thickness_deficit_grid,
                    local_lats,
                    local_lons_unwrapped,
                    mode="max",
                    positive_only=True,
                    value_ndigits=2,
                ),
                "jet250_peak": _feature_point(
                    jet250_grid,
                    local_lats,
                    local_lons_unwrapped,
                    mode="max",
                    positive_only=True,
                    value_ndigits=2,
                ),
                "moisture_flux_peak": _feature_point(
                    moisture_flux_mag_grid,
                    local_lats,
                    local_lons_unwrapped,
                    mode="max",
                    positive_only=True,
                    value_ndigits=4,
                ),
            },
        }

    pv_p75 = _finite_percentile(pv_values_all, 75.0, 0.0)
    pv_p90 = _finite_percentile(pv_values_all, 90.0, max(pv_p75, 1e-6))
    pv_p95 = _finite_percentile(pv_values_all, 95.0, max(pv_p90, 1e-6))
    trough_p75 = _finite_percentile(trough_depth_values_all, 75.0, 0.0)
    trough_p90 = _finite_percentile(trough_depth_values_all, 90.0, max(trough_p75, 1e-6))
    trough_p95 = _finite_percentile(trough_depth_values_all, 95.0, max(trough_p90, 1e-6))
    low925_p75 = _finite_percentile(low925_depth_values_all, 75.0, 0.0)
    low925_p90 = _finite_percentile(low925_depth_values_all, 90.0, max(low925_p75, 1e-6))
    low925_p95 = _finite_percentile(low925_depth_values_all, 95.0, max(low925_p90, 1e-6))
    ascent_p75 = _finite_percentile(ascent_values_all, 75.0, 0.0)
    ascent_p90 = _finite_percentile(ascent_values_all, 90.0, max(ascent_p75, 1e-6))
    ascent_p95 = _finite_percentile(ascent_values_all, 95.0, max(ascent_p90, 1e-6))
    divergence250_p75 = _finite_percentile(divergence250_values_all, 75.0, 0.0)
    divergence250_p90 = _finite_percentile(
        divergence250_values_all, 90.0, max(divergence250_p75, 1e-9)
    )
    divergence250_p95 = _finite_percentile(
        divergence250_values_all, 95.0, max(divergence250_p90, 1e-9)
    )
    convergence925_p75 = _finite_percentile(convergence925_values_all, 75.0, 0.0)
    convergence925_p90 = _finite_percentile(
        convergence925_values_all, 90.0, max(convergence925_p75, 1e-9)
    )
    convergence925_p95 = _finite_percentile(
        convergence925_values_all, 95.0, max(convergence925_p90, 1e-9)
    )
    thickness_p75 = _finite_percentile(thickness_deficit_values_all, 75.0, 0.0)
    thickness_p90 = _finite_percentile(
        thickness_deficit_values_all, 90.0, max(thickness_p75, 1e-6)
    )
    thickness_p95 = _finite_percentile(
        thickness_deficit_values_all, 95.0, max(thickness_p90, 1e-6)
    )
    jet250_p75 = _finite_percentile(jet250_values_all, 75.0, 0.0)
    jet250_p90 = _finite_percentile(jet250_values_all, 90.0, max(jet250_p75, 1e-6))
    jet250_p95 = _finite_percentile(jet250_values_all, 95.0, max(jet250_p90, 1e-6))
    moisture_flux_p75 = _finite_percentile(moisture_flux_values_all, 75.0, 0.0)
    moisture_flux_p90 = _finite_percentile(
        moisture_flux_values_all, 90.0, max(moisture_flux_p75, 1e-6)
    )
    moisture_flux_p95 = _finite_percentile(
        moisture_flux_values_all, 95.0, max(moisture_flux_p90, 1e-6)
    )

    manifest = {
        "metadata": {
            "target_name": "Vancouver",
            "start_lat": float(start_lat),
            "start_lon": float(start_lon),
            "start_lon_360": float(start_lon) % 360.0,
            "requested_start_time": str(start_time),
            "resolved_start_time": _fmt_utc(trajectory["valid_time"].iloc[0]),
            "trajectory_pressure_level_hpa": int(trajectory_pressure_level),
            "pv_level_hpa": int(pv_level),
            "upper_trough_level_hpa": int(upper_trough_level),
            "lower_low_level_hpa": int(lower_low_level),
            "vertical_velocity_level_hpa": int(vertical_velocity_level),
            "upper_divergence_level_hpa": int(upper_divergence_level),
            "lower_convergence_level_hpa": int(lower_convergence_level),
            "upper_wind_level_hpa": int(upper_wind_level),
            "moisture_flux_level_hpa": int(moisture_flux_level),
            "thickness_upper_level_hpa": int(thickness_upper_level),
            "thickness_lower_level_hpa": int(thickness_lower_level),
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
            "sample_count_per_frame": int(len(next(iter(frames_by_hour.values()))["cells"]))
            if frames_by_hour
            else 0,
            "pv_p75_pvu": round(pv_p75, 4),
            "pv_p90_pvu": round(pv_p90, 4),
            "pv_p95_pvu": round(pv_p95, 4),
            "pv_max_pvu": round(
                _finite_percentile(pv_values_all, 100.0, max(pv_p95, 1e-6)),
                4,
            ),
            "trough_depth_p75_m": round(trough_p75, 2),
            "trough_depth_p90_m": round(trough_p90, 2),
            "trough_depth_p95_m": round(trough_p95, 2),
            "trough_depth_max_m": round(
                _finite_percentile(trough_depth_values_all, 100.0, max(trough_p95, 1e-6)),
                2,
            ),
            "low925_depth_p75_m": round(low925_p75, 2),
            "low925_depth_p90_m": round(low925_p90, 2),
            "low925_depth_p95_m": round(low925_p95, 2),
            "low925_depth_max_m": round(
                _finite_percentile(low925_depth_values_all, 100.0, max(low925_p95, 1e-6)),
                2,
            ),
            "ascent_p75_pa_s": round(ascent_p75, 8),
            "ascent_p90_pa_s": round(ascent_p90, 8),
            "ascent_p95_pa_s": round(ascent_p95, 8),
            "ascent_max_pa_s": round(
                _finite_percentile(ascent_values_all, 100.0, max(ascent_p95, 1e-6)),
                8,
            ),
            "divergence250_p75_s1": round(divergence250_p75, 10),
            "divergence250_p90_s1": round(divergence250_p90, 10),
            "divergence250_p95_s1": round(divergence250_p95, 10),
            "divergence250_max_s1": round(
                _finite_percentile(divergence250_values_all, 100.0, max(divergence250_p95, 1e-9)),
                10,
            ),
            "convergence925_p75_s1": round(convergence925_p75, 10),
            "convergence925_p90_s1": round(convergence925_p90, 10),
            "convergence925_p95_s1": round(convergence925_p95, 10),
            "convergence925_max_s1": round(
                _finite_percentile(
                    convergence925_values_all, 100.0, max(convergence925_p95, 1e-9)
                ),
                10,
            ),
            "thickness_deficit_p75_m": round(thickness_p75, 2),
            "thickness_deficit_p90_m": round(thickness_p90, 2),
            "thickness_deficit_p95_m": round(thickness_p95, 2),
            "thickness_deficit_max_m": round(
                _finite_percentile(
                    thickness_deficit_values_all, 100.0, max(thickness_p95, 1e-6)
                ),
                2,
            ),
            "jet250_p75_ms": round(jet250_p75, 4),
            "jet250_p90_ms": round(jet250_p90, 4),
            "jet250_p95_ms": round(jet250_p95, 4),
            "jet250_max_ms": round(
                _finite_percentile(jet250_values_all, 100.0, max(jet250_p95, 1e-6)),
                4,
            ),
            "moisture_flux_p75": round(moisture_flux_p75, 4),
            "moisture_flux_p90": round(moisture_flux_p90, 4),
            "moisture_flux_p95": round(moisture_flux_p95, 4),
            "moisture_flux_max": round(
                _finite_percentile(
                    moisture_flux_values_all, 100.0, max(moisture_flux_p95, 1e-6)
                ),
                4,
            ),
        },
        "points": [
            {
                "step_hour": int(row.step_hour),
                "valid_time": _fmt_utc(row.valid_time),
                "hour_key": _hour_key(row.valid_time),
                "latitude": round(float(row.latitude), 2),
                "longitude": round(float(row.longitude), 2),
            }
            for row in trajectory.itertuples(index=False)
        ],
    }
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
        "--gph-thickness-path",
        type=Path,
        default=Path("data/gph-250-500-850-1000-novdec2021.nc"),
        help="Path to geopotential heights including 500 and 1000 hPa.",
    )
    parser.add_argument(
        "--humidity-path",
        type=Path,
        default=Path("data/specifichumidity_wind_1000-925hpa_2026-02-19.nc"),
        help="Path to low-level specific humidity and wind NetCDF.",
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
    parser.add_argument("--pv-level", type=int, default=250)
    parser.add_argument("--upper-trough-level", type=int, default=250)
    parser.add_argument("--lower-low-level", type=int, default=925)
    parser.add_argument("--vertical-velocity-level", type=int, default=500)
    parser.add_argument("--divergence-level", type=int, default=250)
    parser.add_argument("--lower-convergence-level", type=int, default=925)
    parser.add_argument("--wind-level", type=int, default=250)
    parser.add_argument("--moisture-flux-level", type=int, default=925)
    parser.add_argument("--thickness-upper-level", type=int, default=500)
    parser.add_argument("--thickness-lower-level", type=int, default=1000)
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
            with xr.open_dataset(args.gph_thickness_path) as gph_ds:
                with xr.open_dataset(args.humidity_path) as humidity_ds:
                    manifest, frames_by_hour = build_export_payload(
                        era5_uvz_ds=era5_uvz_ds,
                        upper_air_ds=upper_air_ds,
                        gph_ds=gph_ds,
                        humidity_ds=humidity_ds,
                        start_lat=args.start_lat,
                        start_lon=args.start_lon,
                        start_time=args.start_time,
                        trajectory_pressure_level=args.trajectory_pressure_level,
                        pv_level=args.pv_level,
                        upper_trough_level=args.upper_trough_level,
                        lower_low_level=args.lower_low_level,
                        vertical_velocity_level=args.vertical_velocity_level,
                        upper_divergence_level=args.divergence_level,
                        lower_convergence_level=args.lower_convergence_level,
                        upper_wind_level=args.wind_level,
                        moisture_flux_level=args.moisture_flux_level,
                        thickness_upper_level=args.thickness_upper_level,
                        thickness_lower_level=args.thickness_lower_level,
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
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))

    for hour_key, frame in frames_by_hour.items():
        frame_path = frames_dir / _frame_filename(hour_key)
        with frame_path.open("w", encoding="utf-8") as f:
            json.dump(frame, f, ensure_ascii=False, separators=(",", ":"))

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
