#!/usr/bin/env python3
"""
TiTiler-based wind service for dynamic PNG and tiles from NetCDF.

This service keeps your current wind RGB contract:
- R channel: U wind mapped from [uv_min, uv_max]
- G channel: V wind mapped from [uv_min, uv_max]
- B channel: 0
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Literal

import numpy as np
import xarray as xr
from fastapi import FastAPI, HTTPException, Query, Response
from rio_tiler.models import ImageData
from titiler.core.resources.enums import ImageType
from titiler.core.utils import render_image
from titiler.xarray.factory import TilerFactory
from titiler.xarray.io import FsReader


DEFAULT_DATASET = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "era5_2021-nov_250-500-925_uv_pv_gph.nc"
)

ALLOWED_PRESSURES = {250, 500, 925}
TIME_COORD_CANDIDATES = ("valid_time", "time", "datetime", "date")
LEVEL_COORD_CANDIDATES = ("pressure_level", "level", "isobaricInhPa", "plev", "lev")


@dataclass(frozen=True)
class DatasetMeta:
    time_dim: str
    level_dim: str
    time_values: tuple[np.datetime64, ...]
    level_values: tuple[float, ...]


def default_uv_range_for_level_hpa(level_hpa: float) -> tuple[float, float]:
    level_hpa = float(level_hpa)
    if level_hpa <= 300.0:
        return -100.0, 100.0
    if level_hpa <= 600.0:
        return -80.0, 80.0
    return -40.0, 40.0


def level_values_in_hpa(level_vals: np.ndarray) -> tuple[np.ndarray, str]:
    arr = np.asarray(level_vals, dtype=np.float64)
    if arr.size == 0:
        raise ValueError("Pressure level coordinate is empty.")
    if float(np.median(arr)) > 2000.0:
        return arr / 100.0, "pa"
    return arr, "hpa"


def ensure_level_value(level_vals: np.ndarray, target_hpa: float) -> float:
    vals_hpa, mode = level_values_in_hpa(level_vals)
    idx = int(np.argmin(np.abs(vals_hpa - float(target_hpa))))
    picked_hpa = float(vals_hpa[idx])
    return picked_hpa * 100.0 if mode == "pa" else picked_hpa


def to_u8(data: np.ndarray, uv_min: float, uv_max: float) -> np.ndarray:
    scale = 255.0 / (uv_max - uv_min)
    out = (data - uv_min) * scale
    out = np.clip(out, 0.0, 255.0)
    return out.astype(np.uint8)


def parse_datehour_to_hour_iso(value: str) -> str:
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1]

    parsed: datetime | None = None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            parsed = datetime.strptime(raw, fmt)
            break
        except ValueError:
            continue

    if parsed is None:
        raise ValueError("datehour must be YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS")

    parsed = parsed.replace(tzinfo=timezone.utc, minute=0, second=0, microsecond=0)
    return parsed.strftime("%Y-%m-%dT%H:%M:%S")


@lru_cache(maxsize=16)
def inspect_dataset(path_str: str) -> DatasetMeta:
    path = Path(path_str)
    if not path.exists():
        raise FileNotFoundError(f"Dataset does not exist: {path}")

    try:
        ds = xr.open_dataset(path, engine="h5netcdf")
    except Exception:
        ds = xr.open_dataset(path)

    try:
        time_dim = next(
            name for name in TIME_COORD_CANDIDATES if name in ds.coords or name in ds.dims
        )
    except StopIteration as exc:
        raise ValueError("Unable to find a time coordinate in dataset.") from exc

    try:
        level_dim = next(
            name
            for name in LEVEL_COORD_CANDIDATES
            if name in ds.coords or name in ds.dims
        )
    except StopIteration as exc:
        raise ValueError("Unable to find a pressure level coordinate in dataset.") from exc

    times = tuple(np.asarray(ds[time_dim].values).astype("datetime64[s]"))
    levels = tuple(np.asarray(ds[level_dim].values, dtype=np.float64))
    return DatasetMeta(
        time_dim=time_dim,
        level_dim=level_dim,
        time_values=times,
        level_values=levels,
    )


def resolve_dataset_time(meta: DatasetMeta, datehour: str) -> str:
    target = np.datetime64(parse_datehour_to_hour_iso(datehour), "s")
    if target not in meta.time_values:
        first = str(meta.time_values[0]) if meta.time_values else "n/a"
        last = str(meta.time_values[-1]) if meta.time_values else "n/a"
        raise ValueError(
            f"Requested time {target} not found. Available range: {first} .. {last}"
        )
    return str(target)


def resolve_dataset_level(meta: DatasetMeta, pressure_level_hpa: int) -> float:
    return ensure_level_value(np.asarray(meta.level_values), pressure_level_hpa)


def build_sel(meta: DatasetMeta, datehour: str, pressure_level_hpa: int) -> list[str]:
    t_value = resolve_dataset_time(meta, datehour)
    p_value = resolve_dataset_level(meta, pressure_level_hpa)
    return [f"{meta.time_dim}={t_value}", f"{meta.level_dim}={p_value}"]


def dataset_url_or_default(url: str | None) -> str:
    if url is None or url.strip() == "":
        return str(DEFAULT_DATASET)
    return url


def validate_range(uv_min: float, uv_max: float) -> None:
    if not np.isfinite(uv_min) or not np.isfinite(uv_max):
        raise ValueError("uv_min and uv_max must be finite.")
    if uv_max <= uv_min:
        raise ValueError("uv_max must be > uv_min.")


def unroll_to_0_360(arr: np.ndarray, x_coords: np.ndarray) -> np.ndarray:
    order = np.argsort((x_coords + 360.0) % 360.0)
    return arr[:, order]


def encode_wind_rgb(u_np: np.ndarray, v_np: np.ndarray, uv_min: float, uv_max: float) -> np.ndarray:
    r = to_u8(u_np, uv_min, uv_max)
    g = to_u8(v_np, uv_min, uv_max)
    b = np.zeros_like(r, dtype=np.uint8)
    return np.stack((r, g, b), axis=0)


def to_uint8_mask(mask_like: np.ndarray) -> np.ndarray:
    raw = np.ma.filled(mask_like, fill_value=0)
    raw = np.asarray(raw)
    if np.issubdtype(raw.dtype, np.floating):
        valid = np.isfinite(raw) & (raw > 0)
        return valid.astype(np.uint8) * 255
    return (raw > 0).astype(np.uint8) * 255


def image_response_from_rgb(rgb_bands: np.ndarray) -> Response:
    img = ImageData(rgb_bands, band_names=["u", "v", "zero"])
    body, media = render_image(img, output_format=ImageType.png, add_mask=False)
    return Response(content=body, media_type=media)


app = FastAPI(title="Wind TiTiler Service", version="0.1.0")

# Generic xarray tiler endpoints:
# /xarray/tiles/{tileMatrixSetId}/{z}/{x}/{y}.png?url=...&variable=u&sel=...
factory = TilerFactory(router_prefix="/xarray", reader=FsReader, add_preview=False)
app.include_router(factory.router, prefix="/xarray")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/wind/png")
def wind_png(
    datehour: str = Query(..., description="UTC timestamp."),
    pressure_level: int = Query(..., description="Pressure level (hPa)."),
    url: str | None = Query(None, description="Dataset path or URL."),
    uv_min: float | None = Query(None, description="Encode min for U/V."),
    uv_max: float | None = Query(None, description="Encode max for U/V."),
    roll: bool = Query(True, description="Longitude half-roll style output."),
) -> Response:
    if pressure_level not in ALLOWED_PRESSURES:
        raise HTTPException(status_code=400, detail="Supported pressure levels: 250, 500, 925")

    dataset = dataset_url_or_default(url)

    try:
        meta = inspect_dataset(dataset)
        sel = build_sel(meta, datehour, pressure_level)
        x_coords: np.ndarray

        with FsReader(dataset, variable="u", sel=sel, decode_times=True) as u_reader:
            u_np = np.asarray(u_reader.input.data, dtype=np.float32)
            x_coords = np.asarray(u_reader.input.x.values, dtype=np.float64)

        with FsReader(dataset, variable="v", sel=sel, decode_times=True) as v_reader:
            v_np = np.asarray(v_reader.input.data, dtype=np.float32)

        if uv_min is None or uv_max is None:
            dmin, dmax = default_uv_range_for_level_hpa(pressure_level)
            uv_min = dmin if uv_min is None else uv_min
            uv_max = dmax if uv_max is None else uv_max

        validate_range(uv_min, uv_max)

        if not roll:
            u_np = unroll_to_0_360(u_np, x_coords)
            v_np = unroll_to_0_360(v_np, x_coords)

        rgb = encode_wind_rgb(u_np, v_np, uv_min, uv_max)
        return image_response_from_rgb(rgb)

    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        detail = str(exc)
        status = 404 if "not found" in detail.lower() else 400
        raise HTTPException(status_code=status, detail=detail) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"TiTiler wind render failed: {exc}") from exc


@app.get("/wind/tiles/{z}/{x}/{y}.png")
def wind_tile_png(
    z: int,
    x: int,
    y: int,
    datehour: str = Query(..., description="UTC timestamp."),
    pressure_level: int = Query(..., description="Pressure level (hPa)."),
    url: str | None = Query(None, description="Dataset path or URL."),
    uv_min: float | None = Query(None, description="Encode min for U/V."),
    uv_max: float | None = Query(None, description="Encode max for U/V."),
    resampling: Literal["nearest", "bilinear", "cubic"] = Query("nearest"),
) -> Response:
    if pressure_level not in ALLOWED_PRESSURES:
        raise HTTPException(status_code=400, detail="Supported pressure levels: 250, 500, 925")

    dataset = dataset_url_or_default(url)

    try:
        meta = inspect_dataset(dataset)
        sel = build_sel(meta, datehour, pressure_level)

        with FsReader(dataset, variable="u", sel=sel, decode_times=True) as u_reader:
            u_tile = u_reader.tile(x, y, z, resampling_method=resampling)
            u_np = np.asarray(u_tile.data[0], dtype=np.float32)
            tile_mask = to_uint8_mask(u_tile.mask)

        with FsReader(dataset, variable="v", sel=sel, decode_times=True) as v_reader:
            v_tile = v_reader.tile(x, y, z, resampling_method=resampling)
            v_np = np.asarray(v_tile.data[0], dtype=np.float32)
            tile_mask = np.minimum(tile_mask, to_uint8_mask(v_tile.mask))

        if uv_min is None or uv_max is None:
            dmin, dmax = default_uv_range_for_level_hpa(pressure_level)
            uv_min = dmin if uv_min is None else uv_min
            uv_max = dmax if uv_max is None else uv_max
        validate_range(uv_min, uv_max)

        rgb = encode_wind_rgb(u_np, v_np, uv_min, uv_max)
        masked = np.ma.MaskedArray(rgb, mask=np.broadcast_to(tile_mask == 0, rgb.shape))
        img = ImageData(masked, band_names=["u", "v", "zero"])
        body, media = render_image(img, output_format=ImageType.png, add_mask=True)
        return Response(content=body, media_type=media)

    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        detail = str(exc)
        status = 404 if "not found" in detail.lower() else 400
        raise HTTPException(status_code=status, detail=detail) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"TiTiler wind tile failed: {exc}") from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "scripts.titiler_wind_server:app",
        host="127.0.0.1",
        port=8010,
        reload=False,
    )
