import os
import numpy as np
import xarray as xr
import imageio.v2 as imageio
from tqdm import tqdm

INSTANT_PATH = "../data/waterTransport-accum.nc"
CLIM_PATH    = "../data/averageEvaporation.nc"
OUT_DIR      = "../data/evap_rgb_instant_clim_anom"

TIME_BLOCK = 183

# ----------------------------
# FIXED, PHYSICALLY-MOTIVATED SCALING (meters of water equivalent)
# ----------------------------
# ERA5 convention: downward flux positive -> evaporation is NEGATIVE.
# We flip sign for display so:
#   - more evaporation (more negative) => brighter
#
# R: hourly-step evaporation amount (m per hour-step), displayed as -e
# G: monthly averaged reanalysis baseline (1-day accumulation period) converted to per-hour, displayed as -e
# B: anomaly relative to baseline, displayed so positive => "more evap than baseline"
#
# Display ranges are in "positive evap" units after flipping (i.e., -e).
INST_MIN, INST_MAX = 0.0, 1.0e-3      # 0..1 mm per hour-step
CLIM_MIN, CLIM_MAX = 0.0, 1.0e-3      # 0..1 mm per hour baseline
ANOM_MIN, ANOM_MAX = -5.0e-4, 5.0e-4  # +/-0.5 mm per hour anomaly

INST_SCALE = 255.0 / (INST_MAX - INST_MIN)
CLIM_SCALE = 255.0 / (CLIM_MAX - CLIM_MIN)
ANOM_SCALE = 255.0 / (ANOM_MAX - ANOM_MIN)

def to_u8_fast(x, vmin, scale):
    y = (x - vmin) * scale
    np.clip(y, 0.0, 255.0, out=y)
    return y.astype(np.uint8)

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

def pick_evap_var(ds):
    for name in ["e", "evap", "evaporation", "averageEvaporation", "avg_evaporation", "evspsbl", "EVAP", "E"]:
        if name in ds.data_vars:
            return name
    raise KeyError(f"Couldn't find an evap-like var in {list(ds.data_vars)}")

def month_from_ts(ts64):
    ts_day = np.datetime_as_string(ts64, unit="D")
    return int(ts_day[5:7])

def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    ds_inst = xr.open_dataset(INSTANT_PATH)
    ds_clim = xr.open_dataset(CLIM_PATH)

    t_inst_name = pick_time_coord(ds_inst)
    t_clim_name = pick_time_coord(ds_clim)

    evap_inst_name = pick_evap_var(ds_inst)
    evap_clim_name = pick_evap_var(ds_clim)

    evap_inst = ds_inst[evap_inst_name]
    times = ds_inst[t_inst_name].values
    n = times.shape[0]

    lon_name = pick_lon_name(ds_inst)
    half = ds_inst.sizes[lon_name] // 2

    # --- Monthly climatology by month (mean over years) ---
    # Per ERA5 docs: for "monthly averaged reanalysis", evaporation accumulation period is 1 day.
    # So this file is effectively (m/day) averaged over the month.
    evap_clim = ds_clim[evap_clim_name]
    tcoord    = ds_clim[t_clim_name]

    clim_month = evap_clim.groupby(tcoord.dt.month).mean(t_clim_name, skipna=True)

    clim_nov_day = clim_month.sel(month=11).roll({lon_name: -half}, roll_coords=True).values
    clim_dec_day = clim_month.sel(month=12).roll({lon_name: -half}, roll_coords=True).values

    # Convert daily accumulation baseline -> per-hour baseline
    clim_nov_per_hour = clim_nov_day / 24.0
    clim_dec_per_hour = clim_dec_day / 24.0

    # Determine lon axis for instant blocks
    inst_dims = list(evap_inst.dims)
    if lon_name not in inst_dims:
        raise KeyError(f"Instant evap var dims {inst_dims} do not include lon '{lon_name}'")
    lon_axis = inst_dims.index(lon_name)

    print("inst var:", evap_inst_name, "units:", evap_inst.attrs.get("units"))
    print("clim var:", evap_clim_name, "units:", evap_clim.attrs.get("units"))
    print("SCALING (fixed, display-flipped):")
    print("  INST_MIN/MAX:", INST_MIN, INST_MAX)
    print("  CLIM_MIN/MAX:", CLIM_MIN, CLIM_MAX, "(per-hour baseline)")
    print("  ANOM_MIN/MAX:", ANOM_MIN, ANOM_MAX)

    # --- Process in time blocks ---
    for t0 in tqdm(range(0, n, TIME_BLOCK), desc="time blocks"):
        t1 = min(t0 + TIME_BLOCK, n)

        inst_blk = evap_inst.isel({t_inst_name: slice(t0, t1)}).values
        inst_blk = np.roll(inst_blk, shift=-half, axis=lon_axis)

        for j in range(t1 - t0):
            i = t0 + j
            ts64 = times[i]
            inst = inst_blk[j]

            m = month_from_ts(ts64)
            if m == 11:
                clim_ph = clim_nov_per_hour
            elif m == 12:
                clim_ph = clim_dec_per_hour
            else:
                continue

            anom = inst - clim_ph

            # Flip sign for display (evap is negative):
            inst_disp = -inst
            clim_disp = -clim_ph
            # Positive anomaly display => "more evap than baseline":
            # inst more negative than baseline => inst - baseline is negative => flip to positive
            anom_disp = -(anom)

            r = to_u8_fast(inst_disp, INST_MIN, INST_SCALE)
            g = to_u8_fast(clim_disp, CLIM_MIN, CLIM_SCALE)
            b = to_u8_fast(anom_disp, ANOM_MIN, ANOM_SCALE)

            rgb = np.stack([r, g, b], axis=-1)

            ts_str = np.datetime_as_string(ts64, unit="s").replace(":", "-")
            out_path = os.path.join(OUT_DIR, f"{ts_str}.png")
            imageio.imwrite(out_path, rgb)

if __name__ == "__main__":
    main()
