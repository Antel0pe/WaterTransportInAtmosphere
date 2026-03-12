#!/usr/bin/env python3
"""Export backward trajectory diagnostics and clipped contour segments to JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import xarray as xr
from tqdm.auto import tqdm

G0 = 9.80665
GRAD_STEP_KM = 35.0
GRAD_PROBE_DEG = 0.20
GRAD_MIN_MAG_M_PER_KM = 0.02
GRAD_MAX_STEPS = 220
GRAD_MONOTONIC_TOL_M = 1e-3
GRAD_TRACE_SOUTH_LAT_MIN = 23.0
GHOST_FORWARD_HOURS = 12
GHOST_SUBSTEPS_PER_HOUR = 4
EARTH_RADIUS_M = 6_371_000.0


def _fmt_utc(ts: Any) -> str:
    stamp = pd.Timestamp(ts)
    if stamp.tzinfo is None:
        stamp = stamp.tz_localize("UTC")
    else:
        stamp = stamp.tz_convert("UTC")
    return stamp.strftime("%Y-%m-%dT%H:%M:%SZ")


def _lat_slice_for_dataset(ds: xr.Dataset, lat_min: float, lat_max: float) -> slice:
    lat0 = float(ds["latitude"].values[0])
    lat1 = float(ds["latitude"].values[-1])
    return slice(lat_max, lat_min) if lat0 > lat1 else slice(lat_min, lat_max)


def backward_integrate_trajectory_uv(
    ds: xr.Dataset,
    start_lat: float,
    start_lon: float,
    start_time: str,
    pressure_level: int = 925,
    hours_back: int = 72,
    substeps: int = 4,
    earth_radius_m: float = EARTH_RADIUS_M,
) -> pd.DataFrame:
    """Backward trajectory using ERA5 u/v winds."""
    if substeps < 1:
        raise ValueError("substeps must be >= 1")

    ds_uv = ds[["u", "v"]].sel(pressure_level=pressure_level)
    t0 = pd.Timestamp(start_time).to_datetime64()
    t_nearest = ds_uv["valid_time"].sel(valid_time=t0, method="nearest").values

    window_start = np.datetime64(t_nearest) - np.timedelta64(hours_back + 2, "h")
    ds_uv = ds_uv.sel(valid_time=slice(window_start, np.datetime64(t_nearest))).load()

    times = pd.to_datetime(ds_uv["valid_time"].values)
    lat = float(start_lat)
    lon = float(start_lon) % 360.0

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
                valid_time=t_mid,
                latitude=lat_step,
                longitude=lon_step,
                kwargs={"fill_value": "extrapolate"},
            )

            u_ms = float(uv["u"].values)
            v_ms = float(uv["v"].values)

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


def _nearest_hour_timestamp(ts: Any) -> pd.Timestamp:
    return pd.Timestamp(ts).round("h")


def extract_contour_segments(gph2d: xr.DataArray, levels: np.ndarray) -> dict[float, list[np.ndarray]]:
    fig, ax = plt.subplots(figsize=(3, 2))
    cs = ax.contour(
        gph2d["longitude"].values,
        gph2d["latitude"].values,
        gph2d.values,
        levels=levels,
    )

    segments_by_level: dict[float, list[np.ndarray]] = {}
    for level, segs in zip(cs.levels, cs.allsegs):
        clean = [seg.copy() for seg in segs if seg.shape[0] >= 2]
        if clean:
            segments_by_level[float(level)] = clean

    plt.close(fig)
    return segments_by_level


def _interp_gph_value(gph2d: xr.DataArray, lon: float, lat: float) -> float:
    val = gph2d.interp(
        latitude=float(lat),
        longitude=float(lon),
        kwargs={"fill_value": "extrapolate"},
    )
    return float(val.values)


def _km_per_deg_lon(lat: float) -> float:
    return max(111.32 * np.cos(np.deg2rad(float(lat))), 1e-6)


def _local_gph_gradient_east_north(
    gph2d: xr.DataArray,
    lon: float,
    lat: float,
    probe_deg: float = GRAD_PROBE_DEG,
) -> np.ndarray:
    lon = float(lon)
    lat = float(lat)
    h = float(probe_deg)

    g_lon_plus = _interp_gph_value(gph2d, lon + h, lat)
    g_lon_minus = _interp_gph_value(gph2d, lon - h, lat)
    g_lat_plus = _interp_gph_value(gph2d, lon, lat + h)
    g_lat_minus = _interp_gph_value(gph2d, lon, lat - h)

    dgd_lon_deg = (g_lon_plus - g_lon_minus) / (2.0 * h)
    dgd_lat_deg = (g_lat_plus - g_lat_minus) / (2.0 * h)

    dgd_east = dgd_lon_deg / _km_per_deg_lon(lat)
    dgd_north = dgd_lat_deg / 111.32

    return np.array([float(dgd_east), float(dgd_north)], dtype=float)


def _trace_gradient_path(
    gph2d: xr.DataArray,
    lon0: float,
    lat0: float,
    *,
    lon_min: float,
    lon_max: float,
    lat_min: float,
    lat_max: float,
    prefer: str = "increase",
    step_km: float = GRAD_STEP_KM,
    probe_deg: float = GRAD_PROBE_DEG,
    grad_min_mag: float = GRAD_MIN_MAG_M_PER_KM,
    max_steps: int = GRAD_MAX_STEPS,
    monotonic_tol: float = GRAD_MONOTONIC_TOL_M,
) -> dict[str, Any]:
    lon0 = float(lon0)
    lat0 = float(lat0)

    base_val = _interp_gph_value(gph2d, lon0, lat0)
    samples = [(lon0, lat0, base_val)]
    stop_reason = "max_steps"

    for _ in range(max_steps):
        curr_lon, curr_lat, curr_val = samples[-1]

        grad = _local_gph_gradient_east_north(
            gph2d,
            curr_lon,
            curr_lat,
            probe_deg=probe_deg,
        )
        grad_mag = float(np.linalg.norm(grad))

        if not np.isfinite(grad_mag) or grad_mag < float(grad_min_mag):
            stop_reason = "gradient_too_small"
            break

        step_dir = grad / grad_mag
        if prefer == "decrease":
            step_dir = -step_dir

        d_east_km = float(step_dir[0]) * float(step_km)
        d_north_km = float(step_dir[1]) * float(step_km)

        next_lon = curr_lon + d_east_km / _km_per_deg_lon(curr_lat)
        next_lat = curr_lat + d_north_km / 111.32

        if (
            next_lon < lon_min
            or next_lon > lon_max
            or next_lat < lat_min
            or next_lat > lat_max
        ):
            stop_reason = "domain_edge"
            break

        next_val = _interp_gph_value(gph2d, next_lon, next_lat)
        if not np.isfinite(next_val):
            stop_reason = "nan"
            break

        if prefer == "decrease":
            if not (next_val < curr_val - monotonic_tol):
                stop_reason = "cannot_decrease"
                break
        else:
            if not (next_val > curr_val + monotonic_tol):
                stop_reason = "cannot_increase"
                break

        samples.append((float(next_lon), float(next_lat), float(next_val)))

    line = np.asarray([(p[0], p[1]) for p in samples], dtype=float)
    final_lon, final_lat, final_val = samples[-1]

    return {
        "line": line,
        "final_lon": float(final_lon),
        "final_lat": float(final_lat),
        "final_value": float(final_val),
        "stop_reason": stop_reason,
        "num_steps": int(len(samples) - 1),
    }


def _nearest_contour_segment_to_point_from_dict(
    contour_dict: dict[float, list[np.ndarray]],
    lon_ref: float,
    lat_ref: float,
    max_dist_deg: float = np.inf,
) -> dict[str, Any] | None:
    lon_ref = float(lon_ref)
    lat_ref = float(lat_ref)
    lon_scale = max(np.cos(np.deg2rad(lat_ref)), 1e-6)

    best: dict[str, Any] | None = None
    best_dist = np.inf

    for level, segs in contour_dict.items():
        for seg_idx, seg in enumerate(segs):
            seg = np.asarray(seg, dtype=float)
            if seg.shape[0] < 2:
                continue

            d = np.sqrt(((seg[:, 0] - lon_ref) * lon_scale) ** 2 + (seg[:, 1] - lat_ref) ** 2)
            idx = int(np.argmin(d))
            dist = float(d[idx])

            if dist < best_dist:
                best_dist = dist
                best = {
                    "level": float(level),
                    "segment_index": int(seg_idx),
                    "segment": seg,
                    "nearest_point": seg[idx],
                    "distance": dist,
                }

    if best is None:
        return None
    if float(best["distance"]) > float(max_dist_deg):
        return None
    return best


def _nearest_segment_tangent_unit_from_dict(
    contour_dict: dict[float, list[np.ndarray]],
    lon_ref: float,
    lat_ref: float,
) -> dict[str, Any] | None:
    if not contour_dict:
        return None

    lon_ref = float(lon_ref)
    lat_ref = float(lat_ref)
    lon_scale = max(np.cos(np.deg2rad(lat_ref)), 1e-6)
    best: dict[str, Any] | None = None

    for level, segs in contour_dict.items():
        for seg in segs:
            seg = np.asarray(seg, dtype=float)
            if seg.ndim != 2 or seg.shape[0] < 2:
                continue

            lon_seg = lon_ref + ((seg[:, 0] - lon_ref + 180.0) % 360.0 - 180.0)
            lat_seg = seg[:, 1]
            x = (lon_seg - lon_ref) * lon_scale
            y = lat_seg - lat_ref

            x0 = x[:-1]
            y0 = y[:-1]
            x1 = x[1:]
            y1 = y[1:]
            dx = x1 - x0
            dy = y1 - y0

            seg_len2 = dx * dx + dy * dy
            valid = seg_len2 > 1e-14
            if not np.any(valid):
                continue

            t = np.zeros_like(seg_len2)
            t[valid] = np.clip(
                ((-x0[valid]) * dx[valid] + (-y0[valid]) * dy[valid]) / seg_len2[valid],
                0.0,
                1.0,
            )
            cx = x0 + t * dx
            cy = y0 + t * dy
            dist2 = cx * cx + cy * cy
            dist2 = np.where(valid, dist2, np.inf)

            idx = int(np.argmin(dist2))
            if not np.isfinite(dist2[idx]):
                continue

            tan_x = float(dx[idx])
            tan_y = float(dy[idx])
            tan_norm = float(np.hypot(tan_x, tan_y))
            if tan_norm < 1e-12:
                continue

            tangent_unit = np.array([tan_x / tan_norm, tan_y / tan_norm], dtype=float)
            dist = float(np.sqrt(dist2[idx]))

            if best is None or dist < best["distance"]:
                best = {
                    "distance": dist,
                    "tangent_unit": tangent_unit,
                    "level": float(level),
                }

    return best


def _forward_advect_contour_parallel_speed(
    uv_at_hour: xr.Dataset,
    contour_dict: dict[float, list[np.ndarray]],
    lon0: float,
    lat0: float,
    hours: int = GHOST_FORWARD_HOURS,
    substeps: int = GHOST_SUBSTEPS_PER_HOUR,
    earth_radius_m: float = EARTH_RADIUS_M,
) -> np.ndarray:
    if substeps < 1:
        raise ValueError("substeps must be >= 1")

    lon = float(lon0) % 360.0
    lat = float(np.clip(lat0, -89.75, 89.75))
    dt_sub_s = 3600.0 / float(substeps)
    ghost_points: list[tuple[float, float]] = []

    for _ in range(int(hours)):
        lon_step = lon
        lat_step = lat

        for _ in range(int(substeps)):
            uv = uv_at_hour.interp(
                latitude=lat_step,
                longitude=lon_step,
                kwargs={"fill_value": "extrapolate"},
            )
            u_ms = float(uv["u"].values)
            v_ms = float(uv["v"].values)
            speed_ms = float(np.hypot(u_ms, v_ms))
            if speed_ms < 1e-12:
                continue

            tangent = _nearest_segment_tangent_unit_from_dict(
                contour_dict,
                lon_step,
                lat_step,
            )
            if tangent is None:
                dir_east = float(u_ms / speed_ms)
                dir_north = float(v_ms / speed_ms)
            else:
                dir_east = float(tangent["tangent_unit"][0])
                dir_north = float(tangent["tangent_unit"][1])
                if u_ms * dir_east + v_ms * dir_north < 0.0:
                    dir_east = -dir_east
                    dir_north = -dir_north

            d_east_m = speed_ms * dir_east * dt_sub_s
            d_north_m = speed_ms * dir_north * dt_sub_s
            dlat_deg = np.degrees(d_north_m / earth_radius_m)
            coslat = max(np.cos(np.radians(lat_step)), 1e-6)
            dlon_deg = np.degrees(d_east_m / (earth_radius_m * coslat))

            lat_step = float(np.clip(lat_step + dlat_deg, -89.75, 89.75))
            lon_step = float((lon_step + dlon_deg) % 360.0)

        lon = lon_step
        lat = lat_step
        ghost_points.append((lon, lat))

    return np.asarray(ghost_points, dtype=float)


def _is_closed_contour(segment: np.ndarray, tol: float = 1e-3) -> bool:
    if segment.shape[0] < 3:
        return False
    return bool(np.linalg.norm(segment[0] - segment[-1]) <= tol)


def _final_contour_for_branch(
    contour_match: dict[str, Any] | None,
    branch: str,
) -> dict[str, Any] | None:
    if contour_match is None:
        return None

    seg = np.asarray(contour_match["segment"], dtype=float)
    if seg.shape[0] < 2:
        return None

    level_m = float(contour_match["level"])
    return {
        "branch": branch,
        "level_m": round(level_m, 3),
        "gph_m": round(level_m, 3),
        "segment_index": int(contour_match["segment_index"]),
        "min_distance_deg": round(float(contour_match["distance"]), 4),
        "is_closed": _is_closed_contour(seg),
        "points": _round_point_pairs(seg, ndigits=4),
    }


def _empty_final_extrema_contours(reason: str = "none exist") -> dict[str, Any]:
    return {
        "status": "none",
        "message": reason,
        "lower_branch": None,
        "higher_branch": None,
        "lower_gph_m": None,
        "higher_gph_m": None,
        "decreasing_contour": None,
        "increasing_contour": None,
        "lower_contour": None,
        "higher_contour": None,
    }


def _round_point_pairs(arr: np.ndarray, ndigits: int = 4) -> list[list[float]]:
    out: list[list[float]] = []
    for lon, lat in arr:
        out.append([round(float(lon), ndigits), round(float(lat), ndigits)])
    return out


def _wrap_lon_near(lon: float, ref_lon: float) -> float:
    return float(ref_lon + ((float(lon) - float(ref_lon) + 180.0) % 360.0 - 180.0))


def _unwrap_lon_polyline_near_ref(lons: np.ndarray, ref_lon: float) -> np.ndarray:
    arr = np.asarray(lons, dtype=float)
    if arr.size == 0:
        return arr.copy()

    # Preserve polyline continuity first, then shift by whole turns so the line
    # sits near the local clipping/reference longitude.
    unwrapped = np.rad2deg(np.unwrap(np.deg2rad(arr), discont=np.deg2rad(180.0)))
    center = 0.5 * float(np.nanmin(unwrapped) + np.nanmax(unwrapped))
    turn = 360.0 * np.round((float(ref_lon) - center) / 360.0)
    return unwrapped + turn


def _polygon_signed_area(poly: np.ndarray) -> float:
    if poly.shape[0] < 3:
        return 0.0
    x = poly[:, 0]
    y = poly[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _ensure_ccw(poly: np.ndarray) -> np.ndarray:
    arr = np.asarray(poly, dtype=float)
    if arr.shape[0] < 3:
        return arr
    return arr if _polygon_signed_area(arr) >= 0.0 else arr[::-1].copy()


def _clip_line_segment_to_convex_polygon(
    p0: np.ndarray,
    p1: np.ndarray,
    polygon_ccw: np.ndarray,
    eps: float = 1e-9,
) -> tuple[np.ndarray, np.ndarray] | None:
    d = p1 - p0
    t_enter = 0.0
    t_exit = 1.0
    m = int(polygon_ccw.shape[0])
    if m < 3:
        return None

    for i in range(m):
        vi = polygon_ccw[i]
        vj = polygon_ccw[(i + 1) % m]
        edge = vj - vi
        # Inward normal for a CCW polygon edge.
        n_in = np.array([-edge[1], edge[0]], dtype=float)

        num = -float(np.dot(n_in, p0 - vi))
        den = float(np.dot(n_in, d))

        if abs(den) <= eps:
            # For parallel segments, reject only if the segment lies outside
            # the inward half-space for this edge.
            if num > eps:
                return None
            continue

        t = num / den
        if den > 0.0:
            t_enter = max(t_enter, t)
        else:
            t_exit = min(t_exit, t)

        if t_enter > t_exit + eps:
            return None

    t0 = max(t_enter, 0.0)
    t1 = min(t_exit, 1.0)
    if t1 - t0 <= eps:
        return None

    q0 = p0 + t0 * d
    q1 = p0 + t1 * d
    return np.asarray(q0, dtype=float), np.asarray(q1, dtype=float)


def _clip_polyline_to_convex_polygon(
    line_xy: np.ndarray,
    polygon_ccw: np.ndarray,
    eps: float = 1e-9,
    join_tol: float = 1e-7,
) -> list[np.ndarray]:
    line_xy = np.asarray(line_xy, dtype=float)
    if line_xy.shape[0] < 2:
        return []

    pieces: list[np.ndarray] = []
    current: list[np.ndarray] = []

    for i in range(line_xy.shape[0] - 1):
        p0 = line_xy[i]
        p1 = line_xy[i + 1]
        clipped = _clip_line_segment_to_convex_polygon(p0, p1, polygon_ccw, eps=eps)

        if clipped is None:
            if len(current) >= 2:
                pieces.append(np.asarray(current, dtype=float))
            current = []
            continue

        c0, c1 = clipped
        if not current:
            current = [c0, c1]
            continue

        if float(np.linalg.norm(current[-1] - c0)) <= join_tol:
            if float(np.linalg.norm(current[-1] - c1)) > join_tol:
                current.append(c1)
        else:
            if len(current) >= 2:
                pieces.append(np.asarray(current, dtype=float))
            current = [c0, c1]

    if len(current) >= 2:
        pieces.append(np.asarray(current, dtype=float))

    cleaned: list[np.ndarray] = []
    for piece in pieces:
        if piece.shape[0] < 2:
            continue

        dedup = [piece[0]]
        for pt in piece[1:]:
            if float(np.linalg.norm(pt - dedup[-1])) > join_tol:
                dedup.append(pt)

        if len(dedup) >= 2:
            cleaned.append(np.asarray(dedup, dtype=float))

    return cleaned


def _build_oriented_clip_rectangle(
    lon0: float,
    lat0: float,
    end_a_lonlat: np.ndarray,
    end_b_lonlat: np.ndarray,
    min_half_short: float = 1e-6,
) -> dict[str, Any] | None:
    center = np.array([float(lon0), float(lat0)], dtype=float)
    end_a = np.asarray(end_a_lonlat, dtype=float).copy()
    end_b = np.asarray(end_b_lonlat, dtype=float).copy()

    lon_ref = float(center[0])
    lon_scale = max(np.cos(np.deg2rad(center[1])), 1e-6)

    end_a[0] = _wrap_lon_near(end_a[0], lon_ref)
    end_b[0] = _wrap_lon_near(end_b[0], lon_ref)

    def to_xy(lonlat: np.ndarray) -> np.ndarray:
        lonlat = np.asarray(lonlat, dtype=float)
        return np.array([lonlat[0] * lon_scale, lonlat[1]], dtype=float)

    def to_lonlat(xy: np.ndarray) -> np.ndarray:
        xy = np.asarray(xy, dtype=float)
        return np.array([float(xy[0] / lon_scale) % 360.0, float(xy[1])], dtype=float)

    center_xy = to_xy(center)
    a_xy = to_xy(end_a)
    b_xy = to_xy(end_b)

    long_vec = b_xy - a_xy
    long_len = float(np.linalg.norm(long_vec))
    if not np.isfinite(long_len) or long_len < 1e-10:
        return None

    long_hat = long_vec / long_len
    short_hat = np.array([-long_hat[1], long_hat[0]], dtype=float)

    proj_a = float(np.dot(a_xy - center_xy, short_hat))
    proj_b = float(np.dot(b_xy - center_xy, short_hat))

    dominant_proj = proj_a if abs(proj_a) >= abs(proj_b) else proj_b
    if dominant_proj < 0.0:
        short_hat = -short_hat
        proj_a = -proj_a
        proj_b = -proj_b

    max_perp = max(abs(proj_a), abs(proj_b), float(min_half_short))
    short_length = max(float(long_len), 2.0 * max_perp)
    half_short = 0.5 * short_length

    top_offset = +half_short
    bottom_offset = -half_short

    a_top_xy = a_xy + (top_offset - proj_a) * short_hat
    b_top_xy = b_xy + (top_offset - proj_b) * short_hat
    b_bottom_xy = b_xy + (bottom_offset - proj_b) * short_hat
    a_bottom_xy = a_xy + (bottom_offset - proj_a) * short_hat

    corners_xy = np.vstack([a_top_xy, b_top_xy, b_bottom_xy, a_bottom_xy])
    corners = np.vstack([to_lonlat(c) for c in corners_xy])

    return {
        "corners": corners,
        "corners_xy": corners_xy,
        "lon_ref": lon_ref,
        "lon_scale": float(lon_scale),
        "long_length": float(long_len),
        "short_length": float(short_length),
    }


def _min_distance_deg_to_polyline(line_lonlat: np.ndarray, lon_ref: float, lat_ref: float) -> float:
    line_lonlat = np.asarray(line_lonlat, dtype=float)
    if line_lonlat.shape[0] == 0:
        return float("inf")

    lon_ref = float(lon_ref)
    lat_ref = float(lat_ref)
    lon_scale = max(np.cos(np.deg2rad(lat_ref)), 1e-6)
    lons_local = np.array([_wrap_lon_near(lon, lon_ref) for lon in line_lonlat[:, 0]], dtype=float)
    d = np.sqrt(((lons_local - lon_ref) * lon_scale) ** 2 + (line_lonlat[:, 1] - lat_ref) ** 2)
    return float(np.nanmin(d))


def _clip_contours_to_rectangle(
    contour_dict: dict[float, list[np.ndarray]],
    clip_rect: dict[str, Any],
    lon_ref: float,
    lat_ref: float,
) -> list[dict[str, Any]]:
    lon_ref = float(lon_ref)
    lat_ref = float(lat_ref)
    rect_lon_ref = float(clip_rect["lon_ref"])
    lon_scale = float(clip_rect["lon_scale"])
    polygon_xy = _ensure_ccw(np.asarray(clip_rect["corners_xy"], dtype=float))

    snippets: list[dict[str, Any]] = []

    for level in sorted(contour_dict.keys()):
        segs = contour_dict[level]
        for seg_idx, seg in enumerate(segs):
            seg = np.asarray(seg, dtype=float)
            if seg.shape[0] < 2:
                continue

            seg_lon_local = _unwrap_lon_polyline_near_ref(seg[:, 0], rect_lon_ref)
            seg_xy = np.column_stack(
                [
                    seg_lon_local * lon_scale,
                    seg[:, 1],
                ]
            )
            clipped_pieces_xy = _clip_polyline_to_convex_polygon(seg_xy, polygon_xy)
            if not clipped_pieces_xy:
                continue

            for piece_idx, piece_xy in enumerate(clipped_pieces_xy):
                if piece_xy.shape[0] < 2:
                    continue

                piece_lonlat = np.column_stack(
                    [
                        _unwrap_lon_polyline_near_ref(piece_xy[:, 0] / lon_scale, lon_ref),
                        piece_xy[:, 1],
                    ]
                )
                if piece_lonlat.shape[0] < 2:
                    continue

                snippets.append(
                    {
                        "level_m": round(float(level), 3),
                        "gph_m": round(float(level), 3),
                        "segment_index": int(seg_idx),
                        "piece_index": int(piece_idx),
                        "min_distance_deg": round(
                            _min_distance_deg_to_polyline(piece_lonlat, lon_ref=lon_ref, lat_ref=lat_ref),
                            4,
                        ),
                        "points": _round_point_pairs(piece_lonlat, ndigits=4),
                    }
                )

    return snippets


def build_export_payload(
    era5_ds: xr.Dataset,
    water_accum_ds: xr.Dataset,
    water_instant_ds: xr.Dataset,
    start_lat: float,
    start_lon: float,
    start_time: str,
    pressure_level: int,
    hours_back: int,
    substeps: int,
    contour_levels: np.ndarray,
    max_contour_distance_deg: float,
    gph_interp_lat_pad: float = 3.0,
    gph_interp_lon_pad: float = 5.0,
    contour_lat_pad: float = 8.0,
    contour_lon_pad: float = 12.0,
) -> dict[str, Any]:
    trajectory_df = backward_integrate_trajectory_uv(
        era5_ds,
        start_lat=start_lat,
        start_lon=start_lon,
        start_time=start_time,
        pressure_level=pressure_level,
        hours_back=hours_back,
        substeps=substeps,
    )

    trajectory_samples = trajectory_df.copy().sort_values("step_hour").reset_index(drop=True)
    trajectory_samples["valid_time"] = pd.to_datetime(trajectory_samples["valid_time"])
    trajectory_samples["longitude_360"] = trajectory_samples["longitude"] % 360.0

    interp_time = xr.DataArray(
        trajectory_samples["valid_time"].to_numpy(dtype="datetime64[ns]"),
        dims="point",
    )
    interp_lat = xr.DataArray(
        trajectory_samples["latitude"].to_numpy(dtype=float),
        dims="point",
    )
    interp_lon = xr.DataArray(
        trajectory_samples["longitude_360"].to_numpy(dtype=float),
        dims="point",
    )

    accum_interp = water_accum_ds[["tp", "e"]].interp(
        valid_time=interp_time,
        latitude=interp_lat,
        longitude=interp_lon,
        kwargs={"bounds_error": False, "fill_value": None},
    )
    instant_interp = water_instant_ds[["tcw"]].interp(
        valid_time=interp_time,
        latitude=interp_lat,
        longitude=interp_lon,
        kwargs={"bounds_error": False, "fill_value": None},
    )

    trajectory_samples["tp_mm"] = np.asarray(accum_interp["tp"].values, dtype=float) * 1000.0
    trajectory_samples["evap_mm_added"] = -np.asarray(accum_interp["e"].values, dtype=float) * 1000.0
    trajectory_samples["tcw_kg_m2"] = np.asarray(instant_interp["tcw"].values, dtype=float)

    time_pad = np.timedelta64(1, "h")
    time_min = np.datetime64(trajectory_samples["valid_time"].min()) - time_pad
    time_max = np.datetime64(trajectory_samples["valid_time"].max()) + time_pad
    lat_min = float(trajectory_samples["latitude"].min()) - gph_interp_lat_pad
    lat_max = float(trajectory_samples["latitude"].max()) + gph_interp_lat_pad
    lon_min = float(trajectory_samples["longitude_360"].min()) - gph_interp_lon_pad
    lon_max = float(trajectory_samples["longitude_360"].max()) + gph_interp_lon_pad

    lon_min = max(0.0, lon_min)
    lon_max = min(359.75, lon_max)
    lat_min = max(-90.0, lat_min)
    lat_max = min(90.0, lat_max)

    gph_925_subset = (
        era5_ds["z"]
        .sel(
            pressure_level=pressure_level,
            valid_time=slice(time_min, time_max),
            latitude=_lat_slice_for_dataset(era5_ds, lat_min, lat_max),
            longitude=slice(lon_min, lon_max),
        )
        / G0
    ).load()

    gph_vals = gph_925_subset.interp(
        valid_time=interp_time,
        latitude=interp_lat,
        longitude=interp_lon,
    )
    trajectory_samples["gph_m"] = np.asarray(gph_vals.values, dtype=float)

    contour_time_min = np.datetime64(trajectory_samples["valid_time"].min()) - time_pad
    contour_time_max = np.datetime64(trajectory_samples["valid_time"].max()) + time_pad
    dataset_lats = np.asarray(era5_ds["latitude"].values, dtype=float)
    dataset_lons = np.asarray(era5_ds["longitude"].values, dtype=float)
    contour_lat_min = max(
        float(np.nanmin(dataset_lats)),
        min(
            GRAD_TRACE_SOUTH_LAT_MIN,
            float(trajectory_samples["latitude"].min()) - contour_lat_pad,
        ),
    )
    contour_lat_max = float(np.nanmax(dataset_lats))
    contour_lon_min = float(np.nanmin(dataset_lons))
    contour_lon_max = float(np.nanmax(dataset_lons))

    gph_hourly_925_m = (
        era5_ds["z"]
        .sel(
            pressure_level=pressure_level,
            valid_time=slice(contour_time_min, contour_time_max),
            latitude=_lat_slice_for_dataset(era5_ds, contour_lat_min, contour_lat_max),
            longitude=slice(contour_lon_min, contour_lon_max),
        )
        / G0
    ).load()
    uv_hourly_925 = (
        era5_ds[["u", "v"]]
        .sel(
            pressure_level=pressure_level,
            valid_time=slice(contour_time_min, contour_time_max),
            latitude=_lat_slice_for_dataset(era5_ds, contour_lat_min, contour_lat_max),
            longitude=slice(contour_lon_min, contour_lon_max),
        )
    ).load()

    gph_hourly_contours: dict[pd.Timestamp, dict[float, list[np.ndarray]]] = {}
    for frame_time in tqdm(
        gph_hourly_925_m["valid_time"].values,
        desc="Extracting hourly contour fields",
        unit="hour",
    ):
        gph_frame = gph_hourly_925_m.sel(valid_time=frame_time)
        gph_hourly_contours[pd.Timestamp(frame_time)] = extract_contour_segments(
            gph_frame, contour_levels
        )

    selected_points = trajectory_samples.copy().sort_values("valid_time").reset_index(drop=True)
    contour_by_hour: dict[int, list[dict[str, Any]]] = {}
    final_extrema_contours_by_hour: dict[int, dict[str, Any]] = {}
    ghost_forward_advected_cells_by_hour: dict[int, list[dict[str, Any]]] = {}

    for _, row in tqdm(
        selected_points.iterrows(),
        total=len(selected_points),
        desc="Tracing gradient contours",
        unit="point",
    ):
        step_hour = int(row["step_hour"])
        t_key = _nearest_hour_timestamp(row["valid_time"])
        contour_dict = gph_hourly_contours.get(t_key)
        if contour_dict is None:
            contour_by_hour[step_hour] = []
            final_extrema_contours_by_hour[step_hour] = _empty_final_extrema_contours(
                "none exist"
            )
            ghost_forward_advected_cells_by_hour[step_hour] = []
            continue

        gph_frame = gph_hourly_925_m.sel(valid_time=np.datetime64(t_key))
        lon0 = float(row["longitude_360"])
        lat0 = float(row["latitude"])
        try:
            uv_frame = uv_hourly_925.sel(valid_time=np.datetime64(t_key))
        except Exception:
            uv_frame = uv_hourly_925.sel(valid_time=np.datetime64(t_key), method="nearest")

        ghost_points = _forward_advect_contour_parallel_speed(
            uv_frame,
            contour_dict,
            lon0,
            lat0,
            hours=GHOST_FORWARD_HOURS,
            substeps=GHOST_SUBSTEPS_PER_HOUR,
            earth_radius_m=EARTH_RADIUS_M,
        )
        ghost_forward_advected_cells_by_hour[step_hour] = [
            {
                "forward_hour": int(idx + 1),
                "latitude": round(float(ghost_lat), 5),
                "longitude": round(float(ghost_lon), 5),
                "longitude_360": round(float(ghost_lon) % 360.0, 5),
            }
            for idx, (ghost_lon, ghost_lat) in enumerate(ghost_points)
        ]

        frame_lon_min = float(np.nanmin(np.asarray(gph_frame["longitude"].values, dtype=float)))
        frame_lon_max = float(np.nanmax(np.asarray(gph_frame["longitude"].values, dtype=float)))
        frame_lat_min = float(np.nanmin(np.asarray(gph_frame["latitude"].values, dtype=float)))
        frame_lat_max = float(np.nanmax(np.asarray(gph_frame["latitude"].values, dtype=float)))

        dec_trace = _trace_gradient_path(
            gph_frame,
            lon0,
            lat0,
            lon_min=frame_lon_min,
            lon_max=frame_lon_max,
            lat_min=frame_lat_min,
            lat_max=frame_lat_max,
            prefer="decrease",
            step_km=GRAD_STEP_KM,
            probe_deg=GRAD_PROBE_DEG,
            grad_min_mag=GRAD_MIN_MAG_M_PER_KM,
            max_steps=GRAD_MAX_STEPS,
            monotonic_tol=GRAD_MONOTONIC_TOL_M,
        )
        inc_trace = _trace_gradient_path(
            gph_frame,
            lon0,
            lat0,
            lon_min=frame_lon_min,
            lon_max=frame_lon_max,
            lat_min=frame_lat_min,
            lat_max=frame_lat_max,
            prefer="increase",
            step_km=GRAD_STEP_KM,
            probe_deg=GRAD_PROBE_DEG,
            grad_min_mag=GRAD_MIN_MAG_M_PER_KM,
            max_steps=GRAD_MAX_STEPS,
            monotonic_tol=GRAD_MONOTONIC_TOL_M,
        )

        long_end_a = np.array([dec_trace["final_lon"], dec_trace["final_lat"]], dtype=float)
        long_end_b = np.array([inc_trace["final_lon"], inc_trace["final_lat"]], dtype=float)
        clip_rect = _build_oriented_clip_rectangle(lon0, lat0, long_end_a, long_end_b)

        if clip_rect is None:
            contour_by_hour[step_hour] = []
        else:
            contour_by_hour[step_hour] = _clip_contours_to_rectangle(
                contour_dict,
                clip_rect,
                lon_ref=lon0,
                lat_ref=lat0,
            )

        dec_extrema_match = _nearest_contour_segment_to_point_from_dict(
            contour_dict,
            dec_trace["final_lon"],
            dec_trace["final_lat"],
            max_dist_deg=360.0,
        )
        inc_extrema_match = _nearest_contour_segment_to_point_from_dict(
            contour_dict,
            inc_trace["final_lon"],
            inc_trace["final_lat"],
            max_dist_deg=360.0,
        )

        dec_contour = _final_contour_for_branch(dec_extrema_match, "decreasing")
        inc_contour = _final_contour_for_branch(inc_extrema_match, "increasing")

        available = [c for c in [dec_contour, inc_contour] if c is not None]
        if not available:
            final_extrema_contours_by_hour[step_hour] = _empty_final_extrema_contours(
                "none exist"
            )
            continue

        lower = min(available, key=lambda c: float(c["gph_m"]))
        higher = max(available, key=lambda c: float(c["gph_m"]))
        status = "ok" if len(available) == 2 else "partial"
        message = "ok" if status == "ok" else "one contour exists"

        final_extrema_contours_by_hour[step_hour] = {
            "status": status,
            "message": message,
            "lower_branch": lower["branch"],
            "higher_branch": higher["branch"],
            "lower_gph_m": lower["gph_m"],
            "higher_gph_m": higher["gph_m"],
            "decreasing_contour": dec_contour,
            "increasing_contour": inc_contour,
            "lower_contour": lower,
            "higher_contour": higher,
        }

    points: list[dict[str, Any]] = []
    for row in trajectory_samples.itertuples(index=False):
        step_hour = int(row.step_hour)
        points.append(
            {
                "step_hour": step_hour,
                "valid_time": _fmt_utc(row.valid_time),
                "latitude": round(float(row.latitude), 5),
                "longitude": round(float(row.longitude), 5),
                "longitude_360": round(float(row.longitude_360), 5),
                "tcw_kg_m2": round(float(row.tcw_kg_m2), 4),
                "precip_mm": round(float(row.tp_mm), 4),
                "evap_mm_added": round(float(row.evap_mm_added), 4),
                "gph_m": round(float(row.gph_m), 3),
                "contours": contour_by_hour.get(step_hour, []),
                "final_extrema_contours": final_extrema_contours_by_hour.get(
                    step_hour, _empty_final_extrema_contours("none exist")
                ),
                "ghost_forward_advected_cells": ghost_forward_advected_cells_by_hour.get(
                    step_hour, []
                ),
            }
        )

    points_by_hour = {str(pt["step_hour"]): pt for pt in points}

    precip_sum = float(np.nansum(trajectory_samples["tp_mm"].to_numpy(dtype=float)))
    evap_sum = float(np.nansum(trajectory_samples["evap_mm_added"].to_numpy(dtype=float)))
    extrema_contours_any = int(
        sum(
            1
            for fc in final_extrema_contours_by_hour.values()
            if str(fc.get("status", "none")) != "none"
        )
    )
    extrema_contours_both = int(
        sum(1 for fc in final_extrema_contours_by_hour.values() if fc.get("status") == "ok")
    )

    contour_scale_min = (
        float(np.nanmin(contour_levels))
        if np.asarray(contour_levels, dtype=float).size
        else 560.0
    )
    contour_scale_max = (
        float(np.nanmax(contour_levels))
        if np.asarray(contour_levels, dtype=float).size
        else 940.0
    )
    contour_scale_mid = 0.5 * (contour_scale_min + contour_scale_max)

    payload = {
        "metadata": {
            "target_name": "Vancouver",
            "start_lat": float(start_lat),
            "start_lon": float(start_lon),
            "start_lon_360": float(start_lon) % 360.0,
            "requested_start_time": str(start_time),
            "resolved_start_time": _fmt_utc(trajectory_samples["valid_time"].iloc[0]),
            "pressure_level_hpa": int(pressure_level),
            "hours_back_requested": int(hours_back),
            "hours_back_actual": int(max(pt["step_hour"] for pt in points)),
            "substeps": int(substeps),
            "contour_levels_m": [float(x) for x in contour_levels],
            "max_contour_distance_deg": float(max_contour_distance_deg),
            "ghost_forward_hours": int(GHOST_FORWARD_HOURS),
            "ghost_substeps_per_hour": int(GHOST_SUBSTEPS_PER_HOUR),
            "ghost_advection_method": (
                "direction from nearest contour tangent (aligned with local wind), "
                "speed from local |u,v| at fixed frame hour"
            ),
            "final_extrema_contour_scale_m": {
                "min": contour_scale_min,
                "mid": contour_scale_mid,
                "max": contour_scale_max,
            },
            "generated_at_utc": _fmt_utc(pd.Timestamp.now(tz="UTC")),
        },
        "summary": {
            "point_count": int(len(points)),
            "tcw_min_kg_m2": round(float(np.nanmin(trajectory_samples["tcw_kg_m2"])), 4),
            "tcw_max_kg_m2": round(float(np.nanmax(trajectory_samples["tcw_kg_m2"])), 4),
            "gph_min_m": round(float(np.nanmin(trajectory_samples["gph_m"])), 3),
            "gph_max_m": round(float(np.nanmax(trajectory_samples["gph_m"])), 3),
            "precip_total_mm": round(precip_sum, 4),
            "evap_total_mm_added": round(evap_sum, 4),
            "extrema_contour_hours_with_any": extrema_contours_any,
            "extrema_contour_hours_with_both": extrema_contours_both,
        },
        "points": points,
        "points_by_hour": points_by_hour,
    }
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Export backward trajectory diagnostics + rectangle-clipped contour segments to a static JSON "
            "for a non-time-dependent frontend layer."
        )
    )
    parser.add_argument(
        "--era5-path",
        type=Path,
        default=Path("data/era5_2021-nov_250-500-925_uv_pv_gph.nc"),
        help="Path to ERA5 u/v/pv/gph NetCDF.",
    )
    parser.add_argument(
        "--accum-path",
        type=Path,
        default=Path("data/waterTransport-accum.nc"),
        help="Path to accumulated precipitation/evaporation NetCDF.",
    )
    parser.add_argument(
        "--instant-path",
        type=Path,
        default=Path("data/waterTransport-instant.nc"),
        help="Path to instantaneous total-column-water NetCDF.",
    )
    parser.add_argument(
        "--output-json",
        type=Path,
        default=Path("public/backward_trajectory/current.json"),
        help="Output JSON path in public/.",
    )
    parser.add_argument("--start-lat", type=float, default=49.28)
    parser.add_argument("--start-lon", type=float, default=-123.12)
    parser.add_argument("--start-time", type=str, default="2021-11-12T15:00:00")
    parser.add_argument("--pressure-level", type=int, default=925)
    parser.add_argument("--hours-back", type=int, default=72)
    parser.add_argument("--substeps", type=int, default=4)
    parser.add_argument("--contour-min-m", type=float, default=560.0)
    parser.add_argument("--contour-max-m", type=float, default=940.0)
    parser.add_argument("--contour-step-m", type=float, default=20.0)
    parser.add_argument("--max-contour-distance-deg", type=float, default=7.0)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    contour_levels = np.arange(
        args.contour_min_m,
        args.contour_max_m + 0.5 * args.contour_step_m,
        args.contour_step_m,
        dtype=float,
    )

    with xr.open_dataset(args.era5_path) as era5_ds:
        with xr.open_dataset(args.accum_path) as water_accum_ds:
            with xr.open_dataset(args.instant_path) as water_instant_ds:
                payload = build_export_payload(
                    era5_ds=era5_ds,
                    water_accum_ds=water_accum_ds,
                    water_instant_ds=water_instant_ds,
                    start_lat=args.start_lat,
                    start_lon=args.start_lon,
                    start_time=args.start_time,
                    pressure_level=args.pressure_level,
                    hours_back=args.hours_back,
                    substeps=args.substeps,
                    contour_levels=contour_levels,
                    max_contour_distance_deg=args.max_contour_distance_deg,
                )

    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    with args.output_json.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    print(f"Wrote: {args.output_json}")
    print(f"Points: {len(payload['points'])}")
    print(
        "Range:",
        payload["points"][-1]["valid_time"],
        "->",
        payload["points"][0]["valid_time"],
    )


if __name__ == "__main__":
    main()
