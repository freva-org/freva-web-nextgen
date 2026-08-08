// downloads.ts - direct links to remote data files.
//
// Deliberately a PURE module with no rendering in it: the same decision has to hold for a single
// row's kebab and for a whole selection, and a rule duplicated in two places is a rule that will
// eventually disagree with itself.
//
// The gate is deliberately narrow - an ALLOW-list on both the scheme and the file suffix - because
// the result is an `href` the user clicks. Anything not positively recognised as a remote data file
// gets no link at all.

import type { FileRow } from "./types.js";

/**
 * Suffixes we will link directly. NetCDF/GRIB/HDF families only: a single self-contained file that a
 * browser can stream to disk. Zarr is intentionally absent - a store is a DIRECTORY, so "download
 * this URL" would fetch a metadata fragment and look like a corrupt file.
 */
export const DOWNLOADABLE_SUFFIXES = [
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
] as const;

/**
 * A safe, directly downloadable URL for a row, or null.
 *
 * Requirements, ALL of which must hold:
 *  • the candidate (`row.raw.uri`, else `row.file`) parses as an absolute URL;
 *  • its scheme is exactly `http:` or `https:` - never `file:`, `javascript:`, `data:`, or a raw
 *    `s3:`/`gs:` URI. An object in a bucket is eligible only when the API hands us a real HTTP(S)
 *    URL for it;
 *  • its PATHNAME (query string and fragment excluded, case-insensitively) ends in an allow-listed
 *    suffix. Checking the whole URL would let `?x=.nc` smuggle a link past the filter.
 */
export function downloadableUrl(row: Pick<FileRow, "file" | "raw">): string | null {
  const candidates = [row.raw?.uri, row.file];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    let url: URL;
    try {
      url = new URL(candidate); // a bare POSIX path throws here, which is the intent
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const path = url.pathname.toLowerCase();
    if (!DOWNLOADABLE_SUFFIXES.some((suffix) => path.endsWith(suffix))) continue;
    return url.href;
  }
  return null;
}

/** A filename hint for the `download` attribute: the last path segment, or a safe fallback. */
export function downloadFilename(href: string): string {
  try {
    const name = decodeURIComponent(new URL(href).pathname.split("/").pop() ?? "");
    // Strip anything that could steer a save dialog somewhere unexpected. `download` is only a
    // hint - a cross-origin server may ignore it entirely - but it must never carry a path.
    const safe = name.replace(/[/\\]/g, "_").trim();
    return safe || "download";
  } catch {
    return "download";
  }
}

/** Split a selection into the rows that can be linked and a count of those that cannot. */
export function partitionDownloadable<T extends Pick<FileRow, "file" | "raw">>(
  rows: T[],
): { eligible: Array<{ row: T; href: string }>; skipped: number } {
  const eligible: Array<{ row: T; href: string }> = [];
  let skipped = 0;
  for (const row of rows) {
    const href = downloadableUrl(row);
    if (href) eligible.push({ row, href });
    else skipped++;
  }
  return { eligible, skipped };
}
