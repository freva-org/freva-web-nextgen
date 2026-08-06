// metadata.ts - the metadata.js contract. Two sources feed one
// facetKey -> (value -> description) map: the mount-config `metadata` object and, optionally, the
// deployment `metadata.js` script. Config WINS per (key, value). Everything degrades silently
// when a source is absent or malformed - a missing description is just no tooltip, never an error.
//
// A <script src> whose body assigns per-facet window globals
// (window.project = { cmip6: '…' }, …). We read only an ALLOW-LIST of known facet
// keys off the global, never arbitrary globals, and every description reaches the DOM via
// textContent in the consumers - this module only produces plain strings.

import type { Disposables } from "./dom.js";
import { ADDITIONAL_FACET_FALLBACK, PRIMARY_FACET_FALLBACK } from "./state.js";
import type { MetadataMap, FacetDescriptions, ResolvedConfig } from "./types.js";

/** The facet keys we will read off the metadata.js global (superset of both fallback lists). */
export const METADATA_FACET_KEYS: string[] = [
  ...new Set([...PRIMARY_FACET_FALLBACK, ...ADDITIONAL_FACET_FALLBACK]),
];

/** True for a plain object whose own entries are all string->string (a FacetDescriptions block). */
function isDescriptionBlock(v: unknown): v is FacetDescriptions {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== "string") return false;
  }
  return true;
}

/**
 * Read the allow-listed facet globals off a source object (in production: `window`). Only keys
 * in `keys` are considered, and only when their value is a string->string block; anything else is
 * ignored. Returns a fresh map (never references the source objects).
 */
export function readScriptGlobals(
  source: Record<string, unknown>,
  keys: string[] = METADATA_FACET_KEYS,
): MetadataMap {
  const out: MetadataMap = {};
  for (const key of keys) {
    const block = source[key];
    if (isDescriptionBlock(block) && Object.keys(block).length > 0) {
      out[key] = { ...block };
    }
  }
  return out;
}

/**
 * Merge two metadata maps with `override` winning per (key, value). `base` (the script) fills
 * gaps; `override` (config) takes priority on conflicts. Neither input is mutated.
 */
export function mergeMetadata(base: MetadataMap, override: MetadataMap): MetadataMap {
  const out: MetadataMap = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
    out[key] = { ...(base[key] ?? {}), ...(override[key] ?? {}) };
  }
  return out;
}

/** Defensive normalisation of a config-supplied metadata object (drop non-string entries). */
export function sanitizeConfigMetadata(m: MetadataMap | undefined): MetadataMap {
  if (!m || typeof m !== "object") return {};
  const out: MetadataMap = {};
  for (const [key, block] of Object.entries(m)) {
    if (isDescriptionBlock(block)) out[key] = { ...block };
  }
  return out;
}

/**
 * Load the deployment metadata.js and resolve to the facet globals it assigns. It PROBES the URL
 * with fetch first and only injects a <script> when the response is really JavaScript - so a
 * missing file, a 404 HTML page, or a "Not found" body never reaches a <script> tag (which would
 * throw an UNCATCHABLE SyntaxError in the console). Absent/invalid -> resolves to {} silently. The
 * script node is tracked on `dis` so destroy() removes it.
 */
export async function loadMetadataScript(
  url: string,
  dis: Disposables,
  root: HTMLElement,
  timeoutMs = 8000,
): Promise<MetadataMap> {
  if (typeof fetch !== "function" || typeof document === "undefined") return {};
  // 1) Probe - never execute an error page. The probe is aborted on destroy. The timeout must
  // cover the WHOLE probe (connect -> headers -> body): a server that sends headers then stalls on
  // the body would otherwise hang res.text() forever, so the timer is cleared in finally, not
  // before reading the body.
  const ctrl = dis.abortController(); // aborted when the browser is destroyed
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: "same-origin" });
    if (!res.ok) return {};
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    const body = await res.text();
    // POSITIVE allow-list: only real JavaScript MIME types, or a generic/absent type on a .js URL
    // that isn't obviously HTML. This rejects application/json, XML, images, etc.
    const isJsMime = ct.includes("javascript") || ct.includes("ecmascript");
    const generic = ct === "" || ct.includes("application/octet-stream");
    const urlIsJs = /\.m?js(?:[?#]|$)/i.test(url);
    const looksHtml = /^\s*</.test(body);
    if (!(isJsMime || (generic && urlIsJs && !looksHtml))) return {};
  } catch {
    return {}; // network error / abort / CORS - degrade silently
  } finally {
    clearTimeout(timer); // always clear, incl. on abort/throw (no orphaned timer)
  }
  if (dis.isDisposed) return {}; // destroyed while probing - don't touch the (detached) tree
  // 2) It's JavaScript - inject via <script src> (CSP-friendly; served from cache) and read the
  // allow-listed globals it assigned.
  return new Promise<MetadataMap>((resolve) => {
    let settled = false;
    const finish = (m: MetadataMap): void => {
      if (!settled) {
        settled = true;
        resolve(m);
      }
    };
    let script: HTMLScriptElement;
    try {
      script = document.createElement("script");
    } catch {
      finish({});
      return;
    }
    script.src = url;
    script.async = true;
    script.addEventListener("load", () => {
      const w = (typeof window !== "undefined" ? window : {}) as unknown as Record<string, unknown>;
      finish(readScriptGlobals(w));
    });
    script.addEventListener("error", () => finish({}));
    // On destroy OR timeout: remove the script AND resolve (never leave the promise pending, never
    // let a slow script mutate globals after we've given up).
    dis.add(() => {
      script.remove();
      finish({});
    });
    dis.setTimeout(() => {
      script.remove();
      finish({});
    }, timeoutMs);
    root.appendChild(script);
  });
}

/**
 * The config-supplied metadata, available synchronously at mount (so descriptions render before
 * any script lands). The async script, if enabled, is merged UNDER this later.
 */
export function initialMetadata(cfg: ResolvedConfig): MetadataMap {
  return sanitizeConfigMetadata(cfg.metadata);
}

/**
 * Kick off the deployment-script load (if enabled) and return the merged result (config wins).
 * The caller applies the result to state and re-renders. Config-only when metadataScriptUrl is
 * null/empty. Always resolves - never rejects.
 */
export async function resolveMetadata(
  cfg: ResolvedConfig,
  dis: Disposables,
  root: HTMLElement,
): Promise<MetadataMap> {
  const config = sanitizeConfigMetadata(cfg.metadata);
  const url = cfg.metadataScriptUrl;
  if (!url) return config;
  const fromScript = await loadMetadataScript(url, dis, root);
  return mergeMetadata(fromScript, config);
}
