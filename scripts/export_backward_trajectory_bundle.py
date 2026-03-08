#!/usr/bin/env python3
"""Export backward trajectory diagnostics and nearby contour snippets to JSON."""

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
    earth_radius_m: float = 6_371_000.0,
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


def _bracketing_levels(levels: np.ndarray, value: float) -> np.ndarray:
    levels_arr = np.asarray(sorted(set(float(x) for x in levels)), dtype=float)
    if levels_arr.size == 0:
        return np.array([], dtype=float)

    v = float(value)
    chosen: list[float] = []

    below = levels_arr[levels_arr <= v]
    above = levels_arr[levels_arr >= v]

    if below.size:
        chosen.append(float(below.max()))
    if above.size:
        up = float(above.min())
        if (not chosen) or (up != chosen[0]):
            chosen.append(up)

    if len(chosen) < 2 and levels_arr.size >= 2:
        rem = [float(lv) for lv in levels_arr if float(lv) not in chosen]
        rem = sorted(rem, key=lambda lv: abs(lv - v))
        chosen.extend(rem[: 2 - len(chosen)])

    return np.array(chosen[:2], dtype=float)


def _point_xy(lon: float, lat: float, lon_scale: float) -> np.ndarray:
    return np.array([float(lon) * lon_scale, float(lat)], dtype=float)


def _halfplanes_for_selected_point(points_df: pd.DataFrame, idx: int):
    b_lon = float(points_df.at[idx, "longitude_360"])
    b_lat = float(points_df.at[idx, "latitude"])

    lon_scale = max(np.cos(np.deg2rad(b_lat)), 1e-6)
    b_xy = _point_xy(b_lon, b_lat, lon_scale)

    halfplanes = []

    if idx > 0:
        a_lon = float(points_df.at[idx - 1, "longitude_360"])
        a_lat = float(points_df.at[idx - 1, "latitude"])
        a_xy = _point_xy(a_lon, a_lat, lon_scale)

        mid = 0.5 * (a_xy + b_xy)
        normal = b_xy - a_xy
        halfplanes.append((mid, normal, lon_scale))

    if idx < len(points_df) - 1:
        c_lon = float(points_df.at[idx + 1, "longitude_360"])
        c_lat = float(points_df.at[idx + 1, "latitude"])
        c_xy = _point_xy(c_lon, c_lat, lon_scale)

        mid = 0.5 * (b_xy + c_xy)
        normal = b_xy - c_xy
        halfplanes.append((mid, normal, lon_scale))

    return halfplanes


def _signed_halfplane_distance(
    pt: np.ndarray, mid_xy: np.ndarray, normal_xy: np.ndarray, lon_scale: float
) -> float:
    p_xy = _point_xy(pt[0], pt[1], lon_scale)
    return float(np.dot(p_xy - mid_xy, normal_xy))


def _append_point_unique(container: list[list[float]], pt: np.ndarray, tol: float = 1e-12):
    if not container:
        container.append(pt.tolist())
        return
    prev = np.asarray(container[-1], dtype=float)
    if np.linalg.norm(prev - pt) > tol:
        container.append(pt.tolist())


def _clip_polyline_halfplane(
    polyline: np.ndarray, mid_xy: np.ndarray, normal_xy: np.ndarray, lon_scale: float
) -> list[np.ndarray]:
    if polyline.shape[0] < 2:
        return []

    pieces: list[np.ndarray] = []
    current: list[list[float]] = []

    for i in range(polyline.shape[0] - 1):
        p0 = polyline[i]
        p1 = polyline[i + 1]

        d0 = _signed_halfplane_distance(p0, mid_xy, normal_xy, lon_scale)
        d1 = _signed_halfplane_distance(p1, mid_xy, normal_xy, lon_scale)

        in0 = d0 >= 0.0
        in1 = d1 >= 0.0

        if in0 and not current:
            _append_point_unique(current, p0)

        if in0 and in1:
            if not current:
                _append_point_unique(current, p0)
            _append_point_unique(current, p1)
        elif in0 and not in1:
            denom = d0 - d1
            if abs(denom) > 1e-14:
                t = d0 / denom
                inter = p0 + t * (p1 - p0)
                if not current:
                    _append_point_unique(current, p0)
                _append_point_unique(current, inter)
            if len(current) >= 2:
                pieces.append(np.asarray(current, dtype=float))
            current = []
        elif (not in0) and in1:
            denom = d0 - d1
            if abs(denom) > 1e-14:
                t = d0 / denom
                inter = p0 + t * (p1 - p0)
                current = []
                _append_point_unique(current, inter)
                _append_point_unique(current, p1)
            else:
                current = []
                _append_point_unique(current, p1)
        else:
            if len(current) >= 2:
                pieces.append(np.asarray(current, dtype=float))
            current = []

    if len(current) >= 2:
        pieces.append(np.asarray(current, dtype=float))

    return pieces


def _clip_polyline_to_point_cell(polyline: np.ndarray, halfplanes) -> list[np.ndarray]:
    clipped = [polyline]
    for mid_xy, normal_xy, lon_scale in halfplanes:
        new_clipped: list[np.ndarray] = []
        for piece in clipped:
            new_clipped.extend(_clip_polyline_halfplane(piece, mid_xy, normal_xy, lon_scale))
        clipped = new_clipped
        if not clipped:
            break
    return clipped


def _nearest_piece_to_point(pieces: list[np.ndarray], lon: float, lat: float) -> np.ndarray | None:
    if not pieces:
        return None
    best_piece = None
    best_dist = np.inf
    for piece in pieces:
        d = np.sqrt((piece[:, 0] - lon) ** 2 + (piece[:, 1] - lat) ** 2)
        dmin = float(d.min())
        if dmin < best_dist:
            best_dist = dmin
            best_piece = piece
    return best_piece


def _nearest_segment_with_idx(
    segments: list[np.ndarray], lon: float, lat: float, max_dist_deg: float = 7.0
):
    best_idx = None
    best_seg = None
    best_dist = np.inf

    for i, seg in enumerate(segments):
        d = np.sqrt((seg[:, 0] - lon) ** 2 + (seg[:, 1] - lat) ** 2)
        min_dist = float(d.min())
        if min_dist < best_dist:
            best_dist = min_dist
            best_seg = seg
            best_idx = i

    if best_seg is None or best_dist > max_dist_deg:
        return None, None, float(best_dist)
    return best_idx, best_seg, float(best_dist)


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


def _round_point_pairs(arr: np.ndarray, ndigits: int = 4) -> list[list[float]]:
    out: list[list[float]] = []
    for lon, lat in arr:
        out.append([round(float(lon), ndigits), round(float(lat), ndigits)])
    return out


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
    contour_lat_min = max(-90.0, float(trajectory_samples["latitude"].min()) - contour_lat_pad)
    contour_lat_max = min(90.0, float(trajectory_samples["latitude"].max()) + contour_lat_pad)
    contour_lon_min = max(0.0, float(trajectory_samples["longitude_360"].min()) - contour_lon_pad)
    contour_lon_max = min(359.75, float(trajectory_samples["longitude_360"].max()) + contour_lon_pad)

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

    for idx, row in tqdm(
        selected_points.iterrows(),
        total=len(selected_points),
        desc="Clipping local contour snippets",
        unit="point",
    ):
        t_key = _nearest_hour_timestamp(row["valid_time"])
        contour_dict = gph_hourly_contours.get(t_key)
        if contour_dict is None:
            contour_by_hour[int(row["step_hour"])] = []
            continue

        local_gph = gph_hourly_925_m.interp(
            valid_time=np.datetime64(t_key),
            latitude=float(row["latitude"]),
            longitude=float(row["longitude_360"]),
            kwargs={"bounds_error": False, "fill_value": None},
        )
        local_gph_val = float(local_gph.values)
        nearby_levels = _bracketing_levels(contour_levels, local_gph_val)
        halfplanes = _halfplanes_for_selected_point(selected_points, idx)

        snippets: list[dict[str, Any]] = []
        for lev in nearby_levels:
            segs = contour_dict.get(float(lev), [])
            if not segs:
                continue

            seg_idx, seg, min_dist = _nearest_segment_with_idx(
                segs,
                float(row["longitude_360"]),
                float(row["latitude"]),
                max_dist_deg=max_contour_distance_deg,
            )
            if seg is None:
                continue

            clipped_pieces = _clip_polyline_to_point_cell(seg, halfplanes)
            clipped_seg = _nearest_piece_to_point(
                clipped_pieces,
                float(row["longitude_360"]),
                float(row["latitude"]),
            )
            if clipped_seg is None:
                continue

            snippets.append(
                {
                    "level_m": round(float(lev), 3),
                    "segment_index": int(seg_idx),
                    "min_distance_deg": round(float(min_dist), 4),
                    "points": _round_point_pairs(clipped_seg, ndigits=4),
                }
            )

        contour_by_hour[int(row["step_hour"])] = snippets

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
            }
        )

    points_by_hour = {str(pt["step_hour"]): pt for pt in points}

    precip_sum = float(np.nansum(trajectory_samples["tp_mm"].to_numpy(dtype=float)))
    evap_sum = float(np.nansum(trajectory_samples["evap_mm_added"].to_numpy(dtype=float)))

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
        },
        "points": points,
        "points_by_hour": points_by_hour,
    }
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Export backward trajectory diagnostics + nearby contour snippets to a static JSON "
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
