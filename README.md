# Water Transport in the Atmosphere

Interactive globe-based weather visualization for exploring the November 2021 Pacific Northwest atmospheric river event. The app combines precomputed raster fields, contour data, and narrative JSON bundles so you can scrub through time, toggle layers, and inspect how moisture transport, upper-air dynamics, and backward trajectories line up.

The current narrative bundles are centered on Vancouver (`49.28, -123.12`) with a 100-hour backward-looking setup starting at `2021-11-12T15:00:00Z`. The main time slider covers all of November 2021 in UTC.

## What You Can Explore

- Total-column moisture anomaly
- Surface evaporation anomaly
- Moisture transport / IVT-style fields
- Wind, temperature, potential vorticity, divergence, and vertical velocity at `250`, `500`, and `925` hPa
- Geopotential height contours
- A backward trajectory story layer
- A 925 hPa steering-corridor layer
- An upper-air stacked-structure layer that lines up PV, ascent, divergence, jet structure, and related support fields

## Stack

- Next.js 16 App Router
- React 19
- Three.js and `three-globe`
- Zustand for layer/control state
- Tweakpane for runtime tuning
- Python data-prep scripts for NetCDF-to-PNG / JSON export

## Running Locally

This repository uses `pnpm`.

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

Other useful commands:

```bash
pnpm lint
pnpm build
pnpm start
```

## Controls

- `W`, `A`, `S`, `D`: move / pan
- `Shift`: move up
- `Space`: move down
- `Left Arrow`, `Right Arrow`: step time by the current slider increment
- Click the globe: enter free-fly look mode
- Move mouse: turn / tilt camera while in free-fly
- `Q` or `Esc`: exit free-fly

## How The App Is Wired

The frontend is a thin rendering layer over precomputed assets.

1. Python scripts read NetCDF datasets from `data/`.
2. Exporters write PNG textures and JSON bundles into `public/`.
3. Next.js route handlers in `app/api/` load those files by timestamp or bundle name.
4. Client-side Three.js layers fetch those routes and draw them on the globe.
5. Zustand + Tweakpane control which layers are visible and how they are styled.

This means `pnpm dev` does not compute meteorology on the fly. If required files are missing from `public/`, the corresponding layer will fail to load.

## Project Layout

| Path | Purpose |
| --- | --- |
| `app/components/HomeClient.tsx` | Main viewport, side panels, and time slider wiring |
| `app/components/layers/` | Globe rendering layers for moisture, trajectories, upper-air fields, contours, and more |
| `app/components/sidebar/` | Left and right panel content, explainers, and control help |
| `app/state/` | Zustand store plus Tweakpane control bindings |
| `app/api/` | File-backed API routes used by the frontend |
| `public/` | Precomputed PNG textures and JSON bundles consumed by the app |
| `data/` | Source meteorological datasets and intermediate analysis outputs |
| `scripts/` | Python exporters, notebooks, and meteorological experiments |
| `ideas.md` | Rough product / analysis ideas |
| `learnings.md` | Notes from ongoing meteorology exploration |

## Data And Asset Conventions

There are two script conventions in this repo right now:

- Older raster / analysis scripts often assume the working directory is `scripts/` and write intermediate outputs into `data/`.
- Newer export scripts generally assume the working directory is the repo root and write directly into `public/`.

That split is real. If you are regenerating assets, check the script before running it instead of assuming every exporter behaves the same way.

The app currently reads from directories such as:

- `public/waterTransport-evap-precip-waterColumn`
- `public/evap_rgb_instant_clim_anom`
- `public/ivt-925-1000`
- `public/potential-vorticity-rg/<pressure>`
- `public/divergence-rg/<pressure>`
- `public/vertical-velocity-rg/<pressure>`
- `public/temperature-rg/<pressure>`
- `public/gph_contours/<pressure>`
- `public/backward_trajectory/current.json`
- `public/trajectory_steering/current.json`
- `public/upper_air_support/current.json`

## Regenerating Assets

### Frontend-facing exporters that write to `public/`

These are the safest scripts to use when rebuilding assets for the running app.

From the repo root:

```bash
python scripts/export_backward_trajectory_bundle.py
python scripts/export_trajectory_steering_bundle.py
python scripts/export_upper_air_support_bundle.py
```

From `scripts/`:

```bash
python temperature_to_rgb.py
python divergence_to_rgb.py
python vertical_velocity_to_rgb.py
python potential_vorticity_to_rgb.py
python gph_contours.py --pressure-level 250
python gph_contours.py --pressure-level 500
python gph_contours.py --pressure-level 925
```

### Legacy / research scripts

Several older scripts still emit outputs under `data/` instead of `public/`, for example:

- `water_rgb_pngs.py`
- `evaporation_and_anomaly.py`
- `ivt_rgb_png.py`
- `wind_to_rgb.py`

Those are useful for analysis, but they are not currently drop-in rebuild commands for the live app without an additional sync / copy step.

## Python Environment

The repo does not currently include a pinned Python environment file. Based on the checked-in scripts, you should expect to need at least:

- `numpy`
- `pandas`
- `xarray`
- `h5py`
- `imageio`
- `matplotlib`
- `scikit-image`
- `tqdm`

Depending on how your NetCDF files are encoded, you may also need an xarray-compatible NetCDF backend such as `netCDF4` or `h5netcdf`.

## Notes

- The app is data-heavy by design. Large JSON story bundles and frame textures are part of the current workflow.
- There is linting configured for the Next.js app, but no automated test suite is set up yet.
- The repo mixes polished app code with exploratory notebooks and scripts. That is intentional: this project is both a viewer and a working meteorology sandbox.
