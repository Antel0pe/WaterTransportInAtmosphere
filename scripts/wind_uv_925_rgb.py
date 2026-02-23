# save as: export_uv_925_rgb.py
import os
import numpy as np
import xarray as xr
import imageio.v2 as imageio
from tqdm import tqdm

IN_PATH = "../data/specifichumidity_wind_1000-925hpa_2026-02-19.nc"
OUT_DIR = "../data/wind-uv-925-rg"
TIME_BLOCK_FALLBACK = 244  # used only if we can't infer from chunking

TARGET_HPA = 925.0

# Display scaling (applied to both u and v)
# Values outside [MIN, MAX] get clipped, then mapped to [0,255]
UV_MIN, UV_MAX = -40.0, 40.0
UV_SCALE = 255.0 / (UV_MAX - UV_MIN)

def pick_time_coord(ds):
    for name in ["valid_time", "time", "datetime", "date"]:
        if name in ds.coords:
            return name
    raise KeyError(f"Couldn't find a time coord in {list(ds.coords)}")

def pick_lon_name(ds):
    for name in ["longitude", "lon", "LONGITUDE", "x"]:
        if name in ds.coords or name in ds.dims:
            return name
    raise KeyError(f"Couldn't find a longitude coord/dim in {list(ds.coords)} / {list(ds.dims)}")

def pick_lat_name(ds):
    for name in ["latitude", "lat", "LATITUDE", "y"]:
        if name in ds.coords or name in ds.dims:
            return name
    raise KeyError(f"Couldn't find a latitude coord/dim in {list(ds.coords)} / {list(ds.dims)}")

def pick_level_name(ds):
    for name in ["level", "pressure_level", "isobaricInhPa", "plev", "lev"]:
        if name in ds.coords or name in ds.dims:
            return name
    raise KeyError(f"Couldn't find a level coord/dim in {list(ds.coords)}")

def pick_u_var(ds):
    for name in ["u", "u10", "u_component_of_wind", "UGRD", "U", "ua"]:
        if name in ds.data_vars:
            return name
    raise KeyError(f"Couldn't find a u-wind var in {list(ds.data_vars)}")

def pick_v_var(ds):
    for name in ["v", "v10", "v_component_of_wind", "VGRD", "V", "va"]:
        if name in ds.data_vars:
            return name
    raise KeyError(f"Couldn't find a v-wind var in {list(ds.data_vars)}")

def ensure_level_value(level_vals, target_hpa):
    if target_hpa in level_vals:
        return float(target_hpa)
    level_vals = np.asarray(level_vals, dtype=np.float64)
    idx = int(np.argmin(np.abs(level_vals - target_hpa)))
    return float(level_vals[idx])

def to_u8_da(x):
    """
    x: xarray DataArray (float)
    returns: xarray DataArray uint8, clipped to [0,255]
    """
    y = (x - UV_MIN) * UV_SCALE
    y = y.clip(0.0, 255.0)
    return y.astype(np.uint8)

def infer_time_block_from_chunks(ds, t_name, u_name):
    try:
        ch = ds[u_name].chunks  # tuple-of-tuples or None
        if ch is None:
            return TIME_BLOCK_FALLBACK
        dim_i = ds[u_name].dims.index(t_name)
        return int(ch[dim_i][0])
    except Exception:
        return TIME_BLOCK_FALLBACK

def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    ds = xr.open_dataset(IN_PATH, chunks="auto")

    t_name   = pick_time_coord(ds)
    lon_name = pick_lon_name(ds)
    lat_name = pick_lat_name(ds)
    lev_name = pick_level_name(ds)

    u_name = pick_u_var(ds)
    v_name = pick_v_var(ds)

    times = ds[t_name].values
    n = times.shape[0]

    lev_vals = ds[lev_name].values
    lev_925 = ensure_level_value(lev_vals, TARGET_HPA)

    # half-roll convention (efficient/lazy under dask)
    half = ds.sizes[lon_name] // 2

    time_block = infer_time_block_from_chunks(ds, t_name, u_name)

    print("vars:", {"u": u_name, "v": v_name})
    print("coords:", {"time": t_name, "level": lev_name, "lat": lat_name, "lon": lon_name})
    print("picked level:", lev_925)
    print("display scaling:", {"min": UV_MIN, "max": UV_MAX})
    print("chunks u:", getattr(ds[u_name], "chunks", None))
    print("TIME_BLOCK:", time_block)
    print("lon half-roll:", half)

    for t0 in tqdm(range(0, n, time_block), desc="time blocks"):
        t1 = min(t0 + time_block, n)
        tsel = slice(t0, t1)

        # slice time + select level (lazy)
        u_blk = ds[u_name].isel({t_name: tsel}).sel({lev_name: lev_925})
        v_blk = ds[v_name].isel({t_name: tsel}).sel({lev_name: lev_925})

        # efficient/lazy lon roll
        u_blk = u_blk.roll({lon_name: -half}, roll_coords=False)
        v_blk = v_blk.roll({lon_name: -half}, roll_coords=False)

        # map to uint8 (lazy)
        r_da = to_u8_da(u_blk)  # u -> R
        g_da = to_u8_da(v_blk)  # v -> G
        b_da = xr.zeros_like(r_da, dtype=np.uint8)  # B = 0

        rgb_da = xr.concat([r_da, g_da, b_da], dim="channel").transpose(
            t_name, lat_name, lon_name, "channel"
        )

        rgb_blk = np.asarray(rgb_da.data)  # compute block once

        for j in range(t1 - t0):
            i = t0 + j
            ts64 = times[i]
            ts_str = np.datetime_as_string(ts64, unit="s").replace(":", "-")
            out_path = os.path.join(OUT_DIR, f"{ts_str}.png")
            imageio.imwrite(out_path, rgb_blk[j])

if __name__ == "__main__":
    main()