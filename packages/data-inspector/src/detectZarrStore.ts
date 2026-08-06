/**
 * detectZarrStore
 *
 * Framework-agnostic probe that checks whether a URL already points at a Zarr
 * store. When it does, a host can skip the server-side conversion step and
 * stream/render the store directly.
 */

import { defaultGetAuthHeaders, normalizeUrl } from "./internal/http";

/** Result of probing a URL for a Zarr store. */
export interface ZarrStoreInfo {
  /** Whether the URL points at a readable Zarr store. */
  isZarr: boolean;
  /** Detected Zarr format version, or `null` when it is not a Zarr store. */
  version: 2 | 3 | null;
  /**
   * Whether consolidated metadata is available - i.e. the store can be
   * rendered client-side. v2 `.zmetadata` is consolidated by definition;
   * v3 requires a `consolidated_metadata` key in `zarr.json`.
   *
   * Non-consolidated stores are still Zarr and can skip conversion, but have
   * no client-side metadata view until server-side rendering is available.
   */
  consolidated: boolean;
}

/** Options for {@link detectZarrStore}. */
export interface DetectZarrStoreOptions {
  /**
   * Override auth header injection.
   * Default: reads a Bearer token from the `freva_auth_token` cookie.
   */
  getAuthHeaders?: () => Record<string, string>;
  /** Abort each probe request after this many ms. Default: 5000. */
  timeoutMs?: number;
}

const NOT_ZARR: ZarrStoreInfo = { isZarr: false, version: null, consolidated: false };

/**
 * Checks whether a URL already points to a Zarr store by probing
 * `.zmetadata` (v2 consolidated) and then `zarr.json` (v2/v3).
 *
 * Consolidated metadata is tried first (the browser equivalent of
 * `zarr.open_consolidated`), then bare group detection (`zarr.open_group`).
 */
export async function detectZarrStore(
  url: string,
  options: DetectZarrStoreOptions = {},
): Promise<ZarrStoreInfo> {
  if (!url) return { ...NOT_ZARR };

  // Defensive: a percent-encoded URL would be treated as a relative path by
  // the browser, so decode it before fetching.
  const base = normalizeUrl(url).replace(/\/$/, "");
  const getAuthHeaders = options.getAuthHeaders ?? defaultGetAuthHeaders;
  const opts: RequestInit = {
    credentials: "same-origin",
    headers: getAuthHeaders(),
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  };

  // v2: .zmetadata is consolidated by definition.
  try {
    const r = await fetch(`${base}/.zmetadata`, opts);
    if (r.ok) return { isZarr: true, version: 2, consolidated: true };
  } catch {
    /* probe failed; fall through to zarr.json */
  }

  // v2/v3: zarr.json; read the zarr_format field to determine the version.
  // xarray does the equivalent via zarr_group.metadata.zarr_format after
  // calling zarr.open_consolidated() or zarr.open_group().
  try {
    const r = await fetch(`${base}/zarr.json`, opts);
    if (r.ok) {
      const json = (await r.json()) as { zarr_format?: number };
      const version = json.zarr_format;
      if (version === 2 || version === 3) {
        // A consolidated_metadata key means the store is renderable
        // client-side. v2 reached via zarr.json has no .zmetadata, so it is
        // never consolidated through this path.
        const consolidated = version === 3 ? "consolidated_metadata" in json : false;
        return { isZarr: true, version, consolidated };
      }
    }
  } catch {
    /* probe failed; fall through to NOT_ZARR */
  }

  return { ...NOT_ZARR };
}
