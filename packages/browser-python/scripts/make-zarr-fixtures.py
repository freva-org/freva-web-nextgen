#!/usr/bin/env python3
"""Write the tiny Zarr stores the browser suites read.

Committed to the repository rather than generated at test time, for the same reason the runtime is
vendored: a required CI test must not depend on a network, and it must not depend on whichever
version of zarr-python happens to be on the machine that runs it. The bytes under test are the bytes
that were reviewed.

Two stores, both consolidated, both deliberately minute (a few kilobytes) so they cost nothing to
serve and nothing to read:

  zarr-v2/  the format the public CMIP6 archives are written in today
  zarr-v3/  the format new stores are written in

Both are opened by the SAME `xr.open_zarr(url, consolidated=True, chunks=None)` call in the tests,
which is the point: a user should not have to know or care which one they are pointed at.

Regenerate with `npm run fixtures:build` (needs xarray + zarr locally; nothing in CI runs it).
"""

from __future__ import annotations

import pathlib
import shutil

import numpy as np
import xarray as xr

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "tests" / "fixtures"


#: Chunked deliberately - two chunks along time - so a read fetches more than one object and the
#: adapter is exercised rather than performing a single whole-file GET. Set through `encoding`
#: rather than `ds.chunk()`, which would pull in dask; nothing in this package uses dask, on either
#: side of the browser boundary.
CHUNKS = (2, 5, 6)


def dataset() -> xr.Dataset:
    """A recognisably climate-shaped dataset, small enough to be trivial."""
    time = np.arange(4)
    lat = np.linspace(-60.0, 60.0, 5)
    lon = np.linspace(0.0, 300.0, 6)
    rng = np.random.default_rng(20260904)
    values = rng.normal(loc=8.0, scale=1.5, size=(4, 5, 6)).astype("float32")

    ds = xr.Dataset(
        {"sfcWind": (("time", "lat", "lon"), values, {"units": "m s-1", "long_name": "wind"})},
        coords={
            "time": ("time", time, {"units": "days since 2000-01-01", "calendar": "standard"}),
            "lat": ("lat", lat, {"units": "degrees_north"}),
            "lon": ("lon", lon, {"units": "degrees_east"}),
        },
        attrs={"title": "browser-python test fixture", "source": "synthetic"},
    )
    return ds


def write(path: pathlib.Path, zarr_format: int) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    dataset().to_zarr(
        path,
        mode="w",
        encoding={"sfcWind": {"chunks": CHUNKS}},
        # Consolidated metadata is REQUIRED by this engine, not merely preferred: an unconsolidated
        # store is discovered by listing keys, and plain HTTP cannot list an object-store prefix.
        # See browser_http.BrowserHTTPFileSystem._ls, which refuses rather than pretending.
        consolidated=True,
        zarr_format=zarr_format,
    )
    files = sorted(p for p in path.rglob("*") if p.is_file())
    total = sum(p.stat().st_size for p in files)
    print(f"{path.relative_to(OUT.parent)}: {len(files)} files, {total} bytes")


if __name__ == "__main__":
    write(OUT / "zarr-v2", 2)
    write(OUT / "zarr-v3", 3)
