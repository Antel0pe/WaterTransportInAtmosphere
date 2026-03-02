#!/usr/bin/env python3
"""Download ERA5 pressure-level divergence and vertical velocity for Nov 2021."""

from pathlib import Path

import cdsapi


def build_request() -> dict:
    return {
        "product_type": ["reanalysis"],
        "variable": ["divergence", "vertical_velocity"],
        "year": ["2021"],
        "month": ["11"],
        "day": [f"{day:02d}" for day in range(1, 31)],
        "time": [f"{hour:02d}:00" for hour in range(24)],
        "pressure_level": ["250", "500", "925"],
        "data_format": "netcdf",
        "download_format": "unarchived",
    }


def main() -> None:
    dataset = "reanalysis-era5-pressure-levels"
    request = build_request()

    project_root = Path(__file__).resolve().parents[1]
    output_path = (
        project_root
        / "data"
        / "era5_2021-nov_250-500-925_divergence_vertical_velocity.nc"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Submitting CDS request for {dataset}...")
    print(f"Output file: {output_path}")

    # Keep CDS API logs visible so long-running request/download progress is visible.
    client = cdsapi.Client(progress=True, quiet=False)
    client.retrieve(dataset, request).download(str(output_path))

    print("Download complete.")


if __name__ == "__main__":
    main()
