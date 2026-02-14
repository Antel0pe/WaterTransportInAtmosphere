import os
import numpy as np
import xarray as xr
import imageio.v2 as imageio
from tqdm import tqdm

INSTANT_PATH = "../data/waterTransport-instant.nc"
CLIM_PATH    = "../data/tcw_1981_2020_mean.nc"
OUT_DIR      = "../data/tcw_rgb_instant_clim_anom"

# Red channel scaling (instant tcw)
TCW_MIN, TCW_MAX = 0.0, 110.0
TCW_SCALE = 255.0 / (TCW_MAX - TCW_MIN)

# Blue channel scaling (anomaly = instant - clim)
# NOTE: tweak these if you want more/less contrast in anomalies.
ANOM_MIN, ANOM_MAX = -50.0, 50.0
ANOM_SCALE = 255.0 / (ANOM_MAX - ANOM_MIN)

TIME_BLOCK = 183  # matches your stored chunking

def to_u8_fast(x, vmin, scale):
    y = (x - vmin) * scale
    np.clip(y, 0.0, 255.0, out=y)
    return y.astype(np.uint8)

def pick_time_coord(ds):
    for name in ["valid_time", "time", "datetime", "date"]:
        if name in ds.coords:
            return name
    raise KeyError(f"Couldn't find a time coord in {list(ds.coords)}")

def pick_tcw_var(ds):
    for name in ["tcw", "TCW", "tcolw", "total_column_water"]:
        if name in ds.data_vars:
            return name
    raise KeyError(f"Couldn't find a tcw-like var in {list(ds.data_vars)}")

def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    ds_inst = xr.open_dataset(INSTANT_PATH)
    ds_clim = xr.open_dataset(CLIM_PATH)

    t_inst_name = pick_time_coord(ds_inst)
    t_clim_name = pick_time_coord(ds_clim)

    tcw_inst_name = pick_tcw_var(ds_inst)
    tcw_clim_name = pick_tcw_var(ds_clim)

    print('opened and picked')
    # Instant tcw and times
    tcw_inst = ds_inst[tcw_inst_name]
    times = ds_inst[t_inst_name].values
    n = times.shape[0]

    # Longitude roll to convert 0..360 -> -180..180 (match your prior behavior)
    half = ds_inst.sizes["longitude"] // 2

    # --- Build Nov/Dec monthly climatology (fast, correct for your file) ---
    tcw_clim = ds_clim[tcw_clim_name]
    tcoord   = ds_clim[t_clim_name]

    print('doing group by')
    # Mean across years for each calendar month (1..12), then pick 11 and 12
    clim_month = tcw_clim.groupby(tcoord.dt.month).mean(t_clim_name, skipna=True)

    print('selecting month')
    clim_nov = clim_month.sel(month=11)
    clim_dec = clim_month.sel(month=12)

    print('rolling')
    # Roll ONCE, properly, to match instant roll
    clim_nov = clim_nov.roll(longitude=-half, roll_coords=True)
    clim_dec = clim_dec.roll(longitude=-half, roll_coords=True)

    print('materializing array')
    # (optional) materialize as numpy to make per-frame super cheap
    clim_nov_np = clim_nov.values
    clim_dec_np = clim_dec.values

    # --- Process in time blocks ---
    for t0 in tqdm(range(0, n, TIME_BLOCK), desc="time blocks"):
        t1 = min(t0 + TIME_BLOCK, n)

        # Load instant tcw block -> numpy
        inst_blk = tcw_inst.isel({t_inst_name: slice(t0, t1)}).values
        inst_blk = np.roll(inst_blk, shift=-half, axis=2)  # axis=2 is longitude in your layout

        for j in range(t1 - t0):
            i = t0 + j
            ts64 = times[i]

            inst = inst_blk[j]  # (lat, lon)
            
            ts_day = np.datetime_as_string(ts64, unit="D")  # "YYYY-MM-DD"
            month = int(ts_day[5:7])
            if month == 11:
                clim = clim_nov_np
            elif month == 12:
                clim = clim_dec_np
            else:
                continue  # skip non-Nov/Dec if your instant file includes them

            anom = inst - clim

            r = to_u8_fast(inst, TCW_MIN,  TCW_SCALE)
            g = to_u8_fast(clim, TCW_MIN,  TCW_SCALE)
            b = to_u8_fast(anom, ANOM_MIN, ANOM_SCALE)

            rgb = np.stack([r, g, b], axis=-1)

            ts_str = np.datetime_as_string(ts64, unit="s").replace(":", "-")
            out_path = os.path.join(OUT_DIR, f"{ts_str}.png")
            imageio.imwrite(out_path, rgb)

if __name__ == "__main__":
    main()
