import os
import numpy as np
import xarray as xr
import imageio.v2 as imageio
from tqdm import tqdm

ACCUM_PATH   = "../data/waterTransport-accum.nc"
INSTANT_PATH = "../data/waterTransport-instant.nc"
OUT_DIR      = "../data/waterTransport-evap-precip-waterColumn"

TP_MIN,  TP_MAX   = 0.0, 0.02
EVAP_MIN,EVAP_MAX = 0.0, 0.003
TCW_MIN, TCW_MAX  = 0.0, 110.0

TP_SCALE   = 255.0 / (TP_MAX - TP_MIN)
EVAP_SCALE = 255.0 / (EVAP_MAX - EVAP_MIN)
TCW_SCALE  = 255.0 / (TCW_MAX - TCW_MIN)

TIME_BLOCK = 183  # matches stored chunking

def to_u8_fast(x, vmin, scale):
    y = (x - vmin) * scale
    np.clip(y, 0.0, 255.0, out=y)
    return y.astype(np.uint8)

def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    ds_accum   = xr.open_dataset(ACCUM_PATH)
    ds_instant = xr.open_dataset(INSTANT_PATH)

    times = ds_accum["valid_time"].values
    n = times.shape[0]

    half = ds_accum.sizes["longitude"] // 2  # 0..360 -> -180..180

    for t0 in tqdm(range(0, n, TIME_BLOCK), desc="time blocks"):
        t1 = min(t0 + TIME_BLOCK, n)

        tp_blk  = ds_accum["tp"].isel(valid_time=slice(t0, t1)).values
        e_blk   = ds_accum["e"].isel(valid_time=slice(t0, t1)).values
        tcw_blk = ds_instant["tcw"].isel(valid_time=slice(t0, t1)).values

        tp_blk  = np.roll(tp_blk,  shift=-half, axis=2)
        e_blk   = np.roll(e_blk,   shift=-half, axis=2)
        tcw_blk = np.roll(tcw_blk, shift=-half, axis=2)

        for j in range(t1 - t0):
            i = t0 + j

            tp  = tp_blk[j]
            e   = e_blk[j]
            tcw = tcw_blk[j]

            evap = np.maximum(-e, 0.0)

            r = to_u8_fast(tp,   TP_MIN,   TP_SCALE)
            g = to_u8_fast(evap, EVAP_MIN, EVAP_SCALE)
            b = to_u8_fast(tcw,  TCW_MIN,  TCW_SCALE)

            rgb = np.stack([r, g, b], axis=-1)

            ts = np.datetime_as_string(times[i], unit="s").replace(":", "-")
            out_path = os.path.join(OUT_DIR, f"{ts}.png")
            imageio.imwrite(out_path, rgb)

if __name__ == "__main__":
    main()
