# save as: export_msl_contours.py
import json
from pathlib import Path

import numpy as np
import xarray as xr
from tqdm import tqdm
from skimage.measure import find_contours

DATA_DIR = Path("../data")
IN_NAME = "msl_2021novdec.nc"
OUT_DIR = DATA_DIR / "msl_contours"

TIME_BLOCK = 183  # matches on-disk chunking: (183, 91, 180)


def iso_filename(t64: np.datetime64) -> str:
    s = np.datetime_as_string(t64, unit="s")
    return s.replace(":", "-") + ".json"


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


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    ds = xr.open_dataset(DATA_DIR / IN_NAME)

    if "valid_time" in ds.coords:
        tcoord = "valid_time"
    elif "time" in ds.coords:
        tcoord = "time"
    else:
        raise KeyError(f"No 'valid_time' or 'time' coord. Coords: {list(ds.coords)}")

    if "msl" not in ds.data_vars:
        raise KeyError(f"No 'msl' var. Data vars: {list(ds.data_vars)}")

    if "latitude" not in ds.coords or "longitude" not in ds.coords:
        raise KeyError(f"Need 'latitude' and 'longitude' coords. Coords: {list(ds.coords)}")

    lon_raw = ds["longitude"].values
    lat = ds["latitude"].values.astype(np.float64)

    lon = wrap_lon_to_180(lon_raw)
    lon_order = np.argsort(lon)
    lon_sorted = lon[lon_order].astype(np.float64)

    ny = lat.size
    nx = lon_sorted.size
    x_idx = np.arange(nx, dtype=np.float64)
    y_idx = np.arange(ny, dtype=np.float64)

    times = ds[tcoord].values
    n = int(times.shape[0])

    msl_var = ds["msl"]

    for t0 in tqdm(range(0, n, TIME_BLOCK), desc="time blocks"):
        t1 = min(t0 + TIME_BLOCK, n)

        # Load a whole time chunk at once (best I/O pattern for this file)
        msl_blk = msl_var.isel({tcoord: slice(t0, t1)}).values  # (tb, lat, lon) in Pa

        # reorder longitude axis ONCE for the whole block
        msl_blk = msl_blk[:, :, lon_order]

        for j in range(t1 - t0):
            i = t0 + j
            t64 = times[i]
            tstamp = np.datetime_as_string(t64, unit="s")

            msl_pa = msl_blk[j]  # (lat, lon), Pa

            # contour levels in Pa (4 hPa == 400 Pa)
            vmin_pa = float(np.nanmin(msl_pa))
            vmax_pa = float(np.nanmax(msl_pa))
            step_pa = 400.0

            levels_pa = np.arange(
                np.floor(vmin_pa / step_pa) * step_pa,
                np.ceil(vmax_pa / step_pa) * step_pa + step_pa,
                step_pa,
                dtype=np.float32,
            )

            out_levels = {}

            for lvl_pa in levels_pa:
                lvl_key = f"{(float(lvl_pa) / 100.0):.1f}"  # store as hPa string, e.g. "944.0"

                contours = find_contours(msl_pa, level=float(lvl_pa))
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
                "contour_step_hpa": 4.0,
                "levels": out_levels,
            }

            out_path = OUT_DIR / iso_filename(np.datetime64(t64))
            with out_path.open("w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
