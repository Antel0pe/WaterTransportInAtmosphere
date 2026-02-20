import os
import numpy as np
import xarray as xr
import imageio.v2 as imageio
from tqdm import tqdm

IN_PATH = "../data/specifichumidity_wind_1000-925hpa_2026-02-19.nc"
OUT_DIR = "../data/ivt-925-1000"
TIME_BLOCK = 244

# Display scaling for q * |V| (not pressure-integrated IVT)
QSPD_MIN, QSPD_MAX = 0.0, 0.8
QSPD_SCALE = 255.0 / (QSPD_MAX - QSPD_MIN)

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

def pick_q_var(ds):
    for name in ["q", "specific_humidity", "spfh", "QV", "Q", "hus"]:
        if name in ds.data_vars:
            return name
    raise KeyError(f"Couldn't find a specific humidity var in {list(ds.data_vars)}")

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
    # Exact match, else nearest
    if target_hpa in level_vals:
        return target_hpa
    level_vals = np.asarray(level_vals)
    idx = int(np.argmin(np.abs(level_vals - target_hpa)))
    return float(level_vals[idx])

def to_u8_da(x):
    """
    x: xarray DataArray (float)
    returns: xarray DataArray uint8, clipped to [0,255]
    """
    y = (x - QSPD_MIN) * QSPD_SCALE
    y = y.clip(0.0, 255.0)
    return y.astype(np.uint8)

def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # Let xarray use dask when possible (keeps ops like roll lazy).
    # "auto" usually respects on-disk chunking when present.
    ds = xr.open_dataset(IN_PATH, chunks="auto")

    t_name   = pick_time_coord(ds)
    lon_name = pick_lon_name(ds)
    lat_name = pick_lat_name(ds)
    lev_name = pick_level_name(ds)

    q_name = pick_q_var(ds)
    u_name = pick_u_var(ds)
    v_name = pick_v_var(ds)

    times = ds[t_name].values
    n = times.shape[0]

    # Your “half-roll” convention (align globe texture)
    half = ds.sizes[lon_name] // 2

    lev_vals = ds[lev_name].values
    lev_1000 = ensure_level_value(lev_vals, 1000)
    lev_925  = ensure_level_value(lev_vals, 925)

    print("vars:", {"q": q_name, "u": u_name, "v": v_name})
    print("coords:", {"time": t_name, "level": lev_name, "lat": lat_name, "lon": lon_name})
    print("picked levels:", {"1000": lev_1000, "925": lev_925})
    print("display scaling:", {"min": QSPD_MIN, "max": QSPD_MAX})

    # --- Process in time blocks ---
    for t0 in tqdm(range(0, n, TIME_BLOCK), desc="time blocks"):
        t1 = min(t0 + TIME_BLOCK, n)
        tsel = slice(t0, t1)

        # Slice the time block lazily
        q_blk = ds[q_name].isel({t_name: tsel})
        u_blk = ds[u_name].isel({t_name: tsel})
        v_blk = ds[v_name].isel({t_name: tsel})

        # Longitude wrap lazily (avoids eager huge np.roll copies)
        # roll_coords=False keeps lon coordinate values unchanged (just shifts data)
        q_blk = q_blk.roll({lon_name: -half}, roll_coords=False)
        u_blk = u_blk.roll({lon_name: -half}, roll_coords=False)
        v_blk = v_blk.roll({lon_name: -half}, roll_coords=False)

        # Select levels (even if file only has these, this keeps the pipeline explicit)
        q_1000 = q_blk.sel({lev_name: lev_1000})
        u_1000 = u_blk.sel({lev_name: lev_1000})
        v_1000 = v_blk.sel({lev_name: lev_1000})

        q_925  = q_blk.sel({lev_name: lev_925})
        u_925  = u_blk.sel({lev_name: lev_925})
        v_925  = v_blk.sel({lev_name: lev_925})

        # Compute q*|V| (still lazy)
        spd_1000 = xr.apply_ufunc(np.hypot, u_1000, v_1000, dask="allowed")
        spd_925  = xr.apply_ufunc(np.hypot, u_925,  v_925,  dask="allowed")

        ivt_1000 = q_1000 * spd_1000  # R
        ivt_925  = q_925  * spd_925   # B

        # Map to uint8 (lazy)
        r_da = to_u8_da(ivt_1000)
        b_da = to_u8_da(ivt_925)

        # Make RGB (lazy). Ensure dims order: [time, lat, lon, channel]
        # We'll build an array with a new "channel" dim.
        g_da = xr.zeros_like(r_da, dtype=np.uint8)
        rgb_da = xr.concat([r_da, g_da, b_da], dim="channel").transpose(t_name, lat_name, lon_name, "channel")

        # Materialize the whole block ONCE (this is the main speed win)
        rgb_blk = rgb_da.data  # dask array or numpy
        rgb_blk = np.asarray(rgb_blk)  # triggers compute if dask

        # Write PNGs for this block
        for j in range(t1 - t0):
            i = t0 + j
            ts64 = times[i]
            ts_str = np.datetime_as_string(ts64, unit="s").replace(":", "-")
            out_path = os.path.join(OUT_DIR, f"{ts_str}.png")
            imageio.imwrite(out_path, rgb_blk[j])

if __name__ == "__main__":
    main()
