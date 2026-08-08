// Direct links to remote data files.
//
// This is an ALLOW-list on both the scheme and the suffix, because the result is an href a user
// clicks. The tests below are mostly about what must NOT produce a link.

import "./helpers.js";
import assert from "node:assert/strict";
import test from "node:test";

import { downloadFilename, downloadableUrl, partitionDownloadable } from "../src/downloads.js";
import type { ApiRow, FileRow } from "../src/types.js";

const row = (file: string, uri?: string): Pick<FileRow, "file" | "raw"> => ({
  file,
  raw: { file, fs_type: "posix", ...(uri ? { uri } : {}) } as ApiRow,
});

test("an https NetCDF/GRIB/HDF URL is downloadable", () => {
  for (const suffix of [
    ".nc",
    ".nc4",
    ".cdf",
    ".netcdf",
    ".grib",
    ".grib2",
    ".grb",
    ".grb2",
    ".hdf",
    ".hdf4",
    ".hdf5",
    ".h5",
    ".he5",
  ]) {
    const url = `https://data.example.org/a/b${suffix}`;
    assert.equal(downloadableUrl(row(url)), url, `${suffix} is allow-listed`);
  }
  assert.equal(
    downloadableUrl(row("http://data.example.org/x.nc")),
    "http://data.example.org/x.nc",
    "plain http is allowed too - a deployment may not have TLS",
  );
});

test("the suffix is matched case-insensitively, on the PATHNAME only", () => {
  assert.ok(downloadableUrl(row("https://e.org/A.NC")), "upper case suffix");
  assert.ok(downloadableUrl(row("https://e.org/a.Nc4")), "mixed case suffix");
  // A query string or fragment must not change the decision in either direction.
  assert.equal(
    downloadableUrl(row("https://e.org/a.nc?token=1#frag")),
    "https://e.org/a.nc?token=1#frag",
    "a real .nc with a query is still downloadable, query intact",
  );
  assert.equal(
    downloadableUrl(row("https://e.org/index.html?file=a.nc")),
    null,
    "a .nc in the QUERY does not make an HTML page a data file",
  );
  assert.equal(
    downloadableUrl(row("https://e.org/page#a.nc")),
    null,
    "…and neither does one in the fragment",
  );
});

test("non-file and non-http candidates get NO link", () => {
  for (const candidate of [
    "/archive/local/a.nc", // a local POSIX path - not fetchable by the browser
    "file:///archive/a.nc",
    "s3://bucket/a.nc", // raw object URI - only an actual HTTP(S) URL is eligible
    "gs://bucket/a.nc",
    "https://e.org/store.zarr", // a DIRECTORY, not a file
    "https://e.org/store.zarr/.zmetadata",
    "https://e.org/a.txt",
    "https://e.org/a.nc.tmp", // the suffix must be at the END
    "https://e.org/",
    "",
  ]) {
    assert.equal(downloadableUrl(row(candidate)), null, `${candidate || "(empty)"} is refused`);
  }
});

test("no unsafe scheme can reach an anchor", () => {
  for (const hostile of [
    "javascript:alert(1)//a.nc",
    "data:text/plain;base64,AAAA#a.nc",
    "vbscript:msgbox//a.nc",
    "JAVASCRIPT:alert(1)/a.nc",
  ]) {
    assert.equal(downloadableUrl(row(hostile)), null, `${hostile} is refused`);
  }
  // …even when the hostile string arrives via `uri`, which is preferred over `file`.
  assert.equal(downloadableUrl(row("/archive/a.nc", "javascript:alert(1)/a.nc")), null);
});

test("uri wins over file, and file is the fallback", () => {
  assert.equal(
    downloadableUrl(row("/archive/a.nc", "https://e.org/a.nc")),
    "https://e.org/a.nc",
    "an HTTP uri is used even when `file` is a local path",
  );
  assert.equal(
    downloadableUrl(row("https://e.org/b.nc", "s3://bucket/b.nc")),
    "https://e.org/b.nc",
    "an ineligible uri falls through to an eligible file",
  );
});

test("the filename hint is a bare name, never a path", () => {
  assert.equal(downloadFilename("https://e.org/a/b/tas_day.nc"), "tas_day.nc");
  assert.equal(
    downloadFilename("https://e.org/a%2Fb.nc"),
    "a_b.nc",
    "an encoded slash is neutered",
  );
  assert.equal(downloadFilename("https://e.org/"), "download", "a directory URL gets a fallback");
});

test("a mixed selection reports how many files were skipped", () => {
  const rows = [
    row("https://e.org/a.nc"),
    row("/archive/local.nc"),
    row("https://e.org/b.grib2"),
    row("s3://bucket/c.nc"),
  ];
  const { eligible, skipped } = partitionDownloadable(rows);
  assert.deepEqual(
    eligible.map((e) => e.href),
    ["https://e.org/a.nc", "https://e.org/b.grib2"],
    "eligible files keep SELECTION order",
  );
  assert.equal(skipped, 2, "the ineligible ones are counted, not silently dropped");
});
