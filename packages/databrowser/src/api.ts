// api.ts - typed fetch wrappers against /api/freva-nextgen/databrowser/.
// All requests use credentials:"same-origin". Search/metadata/details requests are
// aborted-on-supersede per channel and tagged with a monotonic request id so the
// controller can drop stale responses.

import type { Disposables } from "./dom.js";
import type { OverviewResult, ResolvedConfig, SearchResult, UniqKey } from "./types.js";
import { STREAM_TOO_BIG_DETAIL } from "./types.js";
import { buildSearchUrl } from "./search/query.js";

const enc = encodeURIComponent;

export class ApiError extends Error {
  readonly status: number;
  readonly detail?: string;
  readonly aborted: boolean;
  constructor(status: number, message: string, detail?: string, aborted = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.aborted = aborted;
  }
}

/** Map an HTTP status (and optional server detail) to a short user-facing message. */
export function mapError(status: number, detail?: string): string {
  switch (status) {
    case 401:
      return "Sign in again to continue.";
    case 403:
      return "Access denied.";
    case 404:
      return "Not found - it may be temporarily unavailable.";
    case 413:
      return "Result set too large - narrow your search.";
    case 422:
      return detail ? `Invalid query: ${detail}` : "Invalid query - check your facets.";
    case 429:
      return "Rate-limited - wait a moment and try again.";
    case 500:
    case 503:
      return "Service error - try again.";
    default:
      return `Request failed (${status}).`;
  }
}

export interface ZarrStatus {
  status: number; // ready when === 0
  reason: string;
}

export class Api {
  private readonly base: string;
  private readonly cfg: ResolvedConfig;
  private readonly channels = new Map<string, AbortController>();
  private readonly oneOffSet = new Set<AbortController>();
  private reqCounter = 0;

  constructor(cfg: ResolvedConfig, dis: Disposables) {
    this.cfg = cfg;
    this.base = cfg.apiBase.replace(/\/+$/, "");
    // destroy() aborts every controller this Api ever handed out.
    dis.add(() => {
      for (const ac of this.channels.values()) ac.abort();
      for (const ac of this.oneOffSet) ac.abort();
    });
  }

  /** Monotonic id for stale-response suppression at the call site. */
  nextRequestId(): number {
    return ++this.reqCounter;
  }

  /** Number of one-off (non-channel) requests currently in flight - observability. */
  oneOffPending(): number {
    return this.oneOffSet.size;
  }

  /** Abort the previous in-flight request on `channel`, return a fresh signal. */
  channelSignal(channel: string): AbortSignal {
    this.channels.get(channel)?.abort();
    const ac = new AbortController();
    this.channels.set(channel, ac);
    return ac.signal;
  }

  /**
   * Run a one-off (non-channel) request with a tracked AbortController that is removed from the
   * `oneOff` set once it settles, so the set can't grow across exports/autocomplete/CRUD.
   * In-flight controllers remain tracked and are aborted by destroy().
   */
  private async oneOff<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    this.oneOffSet.add(ac);
    try {
      return await run(ac.signal);
    } finally {
      this.oneOffSet.delete(ac);
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.cfg.authEnabled) {
      const tok = this.cfg.getAuthToken();
      if (tok) h["Authorization"] = `Bearer ${tok}`;
    }
    // OIDC is bearer-only; CSRF header is opt-in and sent only when a token is supplied.
    const csrf = this.cfg.getCsrfToken();
    if (csrf) h["X-CSRFToken"] = csrf;
    return h;
  }

  private async request(url: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    const { headers, ...rest } = init ?? {};
    try {
      res = await fetch(url, {
        ...rest,
        credentials: "same-origin",
        // headers MUST be merged last: spreading `...rest` first lets an init-supplied
        // headers object (e.g. Content-Type on a JSON POST) drop the Authorization bearer.
        headers: this.headers(headers as Record<string, string> | undefined),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new ApiError(0, "Request aborted.", undefined, true);
      }
      throw new ApiError(0, "Network error - check your connection.");
    }
    if (!res.ok) {
      let detail: string | undefined;
      try {
        const body = (await res.clone().json()) as { detail?: unknown };
        if (typeof body.detail === "string") detail = body.detail;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, mapError(res.status, detail), detail);
    }
    return res;
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.request(url, init);
    return (await res.json()) as T;
  }

  // URL builders

  // Delegates to the SHARED builder in search/query.ts. The picker's transport calls the same
  // function, which is what makes "the same serialized search state produces the same effective
  // REST query in both" a property of the code rather than a coincidence.
  private searchUrl(
    endpoint: "extended-search" | "metadata-search",
    flavour: string,
    uniqKey: UniqKey,
    query: string,
    opts?: { maxResults?: number; start?: number },
  ): string {
    return buildSearchUrl(this.base, endpoint, flavour, uniqKey, query, opts ?? {});
  }

  catalogueUrl(kind: "intake" | "stac", flavour: string, uniqKey: UniqKey, query: string): string {
    // max-results=100000 gives server-side protection: a too-big stream returns 413.
    let url = `${this.base}/${kind}-catalogue/${enc(flavour)}/${uniqKey}?translate=true&max-results=100000`;
    if (query) url += `&${query}`;
    return url;
  }

  /** URI manifest (data-search -> plain-text list of file URIs). Scoped exactly like the catalogue
   *  endpoints - translate=true + the max-results cap that makes a too-big query return 413 - so
   *  the manifest download rides the same query params and the same export gating as stac/intake. */
  dataSearchUrl(flavour: string, uniqKey: UniqKey, query: string): string {
    let url = `${this.base}/data-search/${enc(flavour)}/${uniqKey}?translate=true&max-results=100000`;
    if (query) url += `&${query}`;
    return url;
  }

  // Search

  /** Main search - rows are {file|uri, fs_type}. No extra per-row fields are requested. */
  extendedSearch(
    flavour: string,
    uniqKey: UniqKey,
    query: string,
    opts?: { start?: number; signal?: AbortSignal },
  ): Promise<SearchResult> {
    const url = this.searchUrl("extended-search", flavour, uniqKey, query, {
      maxResults: 100,
      start: opts?.start,
    });
    return this.json<SearchResult>(url, { signal: opts?.signal });
  }

  /** Facets + counts, no rows - used for debounced overview recount and autocomplete. */
  metadataSearch(
    flavour: string,
    uniqKey: UniqKey,
    query: string,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    // NOTE (unverified): this reuses searchUrl(), which appends translate=true. extended-search
    // accepts it; metadata-search is ASSUMED to accept it too. If a live endpoint rejects the
    // param, drop it for this call (overview recount / autocomplete would otherwise degrade).
    const url = this.searchUrl("metadata-search", flavour, uniqKey, query, {});
    return this.json<SearchResult>(url, { signal });
  }

  /** overview returns { flavours, attributes } ONLY - no facet_mapping. */
  overview(): Promise<OverviewResult> {
    return this.oneOff((signal) => this.json<OverviewResult>(`${this.base}/overview`, { signal }));
  }

  /**
   * Per-file metadata for the details panel. PATH-ONLY: it always constrains by `file=` against
   * the `/file` path, irrespective of state.uniqKey - a URI-keyed detail lookup is unverified, so
   * the name makes the helper hard to misuse. One or many files via repeated file=; full per-file
   * facets come back in the response's `facets` block (search_results stays the thin
   * {file,fs_type}). `fields=time&fields=bbox` asks the backend to include the spatial/temporal
   * extent on each search_result row:
   *   "time": "[0001-01-01T00:00:00 TO 9999-12-31T23:59:00]"
   *   "bbox": ["ENVELOPE(0, 360, 90, -90)"]      (Solr: minX, maxX, maxY, minY)
   * Both are OPTIONAL - an index without them simply omits the keys, and the panel keeps its
   * existing "not available" default rather than inventing an extent.
   */
  filePathMetadata(flavour: string, files: string[], signal?: AbortSignal): Promise<SearchResult> {
    const fileQuery = files.map((f) => `file=${enc(f)}`).join("&");
    const url =
      `${this.base}/extended-search/${enc(flavour)}/file?max-results=100&translate=true` +
      `&fields=time&fields=bbox&${fileQuery}`;
    return this.json<SearchResult>(url, { signal });
  }

  // Catalogue export (handles the exact 413 string)

  /**
   * Catalogue download. Returns the raw Response so the CONTROLLER can consume `res.body`
   * incrementally with progress feedback and trigger the download itself - no DOM code in the Api
   * layer, no whole-response buffering here. Deliberately NOT on the shared `export` abort channel:
   * starting a second download must not cancel the first. Callers pass their own signal (tied to
   * destroy()).
   */
  catalogueResponse(
    kind: "intake" | "stac",
    flavour: string,
    uniqKey: UniqKey,
    query: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.request(this.catalogueUrl(kind, flavour, uniqKey, query), { signal });
  }

  /** URI manifest stream (data-search). Bearer-token download path only - the no-auth path hands
   *  the URL straight to the browser, same as the catalogue endpoints. */
  manifestResponse(
    flavour: string,
    uniqKey: UniqKey,
    query: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.request(this.dataSearchUrl(flavour, uniqKey, query), { signal });
  }

  /** Stream of plain-text paths from data-search. */
  async dataSearchText(flavour: string, uniqKey: UniqKey, query: string): Promise<string> {
    const res = await this.oneOff((signal) =>
      this.request(this.dataSearchUrl(flavour, uniqKey, query), { signal }),
    );
    return res.text();
  }

  // Heavy ops (auth.required - gated by config.authEnabled)

  /** load/{flavour} is a GET (status 201) that streams zarr URLs; 503 if the service is off. */
  async load(flavour: string, query: string): Promise<string> {
    const url = `${this.base}/load/${enc(flavour)}?${query}`;
    const res = await this.oneOff((signal) => this.request(url, { method: "GET", signal }));
    return res.text();
  }

  /** Aggregation is a parameter of convert (aggregate: auto|merge|concat). */
  zarrConvert(body: {
    path: string[];
    aggregate?: "auto" | "merge" | "concat";
    dim?: string;
    compat?: string;
    ttl_seconds?: number;
    public?: boolean;
  }): Promise<{ urls: string[] }> {
    return this.oneOff((signal) =>
      this.json<{ urls: string[] }>(`${this.base}/data-portal/zarr/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    );
  }

  /** Poll conversion status; ready when status === 0. */
  zarrStatus(streamUrl: string): Promise<ZarrStatus> {
    return this.oneOff((signal) =>
      this.json<ZarrStatus>(`${this.base}/data-portal/zarr-utils/status?url=${enc(streamUrl)}`, {
        signal,
      }),
    );
  }

  shareZarr(body: { path: string; ttl_seconds?: number }): Promise<{ url: string }> {
    return this.oneOff((signal) =>
      this.json<{ url: string }>(`${this.base}/data-portal/share-zarr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    );
  }

  zarrHtmlUrl(streamUrl: string): string {
    return `${this.base}/data-portal/zarr-utils/html?url=${enc(streamUrl)}`;
  }

  // Flavours (read)

  listFlavours(): Promise<{
    flavours?: Array<{ flavour_name?: string; mapping?: Record<string, string>; owner?: string }>;
  }> {
    return this.oneOff((signal) => this.json(`${this.base}/flavours`, { signal }));
  }
}

export { STREAM_TOO_BIG_DETAIL };
