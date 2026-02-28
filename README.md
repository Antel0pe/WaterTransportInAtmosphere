This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Dynamic Wind UV PNG Route (NetCDF On Demand)

A non-conflicting dynamic route is available at:

```text
/api/wind_uv_dynamic/:pressure/:datehour
```

Example:

```text
http://localhost:3000/api/wind_uv_dynamic/925/2021-11-01T00:00
```

Supported query params:

- `min` and `max`: optional UV scale range in m/s (same scale used by RGB encode).
- `source`: optional filename inside `data/` (default: `era5_2021-nov_250-500-925_uv_pv_gph.nc`).
- `roll`: optional boolean (`true/false`) for longitude half-roll (default: `true`).

The route shells out to:

```text
scripts/wind_uv_dynamic_png.py
```

By default it uses Python at:

```text
/home/dmmsp/anaconda3/envs/water-transport-in-atmosphere/bin/python
```

Override with env var if needed:

```bash
WIND_DYNAMIC_PYTHON=/path/to/python npm run dev
```

## TiTiler Wind Service + Proxy Route

There is also a TiTiler-based wind service:

```bash
uvicorn scripts.titiler_wind_server:app --host 127.0.0.1 --port 8010
```

Service endpoints include:

- `GET /healthz`
- `GET /wind/png` (full-world encoded wind PNG)
- `GET /wind/tiles/{z}/{x}/{y}.png` (dynamic tiles)
- `GET /xarray/...` (generic TiTiler xarray endpoints)

Next.js proxy route:

```text
/api/wind_uv_titiler/:pressure/:datehour
```

Example:

```text
http://localhost:3000/api/wind_uv_titiler/925/2021-11-01T00:00
```

Optional query params:

- `min` and `max` for UV encoding range
- `source` for filename under `data/`
- `roll` for longitude orientation

Override TiTiler base URL for the proxy route:

```bash
WIND_TITILER_BASE_URL=http://127.0.0.1:8010 npm run dev
```

Tile proxy route:

```text
/api/wind_uv_titiler_tile/:pressure/:datehour/:z/:x/:y
```

Example:

```text
http://localhost:3000/api/wind_uv_titiler_tile/925/2021-11-01T00:00/0/0/0
```

Optional query params:

- `min` and `max` for UV encoding range
- `source` for filename under `data/`
- `resampling` as `nearest`, `bilinear`, or `cubic`

Earth camera view state now exposes tile info to layers through `useEarthLayer(...)`:

- `viewState.centerLat`
- `viewState.centerLon`
- `viewState.tile.z`
- `viewState.tile.x`
- `viewState.tile.y`

The new `WindTileLayer` uses this to request and render the current-view tile.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
