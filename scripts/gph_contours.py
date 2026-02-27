# save as: export_gph_contours.py
import json
from pathlib import Path

import numpy as np
import xarray as xr
from tqdm import tqdm
from skimage.measure import find_contours

# ----------------------------
# Inputs / options
# ----------------------------
IN_PATH = Path("../data/era5_2021-nov_250-500-925_uv_pv_gph.nc")

# Base output directory. Actual output will be:
#   OUT_DIR_BASE/<PRESSURE_LEVEL>hpa/*.json
OUT_DIR_BASE = Path("../data/gph_contours")

# Pick one of the levels present in the file (e.g. 250, 500, 925)
PRESSURE_LEVEL = 250  # hPa

# Used only if we can't infer a good time block size from dask chunking
TIME_BLOCK_FALLBACK = 183

# If True: roll longitude by half the width (useful when lon is 0..360 and you want -180..180-ish)
DO_LON_HALF_ROLL = True

# ERA5 geopotential (z) is typically m^2/s^2; convert to geopotential height (m)
G0 = 9.80665

# contour spacing in meters of geopotential height
CONTOUR_STEP_M = 60.0


# ----------------------------
# Helpers: picking coords/vars
# ----------------------------
def pick_time_coord(ds):
    for name in ["valid_time", "time", "datetime", "date"]:
        if name in ds.coords or name in ds.dims:
            return name
    raise KeyError(f"Couldn't find a time coord in coords={list(ds.coords)} dims={list(ds.dims)}")

def pick_lon_name(ds):
    for name in ["longitude", "lon", "LONGITUDE", "x"]:
        if name in ds.coords or name in ds.dims:
            return name
    raise KeyError(f"Couldn't find a longitude coord/dim in coords={list(ds.coords)} dims={list(ds.dims)}")

def pick_lat_name(ds):
    for name in ["latitude", "lat", "LATITUDE", "y"]:
        if name in ds.coords or name in ds.dims:
            return name
    raise KeyError(f"Couldn't find a latitude coord/dim in coords={list(ds.coords)} dims={list(ds.dims)}")

def pick_level_name(ds):
    for name in ["pressure_level", "level", "isobaricInhPa", "plev", "lev"]:
        if name in ds.coords or name in ds.dims:
            return name
    raise KeyError(f"Couldn't find a level coord/dim in coords={list(ds.coords)} dims={list(ds.dims)}")

def pick_z_var(ds):
    for name in ["z", "geopotential", "Z"]:
        if name in ds.data_vars:
            return name
    raise KeyError(f"Couldn't find geopotential var in data_vars={list(ds.data_vars)}")


# ----------------------------
# Level handling (hPa vs Pa)
# ----------------------------
def level_values_in_hpa(level_vals):
    lv = np.asarray(level_vals, dtype=np.float64)
    if lv.size == 0:
        raise ValueError("Level coordinate is empty")
    med = float(np.median(lv))
    if med > 2000.0:
        return lv / 100.0, "pa"
    return lv, "hpa"

def ensure_level_value(level_vals, target_hpa):
    vals_hpa, mode = level_values_in_hpa(level_vals)
    target_hpa = float(target_hpa)
    idx = int(np.argmin(np.abs(vals_hpa - target_hpa)))
    picked_hpa = float(vals_hpa[idx])
    return float(picked_hpa * 100.0) if mode == "pa" else float(picked_hpa)


# ----------------------------
# Dateline helpers (same idea as your MSL script)
# ----------------------------
def wrap_lon_to_180(lon_1d: np.ndarray) -> np.ndarray:
    lon = np.asarray(lon_1d, dtype=np.float64)
    return ((lon + 180.0) % 360.0) - 180.0

def split_on_dateline_jumps(lons: np.ndarray, lats: np.ndarray, jump_deg: float = 180.0):
    lons = np.asarray(lons, dtype=np.float64)
    lats = np.asarray(lats, dtype=np.float64)
    if lons.size < 2:
        return []

    lons = np.round(lons, 1)
    lats = np.round(lats, 1)

    jumps = np.abs(np.diff(lons)) > jump_deg
    cut_idx = np.where(jumps)[0] + 1
    chunks = np.split(np.arange(lons.size), cut_idx)

    polylines = []
    for idx in chunks:
        if idx.size < 2:
            continue
        polylines.append(np.column_stack((lons[idx], lats[idx])).tolist())
    return polylines


# ----------------------------
# Chunk inference (robust)
# ----------------------------
def infer_time_block_from_chunks(ds, t_name, var_name):
    try:
        da = ds[var_name]

        chs = getattr(da, "chunksizes", None)
        if chs is not None and t_name in chs and len(chs[t_name]) > 0:
            return int(chs[t_name][0])

        ch = getattr(da, "chunks", None)
        if ch is not None:
            dim_i = da.dims.index(t_name)
            return int(ch[dim_i][0])

        dch = getattr(getattr(da, "data", None), "chunks", None)
        if dch is not None:
            dim_i = da.dims.index(t_name)
            return int(dch[dim_i][0])

    except Exception:
        pass

    return int(TIME_BLOCK_FALLBACK)


def main():
    out_dir = OUT_DIR_BASE / f"{int(PRESSURE_LEVEL)}"
    out_dir.mkdir(parents=True, exist_ok=True)

    ds = xr.open_dataset(IN_PATH, chunks="auto")

    t_name   = pick_time_coord(ds)
    lon_name = pick_lon_name(ds)
    lat_name = pick_lat_name(ds)
    lev_name = pick_level_name(ds)
    z_name   = pick_z_var(ds)

    times = ds[t_name].values
    n = int(times.shape[0])

    lev_vals = ds[lev_name].values
    lev_pick = ensure_level_value(lev_vals, PRESSURE_LEVEL)

    time_block = infer_time_block_from_chunks(ds, t_name, z_name)

    # longitude handling for contour conversion
    lon_raw = ds[lon_name].values
    lat = ds[lat_name].values.astype(np.float64)

    half = ds.sizes[lon_name] // 2

    # If you half-roll, your lon coords are still 0..360 but the *data* is rolled;
    # for coordinate interpolation, we build lon_sorted aligned to the rolled order.
    lon_wrapped = wrap_lon_to_180(lon_raw)
    lon_order = np.argsort(lon_wrapped)
    lon_sorted = lon_wrapped[lon_order].astype(np.float64)

    ny = lat.size
    nx = lon_sorted.size
    x_idx = np.arange(nx, dtype=np.float64)
    y_idx = np.arange(ny, dtype=np.float64)

    print("IN_PATH:", str(IN_PATH))
    print("OUT_DIR:", str(out_dir))
    print("var:", z_name)
    print("coords:", {"time": t_name, "level": lev_name, "lat": lat_name, "lon": lon_name})
    print("requested PRESSURE_LEVEL (hPa):", float(PRESSURE_LEVEL))
    print("picked level coord value (file units):", lev_pick)
    print("TIME_BLOCK:", time_block)
    print("DO_LON_HALF_ROLL:", DO_LON_HALF_ROLL, "| lon half-roll:", half)
    print("CONTOUR_STEP_M:", float(CONTOUR_STEP_M))

    # select the level once; then we chunk only over time
    z_lev = ds[z_name].sel({lev_name: lev_pick})

    for t0 in tqdm(range(0, n, time_block), desc="time blocks"):
        t1 = min(t0 + time_block, n)
        tsel = slice(t0, t1)

        z_blk = z_lev.isel({t_name: tsel})  # (tb, lat, lon)

        if DO_LON_HALF_ROLL:
            z_blk = z_blk.roll({lon_name: -half}, roll_coords=False)

        # compute this time-block once
        z_blk_np = np.asarray(z_blk.data).astype(np.float32)

        # Now: align longitudes to lon_sorted via a consistent ordering.
        # We take the rolled data, then reorder longitudes by lon_order (wrap+sort).
        z_blk_np = z_blk_np[:, :, lon_order]

        for j in range(t1 - t0):
            i = t0 + j
            ts64 = times[i]
            tstamp = np.datetime_as_string(ts64, unit="s")

            # geopotential -> geopotential height (m)
            gph_m = z_blk_np[j] / G0

            vmin = float(np.nanmin(gph_m))
            vmax = float(np.nanmax(gph_m))
            step = float(CONTOUR_STEP_M)

            levels_m = np.arange(
                np.floor(vmin / step) * step,
                np.ceil(vmax / step) * step + step,
                step,
                dtype=np.float32,
            )

            out_levels = {}

            for lvl_m in levels_m:
                lvl_key = f"{int(round(float(lvl_m)))}"
                contours = find_contours(gph_m, level=float(lvl_m))

                polylines = []
                for cont in contours:
                    if cont.shape[0] < 2:
                        continue

                    r = np.clip(cont[:, 0], 0.0, ny - 1.0)
                    c = np.clip(cont[:, 1], 0.0, nx - 1.0)

                    lonc = np.interp(c, x_idx, lon_sorted)
                    latc = np.interp(r, y_idx, lat)
                    lonc = wrap_lon_to_180(lonc)

                    polylines.extend(split_on_dateline_jumps(lonc, latc, jump_deg=180.0))

                out_levels[lvl_key] = polylines

            payload = {
                "timestamp": tstamp,
                "pressure_level_hpa": float(PRESSURE_LEVEL),
                "picked_level_coord_value": float(lev_pick),
                "contour_step_m": float(CONTOUR_STEP_M),
                "levels": out_levels,
                "field": "geopotential_height_m",
            }

            ts_str = np.datetime_as_string(ts64, unit="s").replace(":", "-")
            out_path = out_dir / f"{ts_str}.json"
            with out_path.open("w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)


if __name__ == "__main__":
    main()