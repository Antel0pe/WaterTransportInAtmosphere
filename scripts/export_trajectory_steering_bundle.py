#!/usr/bin/env python3
"""Export a local 925 hPa steering-corridor bundle for the trajectory layer."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import xarray as xr

from tqdm.auto import tqdm

from export_backward_trajectory_bundle import extract_contour_segments

G0 = 9.80665
EPSILON = 0.622


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


def _lat_slice_for_dataset(ds: xr.Dataset | xr.DataArray, lat_min: float, lat_max: float) -> slice:
    lat0 = float(ds["latitude"].values[0])
    lat1 = float(ds["latitude"].values[-1])
    return slice(lat_max, lat_min) if lat0 > lat1 else slice(lat_min, lat_max)


def _round_pairs(points: np.ndarray, ndigits: int = 4) -> list[list[float]]:
    out: list[list[float]] = []
    for lon, lat in np.asarray(points, dtype=float):
        out.append([round(float(lon), ndigits), round(float(lat), ndigits)])
    return out


def _smooth_percentile(arr: np.ndarray, q: float, fallback: float) -> float:
    vals = np.asarray(arr, dtype=float)
    vals = vals[np.isfinite(vals)]
    if vals.size == 0:
        return float(fallback)
    return float(np.percentile(vals, q))


def _dewpoint_c_from_specific_humidity(q_kgkg: np.ndarray, pressure_hpa: float) -> np.ndarray:
    q = np.clip(np.asarray(q_kgkg, dtype=float), 1e-8, 0.2)
    r = q / np.clip(1.0 - q, 1e-8, None)
    e_hpa = (r * pressure_hpa) / (EPSILON + r)
    ln_ratio = np.log(np.clip(e_hpa / 6.112, 1e-12, None))
    return (243.5 * ln_ratio) / (17.67 - ln_ratio)


def theta_e_from_t_q(t_k: np.ndarray, q_kgkg: np.ndarray, pressure_hpa: float) -> np.ndarray:
    """Approximate equivalent potential temperature using Bolton-style formula."""
    t = np.clip(np.asarray(t_k, dtype=float), 180.0, 340.0)
    q = np.clip(np.asarray(q_kgkg, dtype=float), 1e-8, 0.2)
    r = q / np.clip(1.0 - q, 1e-8, None)
    td_k = _dewpoint_c_from_specific_humidity(q, pressure_hpa) + 273.15
    td_k = np.clip(td_k, 180.0, t)

    tl = 1.0 / (1.0 / np.clip(td_k - 56.0, 1e-6, None) + np.log(t / td_k) / 800.0) + 56.0
    exponent = (3376.0 / np.clip(tl, 150.0, None) - 2.54) * r * (1.0 + 0.81 * r)
    kappa = 0.2854 * (1.0 - 0.28 * r)
    return t * np.power(1000.0 / float(pressure_hpa), kappa) * np.exp(exponent)


def scalar_gradient_magnitude_per_100km(
    field_values: np.ndarray,
    latitudes_deg: np.ndarray,
    lon_offsets_deg: np.ndarray,
) -> np.ndarray:
    field = np.asarray(field_values, dtype=float)
    latitudes = np.asarray(latitudes_deg, dtype=float)
    lon_offsets = np.asarray(lon_offsets_deg, dtype=float)
    if field.ndim != 2 or field.shape[0] < 2 or field.shape[1] < 2:
        return np.zeros_like(field)

    dtheta_dlat_deg, dtheta_dlon_deg = np.gradient(
        field,
        latitudes,
        lon_offsets,
        edge_order=1,
    )

    dtheta_dy = dtheta_dlat_deg / 111.32
    coslat = np.clip(np.cos(np.deg2rad(latitudes)), 1e-6, None)
    km_per_deg_lon = 111.32 * coslat[:, None]
    dtheta_dx = dtheta_dlon_deg / km_per_deg_lon

    return np.hypot(dtheta_dx, dtheta_dy) * 100.0


def thetae_gradient_k_per_100km(
    thetae_k: np.ndarray,
    latitudes_deg: np.ndarray,
    lon_offsets_deg: np.ndarray,
) -> np.ndarray:
    return scalar_gradient_magnitude_per_100km(thetae_k, latitudes_deg, lon_offsets_deg)


def gph_gradient_m_per_100km(
    gph_m: np.ndarray,
    latitudes_deg: np.ndarray,
    lon_offsets_deg: np.ndarray,
) -> np.ndarray:
    return scalar_gradient_magnitude_per_100km(gph_m, latitudes_deg, lon_offsets_deg)


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
    lon_pad_west_deg: float = 90.0,
    lon_pad_east_deg: float = 15.0,
    lat_pad_south_deg: float = 25.0,
    lat_pad_north_deg: float = 15.0,
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


def build_export_payload(
    era5_uvz_ds: xr.Dataset,
    temperature_ds: xr.Dataset,
    humidity_ds: xr.Dataset,
    *,
    start_lat: float,
    start_lon: float,
    start_time: str,
    pressure_level: int,
    hours_back: int,
    substeps: int,
    contour_step_m: float,
    contour_buffer_steps: int,
    sample_half_span_lat_deg: float,
    sample_half_span_lon_deg: float,
    sample_spacing_deg: float,
    contour_half_span_lat_deg: float,
    contour_half_span_lon_deg: float,
    contour_spacing_deg: float,
) -> dict[str, Any]:
    field_half_span_lat_deg = float(contour_half_span_lat_deg)
    field_half_span_lon_deg = float(contour_half_span_lon_deg)

    trajectory_df = backward_integrate_trajectory_uv_regional(
        era5_uvz_ds,
        start_lat=start_lat,
        start_lon=start_lon,
        start_time=start_time,
        pressure_level=pressure_level,
        hours_back=hours_back,
        substeps=substeps,
    )

    trajectory = trajectory_df.copy().sort_values("step_hour").reset_index(drop=True)
    trajectory["valid_time"] = pd.to_datetime(trajectory["valid_time"])
    trajectory["longitude_360"] = trajectory["longitude"] % 360.0

    time_pad = np.timedelta64(1, "h")
    lat_pad = max(field_half_span_lat_deg, float(contour_half_span_lat_deg)) + 1.0
    lon_pad = max(field_half_span_lon_deg, float(contour_half_span_lon_deg)) + 1.0

    time_min = np.datetime64(trajectory["valid_time"].min()) - time_pad
    time_max = np.datetime64(trajectory["valid_time"].max()) + time_pad
    lat_min = float(trajectory["latitude"].min()) - lat_pad
    lat_max = float(trajectory["latitude"].max()) + lat_pad
    lon_min = max(0.0, float(trajectory["longitude_360"].min()) - lon_pad)
    lon_max = min(359.75, float(trajectory["longitude_360"].max()) + lon_pad)

    era5_subset = (
        era5_uvz_ds[["z", "u", "v"]]
        .sel(
            pressure_level=pressure_level,
            valid_time=slice(time_min, time_max),
            latitude=_lat_slice_for_dataset(era5_uvz_ds, lat_min, lat_max),
            longitude=slice(lon_min, lon_max),
        )
        .load()
    )
    temperature_subset = (
        temperature_ds[["t"]]
        .sel(
            pressure_level=pressure_level,
            valid_time=slice(time_min, time_max),
            latitude=_lat_slice_for_dataset(temperature_ds, lat_min, lat_max),
            longitude=slice(lon_min, lon_max),
        )
        .load()
    )
    humidity_subset = (
        humidity_ds[["q"]]
        .sel(
            pressure_level=pressure_level,
            valid_time=slice(time_min, time_max),
            latitude=_lat_slice_for_dataset(humidity_ds, lat_min, lat_max),
            longitude=slice(lon_min, lon_max),
        )
        .load()
    )

    interp_time = xr.DataArray(
        trajectory["valid_time"].to_numpy(dtype="datetime64[ns]"),
        dims="point",
    )
    interp_lat = xr.DataArray(trajectory["latitude"].to_numpy(dtype=float), dims="point")
    interp_lon = xr.DataArray(trajectory["longitude_360"].to_numpy(dtype=float), dims="point")

    traj_interp = era5_subset.interp(
        valid_time=interp_time,
        latitude=interp_lat,
        longitude=interp_lon,
        kwargs={"bounds_error": False, "fill_value": None},
    )
    trajectory["gph_m"] = np.asarray(traj_interp["z"].values, dtype=float) / G0
    trajectory["wind_speed_ms"] = np.hypot(
        np.asarray(traj_interp["u"].values, dtype=float),
        np.asarray(traj_interp["v"].values, dtype=float),
    )

    gph_min = float(np.nanmin(trajectory["gph_m"]))
    gph_max = float(np.nanmax(trajectory["gph_m"]))
    contour_min = contour_step_m * np.floor((gph_min - contour_buffer_steps * contour_step_m) / contour_step_m)
    contour_max = contour_step_m * np.ceil((gph_max + contour_buffer_steps * contour_step_m) / contour_step_m)
    contour_levels = np.arange(contour_min, contour_max + 0.5 * contour_step_m, contour_step_m)

    lat_offsets = np.arange(
        -field_half_span_lat_deg,
        field_half_span_lat_deg + 0.5 * sample_spacing_deg,
        sample_spacing_deg,
        dtype=float,
    )
    lon_offsets = np.arange(
        -field_half_span_lon_deg,
        field_half_span_lon_deg + 0.5 * sample_spacing_deg,
        sample_spacing_deg,
        dtype=float,
    )
    contour_lat_offsets = np.arange(
        -contour_half_span_lat_deg,
        contour_half_span_lat_deg + 0.5 * contour_spacing_deg,
        contour_spacing_deg,
        dtype=float,
    )
    contour_lon_offsets = np.arange(
        -contour_half_span_lon_deg,
        contour_half_span_lon_deg + 0.5 * contour_spacing_deg,
        contour_spacing_deg,
        dtype=float,
    )

    frames: list[dict[str, Any]] = []
    thetae_all: list[np.ndarray] = []
    thetae_grad_all: list[np.ndarray] = []
    gph_grad_all: list[np.ndarray] = []
    wind_all: list[np.ndarray] = []

    for row in tqdm(
        trajectory.itertuples(index=False),
        total=len(trajectory),
        desc="Building steering bundle",
        unit="frame",
    ):
        valid_time = pd.Timestamp(row.valid_time).round("h")
        lat0 = float(row.latitude)
        lon0 = float(row.longitude_360)

        local_lats = np.clip(lat0 + lat_offsets, -89.75, 89.75)
        local_lons_unwrapped = lon0 + lon_offsets
        local_lons_mod = local_lons_unwrapped % 360.0
        contour_lats = np.clip(lat0 + contour_lat_offsets, -89.75, 89.75)
        contour_lons_unwrapped = lon0 + contour_lon_offsets
        contour_lons_mod = contour_lons_unwrapped % 360.0

        lat_da = xr.DataArray(local_lats, dims="latitude")
        lon_da = xr.DataArray(local_lons_mod, dims="longitude")
        contour_lat_da = xr.DataArray(contour_lats, dims="latitude")
        contour_lon_da = xr.DataArray(contour_lons_mod, dims="longitude")

        uvz_frame = era5_subset.sel(valid_time=np.datetime64(valid_time)).interp(
            latitude=lat_da,
            longitude=lon_da,
            kwargs={"bounds_error": False, "fill_value": None},
        )
        temp_frame = temperature_subset.sel(valid_time=np.datetime64(valid_time)).interp(
            latitude=lat_da,
            longitude=lon_da,
            kwargs={"bounds_error": False, "fill_value": None},
        )
        humid_frame = humidity_subset.sel(valid_time=np.datetime64(valid_time)).interp(
            latitude=lat_da,
            longitude=lon_da,
            kwargs={"bounds_error": False, "fill_value": None},
        )

        gph_grid = np.asarray(uvz_frame["z"].values, dtype=float) / G0
        u_grid = np.asarray(uvz_frame["u"].values, dtype=float)
        v_grid = np.asarray(uvz_frame["v"].values, dtype=float)
        t_grid = np.asarray(temp_frame["t"].values, dtype=float)
        q_grid = np.asarray(humid_frame["q"].values, dtype=float)

        thetae_grid = theta_e_from_t_q(t_grid, q_grid, pressure_level)
        thetae_grad_grid = thetae_gradient_k_per_100km(thetae_grid, local_lats, lon_offsets)
        gph_grad_grid = gph_gradient_m_per_100km(gph_grid, local_lats, lon_offsets)
        wind_grid = np.hypot(u_grid, v_grid)

        thetae_all.append(thetae_grid[np.isfinite(thetae_grid)])
        thetae_grad_all.append(thetae_grad_grid[np.isfinite(thetae_grad_grid)])
        gph_grad_all.append(gph_grad_grid[np.isfinite(gph_grad_grid)])
        wind_all.append(wind_grid[np.isfinite(wind_grid)])

        contour_gph_grid = np.asarray(
            era5_subset.sel(valid_time=np.datetime64(valid_time)).interp(
                latitude=contour_lat_da,
                longitude=contour_lon_da,
                kwargs={"bounds_error": False, "fill_value": None},
            )["z"].values,
            dtype=float,
        ) / G0
        contour_field = xr.DataArray(
            contour_gph_grid,
            coords={"latitude": contour_lats, "longitude": contour_lons_unwrapped},
            dims=("latitude", "longitude"),
        )
        contour_dict = extract_contour_segments(contour_field, contour_levels)
        contours: list[dict[str, Any]] = []
        for level in sorted(contour_dict.keys()):
            for seg_idx, seg in enumerate(contour_dict[level]):
                if seg.shape[0] < 2:
                    continue
                contours.append(
                    {
                        "level_m": round(float(level), 3),
                        "segment_index": int(seg_idx),
                        "points": _round_pairs(seg, ndigits=4),
                    }
                )

        samples: list[dict[str, Any]] = []
        for lat_idx, lat_val in enumerate(local_lats):
            for lon_idx, lon_val_unwrapped in enumerate(local_lons_unwrapped):
                thetae_val = float(thetae_grid[lat_idx, lon_idx])
                grad_val = float(thetae_grad_grid[lat_idx, lon_idx])
                gph_val = float(gph_grid[lat_idx, lon_idx])
                gph_grad_val = float(gph_grad_grid[lat_idx, lon_idx])
                wind_val = float(wind_grid[lat_idx, lon_idx])
                if not (
                    np.isfinite(gph_val)
                    and np.isfinite(gph_grad_val)
                    and np.isfinite(thetae_val)
                    and np.isfinite(grad_val)
                    and np.isfinite(wind_val)
                ):
                    continue
                samples.append(
                    {
                        "latitude": round(float(lat_val), 4),
                        "longitude": round(float(lon_val_unwrapped), 4),
                        "longitude_360": round(float(lon_val_unwrapped) % 360.0, 4),
                        "gph_m": round(gph_val, 3),
                        "gph_grad_m_per_100km": round(gph_grad_val, 3),
                        "thetae_k": round(thetae_val, 3),
                        "thetae_grad_k_per_100km": round(grad_val, 3),
                        "wind_speed_ms": round(wind_val, 3),
                    }
                )

        frames.append(
            {
                "step_hour": int(row.step_hour),
                "valid_time": _fmt_utc(valid_time),
                "hour_key": _hour_key(valid_time),
                "latitude": round(lat0, 5),
                "longitude": round(float(row.longitude), 5),
                "longitude_360": round(lon0, 5),
                "gph_m": round(float(row.gph_m), 3),
                "wind_speed_ms": round(float(row.wind_speed_ms), 3),
                "grid_latitudes": [round(float(x), 4) for x in local_lats],
                "grid_longitudes": [round(float(x), 4) for x in local_lons_unwrapped],
                "samples": samples,
                "contours": contours,
            }
        )

    thetae_vals = np.concatenate(thetae_all) if thetae_all else np.array([], dtype=float)
    thetae_grad_vals = (
        np.concatenate(thetae_grad_all) if thetae_grad_all else np.array([], dtype=float)
    )
    gph_grad_vals = np.concatenate(gph_grad_all) if gph_grad_all else np.array([], dtype=float)
    wind_vals = np.concatenate(wind_all) if wind_all else np.array([], dtype=float)

    thetae_min = float(np.nanmin(thetae_vals)) if thetae_vals.size else 0.0
    thetae_max = float(np.nanmax(thetae_vals)) if thetae_vals.size else 1.0
    thetae_mid = 0.5 * (thetae_min + thetae_max)
    thetae_p10 = _smooth_percentile(thetae_vals, 10.0, thetae_min)
    thetae_p90 = _smooth_percentile(thetae_vals, 90.0, thetae_max)
    thetae_center = 0.5 * (thetae_p10 + thetae_p90)
    thetae_half_range = max(0.5 * (thetae_p90 - thetae_p10), 1e-6)

    payload = {
        "metadata": {
            "target_name": "Vancouver",
            "start_lat": float(start_lat),
            "start_lon": float(start_lon),
            "start_lon_360": float(start_lon) % 360.0,
            "requested_start_time": str(start_time),
            "resolved_start_time": _fmt_utc(trajectory["valid_time"].iloc[0]),
            "pressure_level_hpa": int(pressure_level),
            "hours_back_requested": int(hours_back),
            "hours_back_actual": int(trajectory["step_hour"].max()),
            "substeps": int(substeps),
            "hue_field": "theta_e_925",
            "saturation_field": "theta_e_gradient_925",
            "opacity_field": "wind_speed_925",
            "contour_levels_m": [round(float(x), 3) for x in contour_levels],
            "sample_half_span_lat_deg": float(sample_half_span_lat_deg),
            "sample_half_span_lon_deg": float(sample_half_span_lon_deg),
            "sample_spacing_deg": float(sample_spacing_deg),
            "field_half_span_lat_deg": float(field_half_span_lat_deg),
            "field_half_span_lon_deg": float(field_half_span_lon_deg),
            "contour_half_span_lat_deg": float(contour_half_span_lat_deg),
            "contour_half_span_lon_deg": float(contour_half_span_lon_deg),
            "contour_spacing_deg": float(contour_spacing_deg),
            "generated_at_utc": _fmt_utc(pd.Timestamp.now(tz="UTC")),
        },
        "summary": {
            "point_count": int(len(trajectory)),
            "frame_count": int(len(frames)),
            "gph_min_m": round(gph_min, 3),
            "gph_max_m": round(gph_max, 3),
            "thetae_min_k": round(thetae_min, 3),
            "thetae_max_k": round(thetae_max, 3),
            "thetae_mid_k": round(thetae_mid, 3),
            "thetae_p10_k": round(thetae_p10, 3),
            "thetae_p90_k": round(thetae_p90, 3),
            "thetae_center_k": round(thetae_center, 3),
            "thetae_half_range_k": round(thetae_half_range, 3),
            "thetae_grad_p95_k_per_100km": round(
                _smooth_percentile(thetae_grad_vals, 95.0, 1.0),
                3,
            ),
            "gph_grad_p50_m_per_100km": round(
                _smooth_percentile(gph_grad_vals, 50.0, 0.0),
                3,
            ),
            "gph_grad_p90_m_per_100km": round(
                _smooth_percentile(gph_grad_vals, 90.0, 1.0),
                3,
            ),
            "gph_grad_p95_m_per_100km": round(
                _smooth_percentile(gph_grad_vals, 95.0, 1.0),
                3,
            ),
            "wind_speed_min_ms": round(
                float(np.nanmin(wind_vals)) if wind_vals.size else 0.0,
                3,
            ),
            "wind_speed_p25_ms": round(_smooth_percentile(wind_vals, 25.0, 0.0), 3),
            "wind_speed_p95_ms": round(_smooth_percentile(wind_vals, 95.0, 1.0), 3),
        },
        "points": [
            {
                "step_hour": int(row.step_hour),
                "valid_time": _fmt_utc(row.valid_time),
                "hour_key": _hour_key(row.valid_time),
                "latitude": round(float(row.latitude), 5),
                "longitude": round(float(row.longitude), 5),
                "longitude_360": round(float(row.longitude_360), 5),
                "gph_m": round(float(row.gph_m), 3),
                "wind_speed_ms": round(float(row.wind_speed_ms), 3),
            }
            for row in trajectory.itertuples(index=False)
        ],
        "frames": frames,
        "frames_by_hour": {frame["hour_key"]: frame for frame in frames},
    }
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export the 925 hPa steering-corridor diagnostics bundle."
    )
    parser.add_argument(
        "--era5-uvz-path",
        type=Path,
        default=Path("data/era5_2021-nov_250-500-925_uv_pv_gph.nc"),
        help="Path to ERA5 u/v/gph NetCDF.",
    )
    parser.add_argument(
        "--temperature-path",
        type=Path,
        default=Path("data/era5_2021-nov_250-500-925_temperature.nc"),
        help="Path to ERA5 temperature NetCDF.",
    )
    parser.add_argument(
        "--humidity-path",
        type=Path,
        default=Path("data/specifichumidity_wind_1000-925hpa_2026-02-19.nc"),
        help="Path to ERA5 specific humidity NetCDF.",
    )
    parser.add_argument(
        "--output-json",
        type=Path,
        default=Path("public/trajectory_steering/current.json"),
        help="Output JSON path.",
    )
    parser.add_argument("--start-lat", type=float, default=49.28)
    parser.add_argument("--start-lon", type=float, default=-123.12)
    parser.add_argument("--start-time", type=str, default="2021-11-12T15:00:00")
    parser.add_argument("--pressure-level", type=int, default=925)
    parser.add_argument("--hours-back", type=int, default=100)
    parser.add_argument("--substeps", type=int, default=4)
    parser.add_argument("--contour-step-m", type=float, default=20.0)
    parser.add_argument("--contour-buffer-steps", type=int, default=1)
    parser.add_argument("--sample-half-span-lat-deg", type=float, default=10.0)
    parser.add_argument("--sample-half-span-lon-deg", type=float, default=15.0)
    parser.add_argument("--sample-spacing-deg", type=float, default=1.0)
    parser.add_argument("--contour-half-span-lat-deg", type=float, default=14.0)
    parser.add_argument("--contour-half-span-lon-deg", type=float, default=22.0)
    parser.add_argument("--contour-spacing-deg", type=float, default=1.0)
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    with xr.open_dataset(args.era5_uvz_path) as era5_uvz_ds:
        with xr.open_dataset(args.temperature_path) as temperature_ds:
            with xr.open_dataset(args.humidity_path) as humidity_ds:
                payload = build_export_payload(
                    era5_uvz_ds=era5_uvz_ds,
                    temperature_ds=temperature_ds,
                    humidity_ds=humidity_ds,
                    start_lat=args.start_lat,
                    start_lon=args.start_lon,
                    start_time=args.start_time,
                    pressure_level=args.pressure_level,
                    hours_back=args.hours_back,
                    substeps=args.substeps,
                    contour_step_m=args.contour_step_m,
                    contour_buffer_steps=args.contour_buffer_steps,
                    sample_half_span_lat_deg=args.sample_half_span_lat_deg,
                    sample_half_span_lon_deg=args.sample_half_span_lon_deg,
                    sample_spacing_deg=args.sample_spacing_deg,
                    contour_half_span_lat_deg=args.contour_half_span_lat_deg,
                    contour_half_span_lon_deg=args.contour_half_span_lon_deg,
                    contour_spacing_deg=args.contour_spacing_deg,
                )

    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    with args.output_json.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    print(f"Wrote: {args.output_json}")
    print(f"Frames: {len(payload['frames'])}")
    print(
        "Range:",
        payload["points"][-1]["valid_time"],
        "->",
        payload["points"][0]["valid_time"],
    )


if __name__ == "__main__":
    main()
