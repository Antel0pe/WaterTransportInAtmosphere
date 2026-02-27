# save as: export_uv_rgb.py
import os
import numpy as np
import xarray as xr
import imageio.v2 as imageio
from tqdm import tqdm

# ----------------------------
# Inputs / options
# ----------------------------
IN_PATH = "../data/era5_2021-nov_250-500-925_uv_pv_gph.nc"

# Base output directory. Actual output will be:
#   OUT_DIR_BASE/<PRESSURE_LEVEL>hpa/*.png
OUT_DIR_BASE = "../data/wind-uv-rg"

# Pick one of the levels present in the file (e.g. 250, 500, 925)
PRESSURE_LEVEL = 925  # hPa

# Used only if we can't infer a good time block size from dask chunking
TIME_BLOCK_FALLBACK = 244

# If True: roll longitude by half the width (useful when lon is 0..360 and you want -180..180-ish)
DO_LON_HALF_ROLL = True


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

def pick_u_var(ds):
    for name in ["u", "u_component_of_wind", "UGRD", "U", "ua"]:
        if name in ds.data_vars:
            return name
    raise KeyError(f"Couldn't find a u-wind var in data_vars={list(ds.data_vars)}")

def pick_v_var(ds):
    for name in ["v", "v_component_of_wind", "VGRD", "V", "va"]:
        if name in ds.data_vars:
            return name
    raise KeyError(f"Couldn't find a v-wind var in data_vars={list(ds.data_vars)}")


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
# Display scaling
# ----------------------------
def default_uv_range_for_level_hpa(level_hpa):
    level_hpa = float(level_hpa)
    if level_hpa <= 300:
        return -100.0, 100.0
    if level_hpa <= 600:
        return -80.0, 80.0
    return -40.0, 40.0

def to_u8_da(x, uv_min, uv_max):
    scale = 255.0 / (uv_max - uv_min)
    y = (x - uv_min) * scale
    y = y.clip(0.0, 255.0)
    return y.astype(np.uint8)

def infer_time_block_from_chunks(ds, t_name, u_name):
    try:
        ch = ds[u_name].chunks
        if ch is None:
            return TIME_BLOCK_FALLBACK
        dim_i = ds[u_name].dims.index(t_name)
        return int(ch[dim_i][0])
    except Exception:
        return TIME_BLOCK_FALLBACK


def main():
    out_dir = os.path.join(OUT_DIR_BASE, f"{int(PRESSURE_LEVEL)}")
    os.makedirs(out_dir, exist_ok=True)

    ds = xr.open_dataset(IN_PATH, chunks="auto")

    t_name   = pick_time_coord(ds)
    lon_name = pick_lon_name(ds)
    lat_name = pick_lat_name(ds)
    lev_name = pick_level_name(ds)

    u_name = pick_u_var(ds)
    v_name = pick_v_var(ds)

    times = ds[t_name].values
    n = int(times.shape[0])

    lev_vals = ds[lev_name].values
    lev_pick = ensure_level_value(lev_vals, PRESSURE_LEVEL)

    uv_min, uv_max = default_uv_range_for_level_hpa(PRESSURE_LEVEL)

    half = ds.sizes[lon_name] // 2
    time_block = infer_time_block_from_chunks(ds, t_name, u_name)

    print("IN_PATH:", IN_PATH)
    print("OUT_DIR:", out_dir)
    print("vars:", {"u": u_name, "v": v_name})
    print("coords:", {"time": t_name, "level": lev_name, "lat": lat_name, "lon": lon_name})
    print("requested PRESSURE_LEVEL (hPa):", float(PRESSURE_LEVEL))
    print("picked level coord value (file units):", lev_pick)
    print("display scaling (m/s):", {"min": uv_min, "max": uv_max})
    print("chunks u:", getattr(ds[u_name], "chunks", None))
    print("TIME_BLOCK:", time_block)
    print("DO_LON_HALF_ROLL:", DO_LON_HALF_ROLL, "| lon half-roll:", half)

    for t0 in tqdm(range(0, n, time_block), desc="time blocks"):
        t1 = min(t0 + time_block, n)
        tsel = slice(t0, t1)

        u_blk = ds[u_name].isel({t_name: tsel}).sel({lev_name: lev_pick})
        v_blk = ds[v_name].isel({t_name: tsel}).sel({lev_name: lev_pick})

        if DO_LON_HALF_ROLL:
            u_blk = u_blk.roll({lon_name: -half}, roll_coords=False)
            v_blk = v_blk.roll({lon_name: -half}, roll_coords=False)

        r_da = to_u8_da(u_blk, uv_min, uv_max)           # u -> R
        g_da = to_u8_da(v_blk, uv_min, uv_max)           # v -> G
        b_da = xr.zeros_like(r_da, dtype=np.uint8)       # B -> 0

        rgb_da = xr.concat([r_da, g_da, b_da], dim="channel").transpose(
            t_name, lat_name, lon_name, "channel"
        )

        rgb_blk = np.asarray(rgb_da.data)  # compute this time-block once

        for j in range(t1 - t0):
            i = t0 + j
            ts64 = times[i]
            ts_str = np.datetime_as_string(ts64, unit="s").replace(":", "-")
            out_path = os.path.join(out_dir, f"{ts_str}.png")
            imageio.imwrite(out_path, rgb_blk[j])

if __name__ == "__main__":
    main()