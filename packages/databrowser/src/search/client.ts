// search/client.ts - the DEFAULT transport for the headless search engine: freva-rest, reached
// through the shared URL builder.
//
// Deliberately much smaller than `api.ts`: this speaks only the two read endpoints a picker needs
// (search and overview), so the picker entry never pulls in catalogue streaming, zarr conversion,
// share links or the inspector.
//
// Credentials: an OPTIONAL bearer supplier is called per request and the token is used for that
// request only. It is never stored on the client object, never copied into any state the picker
// exposes, and never reaches a `DataReference`. A host that would rather not hand over a token can
// inject its own `SearchClient` instead.

import type { OverviewResult, SearchResult, UniqKey } from "../types.js";
import { buildSearchUrl } from "./query.js";
import { SearchAborted, type SearchClient, type SearchRequest } from "./engine.js";

export class SearchHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SearchHttpError";
    this.status = status;
  }
}

/** Short, user-facing text for a status code - the same wording the full browser uses. */
export function describeStatus(status: number): string {
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
      return "Invalid query - check your filters.";
    case 429:
      return "Rate-limited - wait a moment and try again.";
    case 500:
    case 503:
      return "Service error - try again.";
    default:
      return `Request failed (${status}).`;
  }
}

export interface RestSearchClientOptions {
  apiBase: string;
  /** Injectable for tests and for hosts that wrap fetch; defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Optional bearer supplier. Called per request; the token is never retained. */
  getAuthToken?: () => string | null | undefined;
}

export interface RestSearchClient extends SearchClient {
  /** Flavours + attribute keys, for the optional flavour control and the facet vocabulary. */
  overview(signal?: AbortSignal): Promise<OverviewResult>;
  /** Per-flavour key mappings, so `_not_` keys translate correctly on a lens switch. */
  flavours(signal?: AbortSignal): Promise<{
    flavours?: Array<{ flavour_name?: string; mapping?: Record<string, string> }>;
  }>;
}

export function createRestSearchClient(opts: RestSearchClientOptions): RestSearchClient {
  const base = opts.apiBase.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  const request = async (url: string, signal?: AbortSignal): Promise<Response> => {
    const headers: Record<string, string> = {};
    const token = opts.getAuthToken?.();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(url, { credentials: "same-origin", headers, signal });
    } catch (e) {
      if (typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError") {
        throw new SearchAborted();
      }
      throw new SearchHttpError(0, "Network error - check your connection.");
    }
    if (!res.ok) throw new SearchHttpError(res.status, describeStatus(res.status));
    return res;
  };

  return {
    async search(req: SearchRequest): Promise<SearchResult> {
      const url = buildSearchUrl(base, "extended-search", req.flavour, req.uniqKey, req.query, {
        maxResults: req.maxResults,
        start: req.start,
      });
      const res = await request(url, req.signal);
      return (await res.json()) as SearchResult;
    },
    async overview(signal?: AbortSignal): Promise<OverviewResult> {
      const res = await request(`${base}/overview`, signal);
      return (await res.json()) as OverviewResult;
    },
    async flavours(signal?: AbortSignal): Promise<{
      flavours?: Array<{ flavour_name?: string; mapping?: Record<string, string> }>;
    }> {
      const res = await request(`${base}/flavours`, signal);
      return (await res.json()) as {
        flavours?: Array<{ flavour_name?: string; mapping?: Record<string, string> }>;
      };
    },
  };
}

/** A `UniqKey` guard for state restored from a host. */
export function asUniqKey(v: unknown): UniqKey {
  return v === "uri" ? "uri" : "file";
}
