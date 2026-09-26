// attachInspector drives a <data-inspector> (a view that only draws and fires `inspector-submit`)
// through a read: one implementation for every host. Two routes, in this order:
//   1. Already zarr - one http(s) link or `.zarr` path, read in the browser. A store the auth hook
//      sends a token to is protected: GridLook cannot send it, so it gets a token-free share link.
//   2. The data-loader (needs `dataPortalBase`) - anything else: `POST /zarr/convert`, poll
//      `/zarr-utils/status`, read the store, with a `/share-zarr` link for GridLook.
// Auth is a hook, never a dependency: every request asks `getAuthHeaders(url)`, and a data-portal
// request it adds no `Authorization` header to (any case) is anonymous.

import { loadZarrMetadataHtml, ZarrMetadataError } from "./zarr-metadata";
import { resolveAuthHeaders, type GetAuthHeaders } from "./internal/http";

/** What the host passes to {@link attachInspector}. Everything is optional. */
export interface AttachInspectorOptions {
  /**
   * freva-rest data-portal base, e.g. `/api/freva-nextgen/data-portal`: enables conversion,
   * aggregation and share links. Omit (or null) to read only stores that already are zarr.
   */
  dataPortalBase?: string | null;
  /**
   * Allow conversion (default: true with `dataPortalBase`). False, for a data-portal without its
   * data-loader: stores are still read and shared, but other files are reported as not convertible.
   */
  dataLoader?: boolean;
  /**
   * Auth headers for each request, decided per URL (may be async). Default: the legacy
   * `freva_auth_token` cookie, same-origin requests only. Pass `() => ({})` to never send any.
   */
  getAuthHeaders?: GetAuthHeaders;
  /** Starts the host's sign-in; offered as a "Sign in" button when that is what is missing. */
  signIn?: (() => void) | null;
  /** Which inputs are read directly. Default: an http(s) link, or a path ending in `.zarr`. */
  isStore?: (target: string) => boolean;
  /** Lifetime of the share links made for display and GridLook, in seconds. Default 3600. */
  shareTtlSeconds?: number;
  /** Poll interval for the conversion status, in ms. Default 1500. */
  pollMs?: number;
  /**
   * How long status 5 ("unknown") after a convert still means queued, in ms. Default 30000:
   * freva-rest answers 5 until the worker writes the job's first status.
   */
  startupGraceMs?: number;
  /** Conversion deadline when the dialog did not set one, in seconds. Default 300. */
  timeoutSeconds?: number;
}

/** What {@link attachInspector} returns. */
export interface InspectorController {
  /** Read `target` (one path or URL; several paths to aggregate) with optional loader options. */
  load(target: string | string[], options?: Record<string, unknown> | null): Promise<void>;
  /** Stop listening and cancel whatever is in flight. Call when the dialog goes away. */
  detach(): void;
}

/** The element properties/attributes this module drives (a plain HTMLElement works too). */
type InspectorElementLike = HTMLElement & {
  output?: string | null;
  error?: string | null;
  aggregationConfig?: Record<string, unknown> | null;
  loadOptions?: Record<string, unknown> | null;
};

/** An http(s) link, or a path ending in `.zarr`. */
export function looksLikeStore(target: string): boolean {
  const t = target.trim();
  return /^https?:\/\//i.test(t) || /\.zarr\/?$/i.test(t);
}

/** Whether the headers carry `Authorization`, in any letter case. */
function hasAuthorization(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
}

/** A freva share link (`…/data-portal/share/…`) needs no token. */
function isShareLink(url: string): boolean {
  return /\/data-portal\/share\//.test(url);
}

/**
 * Data-loader status codes (freva-rest STATUS_LOOKUP): 0 ready, 3 waiting, 4 processing,
 * 1/2/6 terminal failures, 5 unknown - "not picked up yet" right after a convert, "gone" later.
 */
const STATUS_READY = 0;
const STATUS_UNKNOWN = 5;
const STATUS_TERMINAL: Record<number, string> = {
  1: "The data-loader could not convert this data",
  2: "The data-loader could not find this file",
  5: "The conversion is gone - it expired, or the data-loader never picked it up",
  6: "You are not allowed to read this file",
};

/** The dialog's loader options, minus empty values and the client-only `timeout` (seconds). */
export function convertOptions(
  config: Record<string, unknown> | null | undefined,
  defaultTimeoutS = 300,
): { options: Record<string, unknown>; timeoutS: number } {
  const options: Record<string, unknown> = {};
  let timeoutS = defaultTimeoutS;
  for (const [k, v] of Object.entries(config ?? {})) {
    if (v === null || v === undefined || v === "" || v === false) continue;
    if (k === "timeout") {
      if (typeof v === "number" && v > 0) timeoutS = v;
      continue;
    }
    options[k] = v;
  }
  return { options, timeoutS };
}

/** A failed data-portal request, with the server's own words when it gave any. */
class PortalError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PortalError";
    this.status = status;
  }
}

function describeStatus(status: number): string {
  if (status === 401) return "Sign in again to continue.";
  if (status === 403) return "Access denied.";
  if (status === 404) return "Not found.";
  if (status === 429) return "Rate-limited - wait a moment and try again.";
  if (status >= 500) return "Service error - try again.";
  return `Request failed (${status}).`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Drive `el` through reads on its `inspector-submit` / `inspector-error-action` events. Call
 * `load()` before setting `open`: it sets status=loading, so opening does not submit a second read.
 */
export function attachInspector(
  el: InspectorElementLike,
  options: AttachInspectorOptions = {},
): InspectorController {
  const portal = options.dataPortalBase ? options.dataPortalBase.replace(/\/+$/, "") : null;
  const canConvert = portal !== null && options.dataLoader !== false;
  const isStore = options.isStore ?? looksLikeStore;
  const shareTtl = options.shareTtlSeconds ?? 3600;
  const pollMs = options.pollMs ?? 1500;
  const graceMs = options.startupGraceMs ?? 30_000;
  const signIn = typeof options.signIn === "function" ? options.signIn : null;
  const authFor = (url: string): Promise<Record<string, string>> =>
    resolveAuthHeaders(options.getAuthHeaders, url);

  let generation = 0;
  let current: AbortController | null = null;
  let detached = false;

  /** A JSON data-portal request; a failure throws PortalError with the server's `detail`. */
  async function portalJson<T>(
    path: string,
    init: { method?: string; body?: unknown },
    signal: AbortSignal,
  ): Promise<T> {
    const url = `${portal}${path}`;
    const headers: Record<string, string> = { ...(await authFor(url)) };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.clone().json()) as { detail?: unknown };
        if (typeof body.detail === "string") detail = body.detail;
      } catch {
        // non-JSON error body
      }
      const text = describeStatus(res.status);
      throw new PortalError(
        res.status,
        detail && !text.includes(detail) ? `${text} ${detail}` : text,
      );
    }
    return (await res.json()) as T;
  }

  async function load(
    target: string | string[],
    config?: Record<string, unknown> | null,
  ): Promise<void> {
    if (detached) return;
    const mine = ++generation;
    current?.abort();
    const ac = new AbortController();
    current = ac;
    const stale = (): boolean => detached || mine !== generation;

    const paths = (Array.isArray(target) ? target : [target])
      .map((p) => String(p).trim())
      .filter(Boolean);
    if (!paths.length) return;
    const { options: loaderOptions, timeoutS } = convertOptions(
      config,
      options.timeoutSeconds ?? 300,
    );
    // Reflect the read into the element - `file` (whose change resets derived state), aggregation
    // mode and options - so the path bar shows it and Retry / Aggregate re-submit it as given.
    const aggregate = Array.isArray(target);
    // Only on an upgraded element: an own property would shadow its accessor.
    if (aggregate && "aggregationConfig" in el) el.aggregationConfig = config ?? null;
    const shownFile = aggregate ? JSON.stringify(paths) : paths[0];
    if (el.getAttribute("file") !== shownFile) el.setAttribute("file", shownFile);
    if (el.hasAttribute("is-aggregation") !== aggregate) {
      if (aggregate) el.setAttribute("is-aggregation", "");
      else el.removeAttribute("is-aggregation");
    }
    // After `file`, whose change clears `loadOptions`.
    if (!aggregate && "loadOptions" in el) el.loadOptions = config ?? null;
    el.error = null;
    for (const a of ["error-action", "zarr-status-code", "viewer-disabled"]) el.removeAttribute(a);
    el.setAttribute("status", "loading");

    const what =
      paths.length > 1 ? "Aggregating these files" : "This file isn’t a zarr store - inspecting it";
    const fail = (message: string, offerSignIn = false): void => {
      if (stale()) return;
      el.error = message;
      if (offerSignIn && signIn) el.setAttribute("error-action", "Sign in");
      el.setAttribute("status", "error");
    };

    /**
     * A token-free share link for a protected store. Without one the viewer is disabled with the
     * reason: GridLook cannot send the token, so the protected URL would only answer 401.
     */
    const shareOrBlockViewer = async (store: string): Promise<string> => {
      let why = "the server did not return one";
      if (portal) {
        try {
          const share = await portalJson<{ url?: unknown }>(
            "/share-zarr",
            { method: "POST", body: { path: store, ttl_seconds: shareTtl } },
            ac.signal,
          );
          if (typeof share?.url === "string" && share.url) return share.url;
        } catch (err) {
          if (err instanceof PortalError) why = `the server answered ${err.status}`;
        }
      } else {
        why = "no data-portal is configured to make one";
      }
      if (stale()) return store;
      el.setAttribute(
        "viewer-disabled",
        `The 3D viewer needs a share link for this protected store, and none could be made (${why}). Load it again to retry.`,
      );
      return store;
    };

    // 1. Already a store: read it directly.
    let readError = "";
    let readStatus: number | null = null;
    // Protected = the hook sent a credential on any of the store's requests. The bare store URL
    // cannot tell: a hook scoped to `store/` sends none for it.
    let sentCredential = false;
    const storeAuth = async (url: string): Promise<Record<string, string>> => {
      const headers = await authFor(url);
      if (hasAuthorization(headers)) sentCredential = true;
      return headers;
    };
    if (paths.length === 1 && !Object.keys(loaderOptions).length && isStore(paths[0])) {
      el.setAttribute("zarr-url", paths[0]);
      try {
        const html = await loadZarrMetadataHtml(paths[0], {
          getAuthHeaders: storeAuth,
          signal: ac.signal,
        });
        if (stale()) return;
        if (sentCredential && !isShareLink(paths[0])) {
          const shown = await shareOrBlockViewer(paths[0]);
          if (stale()) return;
          el.setAttribute("zarr-url", shown);
        }
        el.output = html;
        el.setAttribute("status", "ready");
        return;
      } catch (err) {
        if (stale()) return;
        readError = err instanceof Error ? err.message : String(err);
        readStatus = err instanceof ZarrMetadataError ? err.status : null;
        el.removeAttribute("zarr-url"); // not a readable store: the data-loader decides
      }
    }

    // Refused: with a data-portal session, convert anyway (the data-loader reads with the server's
    // access; the token may be scoped away from this host). Otherwise it is a sign-in matter.
    if (readStatus === 401 || readStatus === 403) {
      const portalSession = canConvert && hasAuthorization(await authFor(`${portal}/zarr/convert`));
      if (stale()) return;
      if (!portalSession) {
        if (!sentCredential) fail(`This store needs sign-in (it answered ${readStatus}).`, true);
        else if (readStatus === 401)
          fail("This store did not accept your sign-in (401) - sign in again to continue.", true);
        else fail("You are not allowed to read this store (403).");
        return;
      }
    }

    // 2. The data-loader.
    if (!canConvert) {
      const why = readError ? ` (${readError})` : "";
      const missing = portal
        ? "the data-portal's conversion is not enabled here"
        : "no data-portal is configured";
      fail(
        paths.length > 1
          ? `Aggregating these files needs the data-portal's conversion, and ${missing}.`
          : `This could not be read as a zarr store${why}, and ${missing} to convert it.`,
      );
      return;
    }
    // Signed in: asked now, for this request.
    const signedIn = hasAuthorization(await authFor(`${portal}/zarr/convert`));
    if (stale()) return;
    if (!signedIn) {
      fail(`${what} needs sign-in`, true);
      return;
    }

    el.setAttribute("zarr-status-code", "3"); // the component shows its conversion stepper
    try {
      const body = {
        ...loaderOptions,
        path: paths.length === 1 ? paths[0] : paths,
        ...(paths.length > 1 && !loaderOptions.aggregate ? { aggregate: "auto" } : {}),
      };
      const { urls } = await portalJson<{ urls?: unknown }>(
        "/zarr/convert",
        { method: "POST", body },
        ac.signal,
      );
      if (stale()) return;
      const store = Array.isArray(urls) ? urls[0] : undefined;
      if (typeof store !== "string" || !store)
        throw new Error("The data-loader returned no store URL.");

      // A converted store is protected (unless the data-loader already returned a share link).
      const shown = isShareLink(store) ? store : await shareOrBlockViewer(store);
      if (stale()) return;
      el.setAttribute("zarr-url", shown);

      const started = Date.now();
      const deadline = started + timeoutS * 1000;
      let pickedUp = false; // the worker has reported on this job (3/4) at least once
      for (;;) {
        const st = await portalJson<{ status?: unknown; reason?: unknown }>(
          `/zarr-utils/status?url=${encodeURIComponent(store)}&timeout=1`,
          {},
          ac.signal,
        );
        if (stale()) return;
        const code = typeof st.status === "number" ? st.status : STATUS_UNKNOWN;
        if (code === STATUS_READY) {
          el.setAttribute("zarr-status-code", "0");
          break;
        }
        const stillQueued = code === STATUS_UNKNOWN && !pickedUp && Date.now() - started < graceMs;
        if (!stillQueued && code in STATUS_TERMINAL) {
          el.setAttribute("zarr-status-code", String(code));
          const reason = typeof st.reason === "string" && st.reason ? `: ${st.reason}` : ".";
          throw new Error(`${STATUS_TERMINAL[code]}${reason}`);
        }
        if (!stillQueued) pickedUp = true;
        // Unknown-while-queued shows as "waiting", not as the stepper's "gone".
        el.setAttribute("zarr-status-code", String(stillQueued ? 3 : code));
        if (Date.now() > deadline) {
          throw new Error(
            `The conversion did not finish within ${timeoutS} s - try again, or raise the timeout.`,
          );
        }
        await sleep(pollMs, ac.signal);
        if (stale()) return;
      }

      const html = await loadZarrMetadataHtml(store, {
        getAuthHeaders: authFor,
        signal: ac.signal,
      });
      if (stale()) return;
      el.output = html;
      el.setAttribute("status", "ready");
    } catch (err) {
      if (stale() || ac.signal.aborted) return;
      // A 401 at any step (data-portal or converted store) means the session ended.
      const expired =
        (err instanceof PortalError || err instanceof ZarrMetadataError) && err.status === 401;
      if (expired) {
        fail(`${what} needs sign-in - your session has ended`, true);
        return;
      }
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  // The Load / Retry / Aggregate buttons (and an edited path) re-drive the same loader.
  const onSubmit = (e: Event): void => {
    const detail = (e as CustomEvent<{ file?: unknown; aggregationConfig?: unknown }>).detail;
    const file = detail?.file;
    const config =
      detail?.aggregationConfig && typeof detail.aggregationConfig === "object"
        ? (detail.aggregationConfig as Record<string, unknown>)
        : null;
    if (typeof file === "string" || Array.isArray(file))
      void load(file as string | string[], config);
  };
  // Hands over to the host's sign-in; if it does not navigate away, Retry works afterwards.
  const onErrorAction = (): void => {
    signIn?.();
  };
  el.addEventListener("inspector-submit", onSubmit);
  el.addEventListener("inspector-error-action", onErrorAction);

  return {
    load,
    detach(): void {
      if (detached) return;
      detached = true;
      current?.abort();
      el.removeEventListener("inspector-submit", onSubmit);
      el.removeEventListener("inspector-error-action", onErrorAction);
    },
  };
}
