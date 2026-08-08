// search/engine.ts - the DOM-free search lifecycle: debounce, abort-on-supersede, monotonic
// request ids and stale-response suppression, over an INJECTABLE transport.
//
// The full browser's controller already implements this discipline inline against its own render
// functions (see index.ts `runSearch`/`commitSearch`). This module is the same discipline expressed
// without any view, so the picker gets it without importing the application - and so the rules can
// be tested directly instead of only through a mounted component.
//
// Three separate guards, because they answer different questions:
//   • the ABORT signal stops the network work of a superseded request;
//   • the monotonic REQUEST ID stops a response that raced past its successor from committing;
//   • the QUERY REVISION stops a response fetched for a query the caller has since changed, even
//     when it is still the newest request in flight.
//
// Nothing here reads the DOM, `window.location`, or any credential.

import type { SearchResult, UniqKey } from "../types.js";

export interface SearchRequest {
  flavour: string;
  uniqKey: UniqKey;
  /** Encoded wire query from `effectiveSearchQuery().queryString`. */
  query: string;
  /** Offset for incremental pagination. */
  start: number;
  maxResults: number;
  signal: AbortSignal;
}

/**
 * The transport seam. A host may supply its own (a mock, a proxy, a cached client); the default is
 * `createRestSearchClient`, which talks to freva-rest.
 */
export interface SearchClient {
  search(req: SearchRequest): Promise<SearchResult>;
}

/** Raised when a request is cancelled; callers must treat it as "nothing happened". */
export class SearchAborted extends Error {
  constructor() {
    super("Search aborted.");
    this.name = "SearchAborted";
  }
}

export interface SearchEngineOptions {
  client: SearchClient;
  debounceMs?: number;
  maxResults?: number;
  /** Called synchronously when a run actually begins (after the debounce). */
  onStart?: (append: boolean) => void;
  /** Called with a result that passed every staleness guard. */
  onResult: (res: SearchResult, ctx: { append: boolean; start: number }) => void;
  /** Called with a real (non-abort, non-stale) failure. */
  onError: (err: unknown, ctx: { append: boolean }) => void;
}

export interface SearchEngine {
  /** Note that the query changed: aborts in flight work and schedules a debounced fresh search. */
  commit(build: () => Omit<SearchRequest, "signal" | "start" | "maxResults">): void;
  /** Run immediately, no debounce (retry, or the first paint). */
  runNow(build: () => Omit<SearchRequest, "signal" | "start" | "maxResults">, start?: number): void;
  /** Append the next page. Refused when the visible rows belong to a superseded query. */
  loadMore(
    build: () => Omit<SearchRequest, "signal" | "start" | "maxResults">,
    start: number,
  ): void;
  /**
   * Abort in-flight work and drop any pending debounced run WITHOUT scheduling a replacement.
   * Used when the caller has decided it must not ask the server anything yet - the picker's
   * fail-closed scoping is the motivating case: a request that cannot be scoped correctly must not
   * merely be superseded later, it must never be sent.
   */
  cancel(): void;
  /** True while a run is in flight. */
  readonly pending: boolean;
  /** The revision the currently-delivered rows belong to - compare before paginating. */
  readonly resultRevision: number;
  readonly revision: number;
  destroy(): void;
}

export const DEFAULT_SEARCH_DEBOUNCE_MS = 250;

export function createSearchEngine(opts: SearchEngineOptions): SearchEngine {
  const debounceMs = opts.debounceMs ?? DEFAULT_SEARCH_DEBOUNCE_MS;
  const maxResults = opts.maxResults ?? 100;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let requestId = 0;
  let lastRequestId = 0;
  let revision = 0;
  let resultRevision = 0;
  let pending = false;
  let destroyed = false;

  const abortInFlight = (): void => {
    controller?.abort();
    controller = null;
  };

  async function run(
    build: () => Omit<SearchRequest, "signal" | "start" | "maxResults">,
    append: boolean,
    start: number,
  ): Promise<void> {
    if (destroyed) return;
    const id = ++requestId;
    lastRequestId = id;
    const rev = revision;
    abortInFlight();
    const ac = new AbortController();
    controller = ac;
    pending = true;
    opts.onStart?.(append);
    try {
      const res = await opts.client.search({ ...build(), start, maxResults, signal: ac.signal });
      // Both guards, in this order: a newer request wins outright, and a response for a query the
      // caller has since changed is discarded even if it is still the newest request.
      if (destroyed || lastRequestId !== id || revision !== rev) return;
      pending = false;
      resultRevision = rev;
      opts.onResult(res, { append, start });
    } catch (e) {
      if (isAbort(e)) return; // an aborted request never reports anything
      if (destroyed || lastRequestId !== id || revision !== rev) return;
      pending = false;
      opts.onError(e, { append });
    } finally {
      if (controller === ac) controller = null;
    }
  }

  return {
    commit(build) {
      if (destroyed) return;
      // Bump SYNCHRONOUSLY, before the debounce: an in-flight response that settles during the
      // debounce window belongs to the previous query and must not commit.
      revision++;
      abortInFlight();
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void run(build, false, 0);
      }, debounceMs);
    },
    cancel() {
      // Bump the revision too: anything already in flight now belongs to a superseded query and
      // must not commit even if its response beats the abort.
      revision++;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      abortInFlight();
      pending = false;
    },
    runNow(build, start = 0) {
      if (destroyed) return;
      revision++;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      void run(build, false, start);
    },
    loadMore(build, start) {
      if (destroyed || pending) return;
      // The visible rows belong to a query the caller has already changed; appending would splice a
      // new-query page onto old-query rows at the old offset.
      if (resultRevision !== revision) return;
      void run(build, true, start);
    },
    get pending() {
      return pending;
    },
    get resultRevision() {
      return resultRevision;
    },
    get revision() {
      return revision;
    },
    destroy() {
      destroyed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      abortInFlight();
    },
  };
}

/** `AbortError` arrives as a DOMException in browsers and as a plain error elsewhere. */
export function isAbort(e: unknown): boolean {
  if (e instanceof SearchAborted) return true;
  return typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError";
}
