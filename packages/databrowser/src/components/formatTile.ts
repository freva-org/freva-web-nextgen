// components/formatTile.ts - the file-type visual at the start of each result row / card.
// Exactly three formats get an original SVG thumbnail (zarr, nc, grib); every other extension
// keeps the generic text tile. Detection is filename-only - the cheap search rows carry no
// format field, so we read the extension. Pure + covered by a unit test.

import { el } from "../dom.js";
import { brandIcon, type BrandName } from "../brand.js";

/** Maps the three thumbnailed formats to their brand-sprite mark. */
const BRAND_OF: Record<FormatName, BrandName> = { zarr: "zarr", nc: "netcdf", grib: "grib" };

/** The canonical format names that get a brand thumbnail (the rest keep the generic text tile). */
export type FormatName = "zarr" | "nc" | "grib";

/** Canonical format for a file path, or null when it isn't one of the three thumbnailed types. */
export function formatOf(file: string): FormatName | null {
  const lower = file.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  // zarr stores are directories (…/x.zarr/…) or a path segment ending in .zarr
  if (/\.zarr(\/|$)/.test(lower) || base.endsWith(".zarr")) return "zarr";
  const m = base.match(/\.([a-z0-9]+)$/);
  const ext = m ? m[1] : "";
  if (ext === "nc" || ext === "nc4" || ext === "cdf" || ext === "netcdf") return "nc";
  if (ext === "grib" || ext === "grib2" || ext === "grb" || ext === "grb2") return "grib";
  return null;
}

/** The short text shown on the generic tile for a non-thumbnailed extension. */
export function genericExt(file: string): string {
  const base = file.split("/").pop() ?? file;
  const m = base.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].slice(0, 4) : "file";
}

/**
 * The leading tile for a result row/card: a brand thumbnail (on a white chip) for zarr/nc/grib, else
 * the generic text tile. `title` gives a hover label; the tile is decorative (aria-hidden glyph).
 */
export function formatTile(file: string): HTMLElement {
  const fmt = formatOf(file);
  if (fmt) {
    return el("div", { class: `ftile ${fmt}`, title: `${fmt} file`, "aria-hidden": "true" }, [
      brandIcon(BRAND_OF[fmt], { chip: false, size: 22 }),
    ]);
  }
  return el("div", { class: "ext", title: `${genericExt(file)} file` }, [
    document.createTextNode(genericExt(file)),
  ]);
}
