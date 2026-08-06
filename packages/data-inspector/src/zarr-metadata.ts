/**
 * zarr-metadata
 *
 * Client-side Zarr metadata parser and xarray-style HTML renderer. Reads a
 * store's consolidated metadata (v2 `.zmetadata` or v3 `zarr.json`) directly
 * in the browser and builds the same HTML representation xarray produces in a
 * notebook - no server round-trip required.
 *
 * Framework-agnostic: {@link loadZarrMetadataHtml} and {@link openDatasetMeta}
 * are plain functions, usable from any framework or none.
 */

import { defaultGetAuthHeaders, normalizeUrl } from "./internal/http";

// ── Public types ─────────────────────────────────────────────────────────────

/** A single Zarr array, normalized into the shape xarray exposes. */
export interface ZarrVariable {
  shape: number[];
  chunks: number[];
  dtype: string;
  dims: string[];
  attrs: Record<string, unknown>;
  /** Internal heuristic flag: a 1-D coordinate that looks like a time axis. */
  _isTimeCoord?: boolean;
}

/** A flat Zarr dataset (one group's worth of arrays). */
export interface ZarrDataset {
  dims: Record<string, number>;
  coords: Record<string, ZarrVariable>;
  data_vars: Record<string, ZarrVariable>;
  attrs: Record<string, unknown>;
}

/**
 * Parsed metadata. Either a flat dataset (`groups: null`) or a map of named
 * groups, mirroring what {@link buildXarrayRepr} renders.
 */
export type ZarrMetadataResult =
  | ({ groups: null } & ZarrDataset)
  | { groups: Record<string, ZarrDataset> };

/** Options shared by the metadata fetchers. */
export interface ZarrMetadataOptions {
  /**
   * Override auth header injection.
   * Default: reads a Bearer token from the `freva_auth_token` cookie.
   */
  getAuthHeaders?: () => Record<string, string>;
}

/** Options for {@link injectXarrayCss}. */
export interface InjectCssOptions {
  /**
   * Base accent color (hex) used for the chunk-cube fills. Falls back to
   * `window.MAIN_COLOR`, then to Freva's default `#9b7a52`.
   */
  mainColor?: string;
}

/** Options for {@link loadZarrMetadataHtml}. */
export interface LoadMetadataOptions extends ZarrMetadataOptions, InjectCssOptions {
  /** Inject the xarray CSS into `<head>` before building HTML. Default: true. */
  injectCss?: boolean;
}

// ── Zarr metadata parsers ─────────────────────────────────────────────────────

function parseDtypeStr(dtype: string): string {
  const map: Record<string, string> = {
    f2: "float16",
    f4: "float32",
    f8: "float64",
    i1: "int8",
    i2: "int16",
    i4: "int32",
    i8: "int64",
    u1: "uint8",
    u2: "uint16",
    u4: "uint32",
    u8: "uint64",
    b1: "bool",
  };
  return map[dtype.slice(1)] ?? dtype;
}

interface ExtractedArray {
  shape: number[];
  chunks: number[];
  dtype: string;
  dims: string[];
  attrs: Record<string, unknown>;
}

/** Remove xarray's internal `_ARRAY_DIMENSIONS` key from a v2 attrs object. */
function stripArrayDims(attrs: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...attrs };
  delete rest._ARRAY_DIMENSIONS;
  return rest;
}

// Shared assembly (v2 + v3): classify arrays into dims / coords / data_vars.
function assembleDataset<T>(
  arrays: Record<string, T>,
  attrs: Record<string, unknown>,
  extract: (info: T) => ExtractedArray,
): ZarrDataset {
  const dims: Record<string, number> = {};
  const allVars: Record<string, ZarrVariable> = {};

  for (const [name, info] of Object.entries(arrays)) {
    const { shape, chunks, dtype, dims: dimNames, attrs: userAttrs } = extract(info);
    dimNames.forEach((d, i) => {
      if (!(d in dims)) dims[d] = shape[i] ?? 0;
    });
    const units = userAttrs.units;
    const isTime =
      dimNames.length === 1 &&
      dimNames[0] === name &&
      (String(units ?? "").includes("since") || name === "time");
    allVars[name] = {
      shape,
      chunks,
      dtype,
      dims: dimNames,
      attrs: userAttrs,
      _isTimeCoord: isTime,
    };
  }

  const coordSet = new Set<string>();
  const splitWords = (s: unknown): string[] =>
    String(s ?? "")
      .split(/[\s,]+/)
      .filter(Boolean);
  for (const [name, dv] of Object.entries(allVars)) {
    if (dv.dims.length === 1 && dv.dims[0] === name) coordSet.add(name);
  }
  splitWords(attrs.coordinates).forEach((c) => coordSet.add(c));
  for (const dv of Object.values(allVars)) {
    splitWords(dv.attrs.coordinates).forEach((c) => coordSet.add(c));
  }

  const coords: Record<string, ZarrVariable> = {};
  const data_vars: Record<string, ZarrVariable> = {};
  for (const [name, dv] of Object.entries(allVars)) {
    (coordSet.has(name) ? coords : data_vars)[name] = dv;
  }
  return { dims, coords, data_vars, attrs };
}

/** True when a parsed dataset holds at least one coordinate or data variable. */
function datasetHasArrays(ds: ZarrDataset): boolean {
  return Object.keys(ds.coords).length + Object.keys(ds.data_vars).length > 0;
}

// ── v2: reads from the flat .zmetadata key map ────────────────────────────────

interface ZArrayV2 {
  shape?: number[];
  chunks?: number[];
  dtype?: string;
}
interface ArrayInfoV2 {
  zarray?: ZArrayV2;
  zattrs?: Record<string, unknown>;
}

function buildDatasetV2(meta: Record<string, unknown>, prefix: string): ZarrDataset {
  const attrs = (meta[`${prefix}.zattrs`] as Record<string, unknown>) ?? {};
  const arrays: Record<string, ArrayInfoV2> = {};

  for (const [key, val] of Object.entries(meta)) {
    if (!key.startsWith(prefix)) continue;
    const rel = key.slice(prefix.length);
    if (rel.endsWith("/.zarray")) {
      const name = rel.slice(0, -8);
      if (name.includes("/")) continue;
      arrays[name] ??= {};
      arrays[name].zarray = val as ZArrayV2;
    } else if (rel.endsWith("/.zattrs")) {
      const name = rel.slice(0, -8);
      if (!name || name.includes("/")) continue;
      arrays[name] ??= {};
      arrays[name].zattrs = val as Record<string, unknown>;
    }
  }

  // A subgroup contributes a "<name>/.zattrs" key that looks like an array with
  // no ".zarray"; drop those so groups aren't mistaken for zero-dim variables.
  for (const name of Object.keys(arrays)) {
    if (!arrays[name].zarray) delete arrays[name];
  }

  return assembleDataset(arrays, attrs, (info) => {
    const zattrs = info.zattrs ?? {};
    return {
      shape: info.zarray?.shape ?? [],
      chunks: info.zarray?.chunks ?? info.zarray?.shape ?? [],
      dtype: parseDtypeStr(info.zarray?.dtype ?? "|u1"),
      dims: (zattrs._ARRAY_DIMENSIONS as string[]) ?? [],
      attrs: stripArrayDims(zattrs),
    };
  });
}

function parseV2(json: { metadata?: Record<string, unknown> }): ZarrMetadataResult {
  const meta = json.metadata ?? {};

  // Discover every group at any depth: "g/.zgroup", "g/sub/.zgroup", …
  const groupNames = new Set<string>();
  for (const key of Object.keys(meta)) {
    if (key === ".zgroup" || key === ".zattrs") continue;
    if (key.endsWith("/.zgroup")) groupNames.add(key.slice(0, -8));
  }

  // No subgroups -> a single flat dataset.
  if (groupNames.size === 0) {
    const ds = buildDatasetV2(meta, "");
    if (!datasetHasArrays(ds)) {
      throw new Error("No arrays found in .zmetadata");
    }
    return { groups: null, ...ds };
  }

  // Multi-group: one entry per group (full path) that holds arrays, plus the
  // root group's own arrays if any. buildDatasetV2 collects direct children
  // only, so each array appears once under its closest parent group.
  const groups: Record<string, ZarrDataset> = {};
  const root = buildDatasetV2(meta, "");
  if (datasetHasArrays(root)) groups["/"] = root;
  for (const name of [...groupNames].sort()) {
    const ds = buildDatasetV2(meta, `${name}/`);
    if (datasetHasArrays(ds)) groups[name] = ds;
  }

  if (!Object.keys(groups).length) {
    throw new Error("No arrays found in .zmetadata");
  }
  return { groups };
}

// ── v3: reads from zarr.json consolidated_metadata ────────────────────────────

interface ZNodeV3 {
  node_type?: string;
  attributes?: Record<string, unknown>;
  shape?: number[];
  chunk_grid?: { configuration?: { chunk_shape?: number[] } };
  data_type?: string;
  dimension_names?: string[];
}

function buildDatasetV3(meta: Record<string, ZNodeV3>, prefix: string): ZarrDataset {
  const rootKey = prefix || "";
  const attrs = (meta[rootKey] ?? {}).attributes ?? {};
  const arrays: Record<string, { zarray: ZNodeV3 }> = {};

  for (const [key, val] of Object.entries(meta)) {
    if (val.node_type !== "array") continue;
    if (prefix) {
      if (!key.startsWith(`${prefix}/`)) continue;
      const rel = key.slice(prefix.length + 1);
      if (rel.includes("/")) continue;
      arrays[rel] = { zarray: val };
    } else {
      if (!key || key.includes("/")) continue;
      arrays[key] = { zarray: val };
    }
  }

  return assembleDataset(arrays, attrs, (info) => {
    const v = info.zarray;
    return {
      shape: v.shape ?? [],
      chunks: v.chunk_grid?.configuration?.chunk_shape ?? v.shape ?? [],
      // v3 dtypes are already human-readable.
      dtype: v.data_type ?? "float32",
      dims: v.dimension_names ?? [],
      attrs: v.attributes ?? {},
    };
  });
}

function parseV3(json: {
  consolidated_metadata?: { metadata?: Record<string, ZNodeV3> };
}): ZarrMetadataResult {
  const meta = json.consolidated_metadata?.metadata ?? {};
  if (!Object.keys(meta).length) {
    throw new Error("zarr.json has no consolidated_metadata");
  }

  // Every group node at any depth (the empty-key root is handled separately).
  const groupNames = new Set<string>();
  for (const [key, val] of Object.entries(meta)) {
    if (!key || val.node_type !== "group") continue;
    groupNames.add(key);
  }

  if (groupNames.size === 0) {
    const ds = buildDatasetV3(meta, "");
    if (!datasetHasArrays(ds)) {
      throw new Error("No arrays found in zarr.json");
    }
    return { groups: null, ...ds };
  }

  const groups: Record<string, ZarrDataset> = {};
  const root = buildDatasetV3(meta, "");
  if (datasetHasArrays(root)) groups["/"] = root;
  for (const name of [...groupNames].sort()) {
    const ds = buildDatasetV3(meta, name);
    if (datasetHasArrays(ds)) groups[name] = ds;
  }

  if (!Object.keys(groups).length) {
    throw new Error("No arrays found in zarr.json");
  }
  return { groups };
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Fetches a store's consolidated metadata (v2 `.zmetadata`, falling back to
 * v3 `zarr.json`) and returns either a flat dataset (`groups: null`) or a
 * multi-group store (`groups: { name -> dataset }`).
 */
export async function openDatasetMeta(
  url: string,
  options: ZarrMetadataOptions = {},
): Promise<ZarrMetadataResult> {
  // Defensive: a percent-encoded URL would be treated as a relative path by
  // the browser. Normalize so the fetch lands at the real origin.
  const base = normalizeUrl(url).replace(/\/$/, "");
  const getAuthHeaders = options.getAuthHeaders ?? defaultGetAuthHeaders;
  const opts: RequestInit = { credentials: "same-origin", headers: getAuthHeaders() };

  // Try v2 first, then v3.
  let json: unknown = null;
  let version = 0;

  try {
    const r = await fetch(`${base}/.zmetadata`, opts);
    if (r.ok) {
      json = await r.json();
      version = 2;
    }
  } catch {
    /* fall through to v3 */
  }

  if (!json) {
    try {
      const r = await fetch(`${base}/zarr.json`, opts);
      if (r.ok) {
        json = await r.json();
        version = 3;
      }
    } catch {
      /* fall through to error */
    }
  }

  if (!json) {
    throw new Error("Could not read zarr metadata (.zmetadata or zarr.json)");
  }

  return version === 2
    ? parseV2(json as { metadata?: Record<string, unknown> })
    : parseV3(json as { consolidated_metadata?: { metadata?: Record<string, ZNodeV3> } });
}

// ── xarray HTML renderer ──────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

let _uid = 0;
function uid(): string {
  return `xr${++_uid}`;
}

function icon(id: string): string {
  return `<svg class="icon xr-${id}"><use xlink:href="#${id}"></use></svg>`;
}

function formatDims(dimSizes: Record<string, number>, indexedNames: Set<string>): string {
  if (!Object.keys(dimSizes).length) return "";
  const lis = Object.entries(dimSizes)
    .map(
      ([d, n]) =>
        `<li><span${indexedNames.has(d) ? " class='xr-has-index'" : ""}>${esc(d)}</span>: ${n}</li>`,
    )
    .join("");
  return `<ul class='xr-dim-list'>${lis}</ul>`;
}

function summarizeAttrs(attrs: Record<string, unknown>): string {
  const entries = Object.entries(attrs);
  if (!entries.length) return "<em>No attributes</em>";
  return `<dl class='xr-attrs'>${entries
    .map(([k, v]) => `<dt><span>${esc(k)} :</span></dt><dd>${esc(String(v))}</dd>`)
    .join("")}</dl>`;
}

function previewVar(dv: ZarrVariable): string {
  const total = dv.shape.reduce((a, b) => a * b, 1);
  return total === 0
    ? "[]"
    : `${dv.dtype} (${dv.shape.join(" \u00d7 ")} = ${total.toLocaleString()})`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 ** 2) return (n / 1024).toFixed(2) + " KiB";
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(2) + " MiB";
  return (n / 1024 ** 3).toFixed(2) + " GiB";
}

function buildChunkCube(shape: number[]): string {
  if (!shape.length) return "";
  const ndim = Math.min(shape.length, 3);
  const s = shape.slice(-ndim);
  const vis = (n: number): number =>
    Math.max(20, Math.min(110, 20 + Math.log10(Math.max(1, n)) * 30));
  const fmt = (n: number): string => n.toLocaleString();
  const fSize = 11;
  const ts = `font-size:${fSize}px;fill:var(--xr-font-color2);font-family:monospace`;

  if (ndim < 3) {
    const W = vis(s[ndim - 1]);
    const H = ndim === 2 ? vis(s[0]) : 12;
    const PAD_LEFT = ndim === 2 ? 42 : 2;
    const PAD_BTM = 16;
    const svgW = PAD_LEFT + W + 4;
    const svgH = H + PAD_BTM;
    return `<svg width="${Math.ceil(svgW)}" height="${Math.ceil(svgH)}"
        viewBox="0 0 ${Math.ceil(svgW)} ${Math.ceil(svgH)}"
        style="overflow:visible;display:block;flex-shrink:0">
      <rect x="${PAD_LEFT}" y="0" width="${W}" height="${H}"
            style="fill:var(--xr-chunk-face);stroke:var(--xr-chunk-edge);stroke-width:0.8"/>
      ${
        ndim === 2
          ? `<text x="${PAD_LEFT - 5}" y="${H / 2 + 4}"
            text-anchor="end" style="${ts}">${fmt(s[0])}</text>`
          : ""
      }
      <text x="${PAD_LEFT + W / 2}" y="${H + PAD_BTM - 3}"
            text-anchor="middle" style="${ts}">${fmt(s[ndim - 1])}</text>
    </svg>`;
  }

  const W = vis(s[2]);
  const H = vis(s[1]);
  const D = vis(s[0]);
  const sk = 0.5;
  const dX = D * sk;
  const dY = D * sk * 0.45;
  const PAD_TOP = 16;
  const PAD_BTM = 16;
  const PAD_RGT = 52;
  const svgW = W + dX + PAD_RGT;
  const svgH = PAD_TOP + H + dY + PAD_BTM;
  const ox = 2;
  const oy = PAD_TOP + H + dY;
  return `<svg width="${Math.ceil(svgW)}" height="${Math.ceil(svgH)}"
      viewBox="0 0 ${Math.ceil(svgW)} ${Math.ceil(svgH)}"
      style="overflow:visible;display:block;flex-shrink:0">
    <polygon points="${ox},${oy} ${ox + W},${oy} ${ox + W},${oy - H} ${ox},${oy - H}"
             style="fill:var(--xr-chunk-face);stroke:var(--xr-chunk-edge);stroke-width:0.8"/>
    <polygon points="${ox},${oy - H} ${ox + W},${oy - H} ${ox + W + dX},${oy - H - dY} ${ox + dX},${oy - H - dY}"
             style="fill:var(--xr-chunk-top);stroke:var(--xr-chunk-edge);stroke-width:0.8"/>
    <polygon points="${ox + W},${oy} ${ox + W + dX},${oy - dY} ${ox + W + dX},${oy - H - dY} ${ox + W},${oy - H}"
             style="fill:var(--xr-chunk-side);stroke:var(--xr-chunk-edge);stroke-width:0.8"/>
    <text x="${ox + W / 2}" y="${oy + PAD_BTM - 3}"
          text-anchor="middle" style="${ts}">${fmt(s[2])}</text>
    <text x="${ox + W / 2 + dX / 2}" y="${PAD_TOP - 3}"
          text-anchor="middle" style="${ts}">${fmt(s[1])}</text>
    <text x="${ox + W + dX + 5}" y="${oy - H / 2 - dY / 2 + 4}"
          text-anchor="start" style="${ts}">${fmt(s[0])}</text>
  </svg>`;
}

function buildDataRepr(dv: ZarrVariable): string {
  const { shape, chunks, dtype } = dv;
  const elemBytes =
    (
      {
        int8: 1,
        uint8: 1,
        bool: 1,
        int16: 2,
        uint16: 2,
        int32: 4,
        uint32: 4,
        float32: 4,
        int64: 8,
        uint64: 8,
        float64: 8,
      } as Record<string, number>
    )[dtype] ?? 4;
  const arrayBytes = shape.reduce((a, b) => a * b, 1) * elemBytes;
  let chunkBytes: number | null = null;
  let nChunks: number | null = null;
  if (chunks && chunks.length === shape.length) {
    chunkBytes = chunks.reduce((a, b) => a * b, 1) * elemBytes;
    nChunks = shape.reduce((tot, sz, i) => tot * Math.ceil(sz / chunks[i]), 1);
  }
  const td0 = `style="color:var(--xr-font-color3);padding:2px 16px 2px 0;white-space:nowrap;vertical-align:top"`;
  const td1 = `style="padding:2px 16px 2px 0;white-space:nowrap;vertical-align:top"`;
  const td2 = `style="padding:2px 0;white-space:nowrap;color:var(--xr-font-color2);vertical-align:top"`;
  const row = (label: string, arr: string, chk = ""): string =>
    `<tr><td ${td0}>${label}</td><td ${td1}>${arr}</td><td ${td2}>${chk}</td></tr>`;
  return `<table style="border-collapse:collapse;padding:6px 0 12px"><tr>
    <td style="vertical-align:top;padding:0">
      <table style="font-size:12px;font-family:monospace;border-collapse:collapse;line-height:1.75">
        <thead><tr>
          <th style="font-weight:400;padding:0 16px 5px 0;text-align:left"></th>
          <th style="font-weight:600;padding:0 16px 5px 0;text-align:left">Array</th>
          <th style="font-weight:600;padding:0 0 5px 0;text-align:left">Chunk</th>
        </tr></thead><tbody>
          ${row("Bytes", fmtBytes(arrayBytes), chunkBytes !== null ? fmtBytes(chunkBytes) : "\u2014")}
          ${row("Shape", "(" + shape.join(", ") + ")", chunks ? "(" + chunks.join(", ") + ")" : "\u2014")}
          ${nChunks !== null ? row("Chunks", nChunks.toLocaleString() + " chunks") : ""}
          ${row("dtype", esc(dtype))}
          ${row("dims", "(" + dv.dims.join(", ") + ")")}
        </tbody>
      </table>
    </td>
    <td style="vertical-align:middle;padding:0 0 0 32px">${buildChunkCube(shape)}</td>
  </tr></table>`;
}

function summarizeVariable(name: string, dv: ZarrVariable, isIndex: boolean): string {
  const aId = uid();
  const dId = uid();
  const hasAttrs = Object.keys(dv.attrs).length > 0;
  return `
    <div class='xr-var-name'><span${isIndex ? " class='xr-has-index'" : ""}>${esc(name)}</span></div>
    <div class='xr-var-dims'>(${dv.dims.map(esc).join(", ")})</div>
    <div class='xr-var-dtype'>${esc(dv.dtype)}</div>
    <div class='xr-var-preview xr-preview'>${esc(previewVar(dv))}</div>
    <input id='${aId}' class='xr-var-attrs-in' type='checkbox'${hasAttrs ? "" : " disabled"}>
    <label for='${aId}' title='Show/Hide attributes'>${icon("icon-file-text2")}</label>
    <input id='${dId}' class='xr-var-data-in' type='checkbox'>
    <label for='${dId}' title='Show/Hide data repr'>${icon("icon-database")}</label>
    <div class='xr-var-attrs'>${summarizeAttrs(dv.attrs)}</div>
    <div class='xr-var-data'>${buildDataRepr(dv)}</div>
  `;
}

function varListHtml(vars: Record<string, ZarrVariable>, indexedNames: Set<string>): string {
  return `<ul class='xr-var-list'>${Object.entries(vars)
    .map(
      ([name, dv]) =>
        `<li class='xr-var-item'>${summarizeVariable(name, dv, indexedNames.has(name))}</li>`,
    )
    .join("")}</ul>`;
}

function collapsibleSection(
  header: string,
  inline: string,
  details: string,
  nItems: number | null,
  enabled: boolean,
  collapsed: boolean,
): string {
  const id = uid();
  const hasItems = (nItems ?? 0) > 0;
  const nSpan = nItems !== null ? ` <span>(${nItems})</span>` : "";
  const enabledA = enabled && hasItems ? "" : " disabled";
  const collapsedA = collapsed || !hasItems ? "" : " checked";
  const tip = enabledA === "" ? " title='Expand/collapse section'" : "";
  return `
    <input id='${id}' class='xr-section-summary-in' type='checkbox'${enabledA}${collapsedA} />
    <label for='${id}' class='xr-section-summary'${tip}>${header}${nSpan}</label>
    <div class='xr-section-inline-details'>${inline}</div>
    ${details ? `<div class='xr-section-details'>${details}</div>` : ""}
  `;
}

const XR_ICONS = `<svg style="position:absolute;width:0;height:0;overflow:hidden"><defs>
<symbol id="icon-database" viewBox="0 0 32 32">
  <path d="M16 0c-8.837 0-16 2.239-16 5v4c0 2.761 7.163 5 16 5s16-2.239 16-5v-4c0-2.761-7.163-5-16-5z"/>
  <path d="M16 17c-8.837 0-16-2.239-16-5v6c0 2.761 7.163 5 16 5s16-2.239 16-5v-6c0 2.761-7.163 5-16 5z"/>
  <path d="M16 26c-8.837 0-16-2.239-16-5v6c0 2.761 7.163 5 16 5s16-2.239 16-5v-6c0 2.761-7.163 5-16 5z"/>
</symbol>
<symbol id="icon-file-text2" viewBox="0 0 32 32">
  <path d="M28.681 7.159c-0.694-0.947-1.662-2.053-2.724-3.116s-2.169-2.030-3.116-2.724c-1.612-1.182-2.393-1.319-2.841-1.319h-15.5c-1.378 0-2.5 1.121-2.5 2.5v27c0 1.378 1.122 2.5 2.5 2.5h23c1.378 0 2.5-1.122 2.5-2.5v-19.5c0-0.448-0.137-1.23-1.319-2.841zM24.543 5.457c0.959 0.959 1.712 1.825 2.268 2.543h-4.811v-4.811c0.718 0.556 1.584 1.309 2.543 2.268zM28 29.5c0 0.271-0.229 0.5-0.5 0.5h-23c-0.271 0-0.5-0.229-0.5-0.5v-27c0-0.271 0.229-0.5 0.5-0.5 0 0 15.499-0 15.5 0v7c0 0.552 0.448 1 1 1h7v19.5z"/>
</symbol>
</defs></svg>`;

function renderDataset(ds: ZarrDataset): string {
  const coordNames = new Set(Object.keys(ds.coords));
  const sections: string[] = [];
  sections.push(
    collapsibleSection(
      "Dimensions:",
      formatDims(ds.dims, coordNames),
      "",
      Object.keys(ds.dims).length,
      false,
      true,
    ),
  );
  if (Object.keys(ds.coords).length) {
    sections.push(
      collapsibleSection(
        "Coordinates:",
        "",
        varListHtml(ds.coords, coordNames),
        Object.keys(ds.coords).length,
        true,
        false,
      ),
    );
  }
  sections.push(
    collapsibleSection(
      "Data variables:",
      "",
      varListHtml(ds.data_vars, new Set()),
      Object.keys(ds.data_vars).length,
      true,
      false,
    ),
  );
  if (Object.keys(ds.attrs).length) {
    sections.push(
      collapsibleSection(
        "Attributes:",
        "",
        summarizeAttrs(ds.attrs),
        Object.keys(ds.attrs).length,
        true,
        true,
      ),
    );
  }
  const sectHtml = sections.map((s) => `<li class='xr-section-item'>${s}</li>`).join("");
  return `<div class='xr-root'>
    <div class='xr-wrap'>
      <div class='xr-header'><div class='xr-obj-type'>xarray.Dataset</div></div>
      <ul class='xr-sections'>${sectHtml}</ul>
    </div>
  </div>`;
}

/** Build the xarray-style HTML repr for parsed metadata. */
export function buildXarrayRepr(result: ZarrMetadataResult): string {
  if (!result.groups) {
    return `${XR_ICONS}${renderDataset(result)}`;
  }
  const cards = Object.entries(result.groups)
    .map(
      ([name, ds]) => `
    <details open style="margin-bottom:10px;border:1px solid var(--xr-border-color);border-radius:4px;overflow:hidden">
      <summary style="padding:8px 12px;font-weight:600;cursor:pointer;background:var(--xr-background-color-row-odd);list-style:none;display:flex;align-items:center;gap:8px">
        <span style="font-size:11px;color:var(--xr-font-color2)">\u25b6</span>
        <span>Group: ${esc(name)}</span>
      </summary>
      <div style="padding:0 12px 8px">${renderDataset(ds)}</div>
    </details>
  `,
    )
    .join("");
  return `${XR_ICONS}<div style="font-family:monospace">${cards}</div>`;
}

// ── xarray CSS injection ──────────────────────────────────────────────────────
// Light-themed colors compatible with Freva's current light theme; it should
// still look decent in dark mode.

const XR_CSS = `
:root {
  --xr-font-color0: var(--jp-content-font-color0, rgba(0,0,0,1));
  --xr-font-color2: var(--jp-content-font-color2, rgba(0,0,0,.54));
  --xr-font-color3: var(--jp-content-font-color3, rgba(0,0,0,.38));
  --xr-border-color: var(--jp-border-color2, #e0e0e0);
  --xr-disabled-color: var(--jp-layout-color3, #bdbdbd);
  --xr-background-color: var(--jp-layout-color0, white);
  --xr-background-color-row-even: var(--jp-layout-color1, white);
  --xr-background-color-row-odd: var(--jp-layout-color2, #eeeeee);
}
.xr-wrap{display:block!important;min-width:300px;max-width:700px;line-height:1.6;padding-bottom:4px}
.xr-header{padding-top:6px;padding-bottom:6px;border-bottom:solid 1px var(--xr-border-color);margin-bottom:4px}
.xr-header>div,.xr-header>ul{display:inline;margin-top:0;margin-bottom:0}
.xr-obj-type,.xr-obj-name{margin-left:2px;margin-right:10px}
.xr-obj-type{color:var(--xr-font-color2)}
.xr-sections{padding-left:0!important;display:grid;grid-template-columns:150px auto auto 1fr 0 20px 0 20px;margin-block-start:0;margin-block-end:0}
.xr-section-item{display:contents}
.xr-section-item>input,.xr-var-item>input{display:block;opacity:0;height:0;margin:0}
.xr-section-item>input+label,.xr-var-item>input+label{color:var(--xr-disabled-color)}
.xr-section-item>input:enabled+label,.xr-var-item>input:enabled+label{cursor:pointer;color:var(--xr-font-color2)}
.xr-section-item>input:enabled+label:hover,.xr-var-item>input:enabled+label:hover{color:var(--xr-font-color0)}
.xr-section-summary{grid-column:1;color:var(--xr-font-color2);font-weight:500;white-space:nowrap}
.xr-section-summary>span{display:inline-block;padding-left:.3em}
.xr-section-summary-in:disabled+label{color:var(--xr-font-color2)}
.xr-section-summary-in+label:before{display:inline-block;content:"►";font-size:11px;width:15px;text-align:center}
.xr-section-summary-in:disabled+label:before{color:var(--xr-disabled-color)}
.xr-section-summary-in:checked+label:before{content:"▼"}
.xr-section-summary-in:checked+label>span{display:none}
.xr-section-summary,.xr-section-inline-details{padding-top:4px}
.xr-section-inline-details{grid-column:2/-1}
.xr-section-details{grid-column:1/-1;margin-top:4px;margin-bottom:5px}
.xr-section-summary-in~.xr-section-details{display:none}
.xr-section-summary-in:checked~.xr-section-details{display:contents}
.xr-array-wrap{grid-column:1/-1;display:grid;grid-template-columns:20px auto}
.xr-array-wrap>label{grid-column:1;vertical-align:top}
.xr-preview{color:var(--xr-font-color3)}
.xr-array-preview,.xr-array-data{padding:0 5px!important;grid-column:2}
.xr-array-data,.xr-array-in:checked~.xr-array-preview{display:none}
.xr-array-in:checked~.xr-array-data,.xr-array-preview{display:inline-block}
.xr-dim-list{display:inline-block!important;list-style:none;padding:0!important;margin:0}
.xr-dim-list li{display:inline-block;padding:0;margin:0}
.xr-dim-list:before{content:"("}
.xr-dim-list:after{content:")"}
.xr-dim-list li:not(:last-child):after{content:",";padding-right:5px}
.xr-has-index{font-weight:bold}
.xr-var-list,.xr-var-item{display:contents}
.xr-var-item>div,.xr-var-item label,.xr-var-item>.xr-var-name span{background-color:var(--xr-background-color-row-even);border-color:var(--xr-background-color-row-odd);margin-bottom:0;padding-top:2px}
.xr-var-list>li:nth-child(odd)>div,.xr-var-list>li:nth-child(odd)>label,.xr-var-list>li:nth-child(odd)>.xr-var-name span{background-color:var(--xr-background-color-row-odd);border-color:var(--xr-background-color-row-even)}
.xr-var-name{grid-column:1}
.xr-var-dims{grid-column:2}
.xr-var-dtype{grid-column:3;text-align:right;color:var(--xr-font-color2)}
.xr-var-preview{grid-column:4}
.xr-index-preview{grid-column:2/5;color:var(--xr-font-color2)}
.xr-var-name,.xr-var-dims,.xr-var-dtype,.xr-preview,.xr-attrs dt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:10px}
.xr-var-name:hover,.xr-var-dims:hover,.xr-var-dtype:hover,.xr-attrs dt:hover{overflow:visible;width:auto;z-index:1}
.xr-var-attrs,.xr-var-data,.xr-index-data{display:none;border-top:2px dotted var(--xr-background-color);padding-bottom:20px!important;padding-top:10px!important}
.xr-var-attrs-in:checked~.xr-var-attrs,.xr-var-data-in:checked~.xr-var-data{display:block}
.xr-var-data>table{float:right}
.xr-var-data>pre,.xr-var-data>table>tbody>tr{background-color:transparent!important}
.xr-var-name span,.xr-var-data,.xr-attrs{padding-left:25px!important}
.xr-attrs,.xr-var-attrs,.xr-var-data,.xr-index-data{grid-column:1/-1}
dl.xr-attrs{padding:0;margin:0;display:grid;grid-template-columns:125px auto}
.xr-attrs dt,.xr-attrs dd{padding:0;margin:0;float:left;padding-right:10px;width:auto}
.xr-attrs dt{font-weight:normal;grid-column:1}
.xr-attrs dd{grid-column:2;white-space:pre-wrap;word-break:break-all}
.xr-icon-database,.xr-icon-file-text2{display:inline-block;vertical-align:middle;width:1em;height:1.5em!important;stroke-width:0;stroke:currentColor;fill:currentColor}
.xr-var-attrs-in:checked+label>.xr-icon-file-text2,.xr-var-data-in:checked+label>.xr-icon-database{color:var(--xr-font-color0);filter:drop-shadow(1px 1px 5px var(--xr-font-color2));stroke-width:.8px}
.xr-var-item>input+label{cursor:pointer;color:var(--xr-font-color2);padding:0 1px}
`;

let cssInjected = false;

/**
 * Inject the xarray repr CSS into `<head>` exactly once. The chunk-cube color
 * variables are derived from `mainColor` (default `window.MAIN_COLOR`, then
 * `#9b7a52`). A no-op outside the browser or after the first call.
 */
export function injectXarrayCss(options: InjectCssOptions = {}): void {
  if (cssInjected) return;
  if (typeof document === "undefined") return;
  cssInjected = true;

  const fromWindow =
    typeof window !== "undefined"
      ? (window as unknown as { MAIN_COLOR?: string }).MAIN_COLOR
      : undefined;
  const hex = (options.mainColor ?? fromWindow ?? "#9b7a52").replace(/^#/, "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const cl = (f: number): string =>
    `rgb(${Math.min(255, (r * f) | 0)},${Math.min(255, (g * f) | 0)},${Math.min(255, (b * f) | 0)})`;
  const ca = (f: number, a: number): string =>
    `rgba(${Math.min(255, (r * f) | 0)},${Math.min(255, (g * f) | 0)},${Math.min(255, (b * f) | 0)},${a})`;
  // Inverted accent for the cube edges.
  const inv = `rgb(${255 - r},${255 - g},${255 - b})`;
  const chunkVars = `
    :root{--xr-chunk-face:${cl(0.85)};--xr-chunk-top:${cl(1.25)};--xr-chunk-side:${cl(0.55)};--xr-chunk-edge:${inv}}
    html[data-theme="dark"],body[data-theme="dark"],body.vscode-dark{
      --xr-chunk-face:${ca(0.85, 0.65)};--xr-chunk-top:${ca(1.25, 0.65)};--xr-chunk-side:${ca(0.55, 0.65)};--xr-chunk-edge:${inv}
    }
  `;

  const style = document.createElement("style");
  style.setAttribute("data-xarray-repr", "1");
  style.textContent = chunkVars + XR_CSS;
  document.head.appendChild(style);
}

/**
 * Convenience: fetch a store's metadata and return the xarray-style HTML repr,
 * injecting the CSS first (unless `injectCss: false`). This is the
 * framework-agnostic equivalent of the former server `/zarr-utils/html`
 * endpoint, and the building block for a React `useHtmlMetadata` hook.
 */
export async function loadZarrMetadataHtml(
  url: string,
  options: LoadMetadataOptions = {},
): Promise<string> {
  if (options.injectCss !== false) injectXarrayCss({ mainColor: options.mainColor });
  const ds = await openDatasetMeta(url, { getAuthHeaders: options.getAuthHeaders });
  return buildXarrayRepr(ds);
}
