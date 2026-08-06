import {
  AuthError,
  CsrfUnavailableError,
  StorageContractError,
  canonicalizeStoredToken,
  normalizeTokenResponse,
} from "../token.js";
import { isExpired, nowSeconds } from "../jwt.js";
import { strictBoolean, strictEnum, validateConfigUrl } from "../url.js";
import type { LifecycleIdentity } from "../types.js";
import type { ClearReason, MaybePromise, StoredToken, TokenStorage } from "../types.js";

/**
 * Two explicit transports:
 *
 * - "bearer-from-endpoint": a backend holds the refresh capability in an
 *   httpOnly context and exposes an endpoint that mints SHORT-LIVED access
 *   tokens. This storage fetches one with `credentials: "include"`, caches it
 *   in memory, and the data path stays browser → API with Bearer.
 *
 * - "bff": every API call is proxied by the backend, which attaches the token
 *   server-side. auth.fetch adds `credentials: "include"` and NO Authorization
 *   header; the library performs no client-side refresh.
 *
 * Both transports send ambient credentials, which is precisely the shape CSRF
 * exploits, so a CSRF strategy is mandatory in bff mode (see `csrf`).
 */

/**
 * Double-submit / header-token CSRF defense for credentialed calls.
 * SameSite alone is not sufficient: it does not constrain same-site
 * subdomains, and Lax still permits top-level cross-site GET.
 */
export interface CsrfOptions {
  /** e.g. "X-CSRFToken" (Django) or "X-XSRF-TOKEN". */
  headerName: string;
  /** Static value or a getter re-read per request (cookie-backed rotation). */
  token: string | (() => MaybePromise<string>);
}

export type ServerManagedOptions =
  | {
      transport: "bearer-from-endpoint";
      /** Endpoint returning a token JSON payload for the current backend session. */
      tokenEndpoint?: string;
      /**
       * Defaults to "POST". Minting a credential is neither safe nor
       * idempotent, so it must not be a GET: GETs are cached, prefetched,
       * logged with their URL, and replayed by link scanners. Choosing "GET"
       * requires `acknowledgeUnsafeTokenEndpointMethod`.
       */
      tokenEndpointMethod?: "GET" | "POST";
      /** Required to mint with GET. */
      acknowledgeUnsafeTokenEndpointMethod?: boolean;
      /**
       * Minting uses `credentials: "include"`, so it is a cookie-authenticated
       * state-changing request and needs CSRF protection. Set this only if the
       * backend enforces an equivalent defense itself.
       */
      acknowledgeNoCsrf?: boolean;
      /** Alternative to tokenEndpoint: any async source of a StoredToken. */
      tokenProvider?: () => MaybePromise<StoredToken | null>;
      /** Optional liveness/refresh-trigger URL (e.g. freva-web's /api/token-health/). */
      healthUrl?: string;
      /** Credentialed POST that must destroy the backend session on logout. */
      logoutEndpoint?: string;
      csrf?: CsrfOptions;
      fetchImpl?: typeof fetch;
      /** Treat the cached token as stale this many seconds before exp. Default 30. */
      staleSkewSeconds?: number;
      /** Abort a hanging backend call. Default 10000. */
      timeoutMs?: number;
      /**
       * This transport's whole premise is that the backend KEEPS the refresh
       * capability and hands out only a short-lived access token. A response
       * carrying a refresh token, or an access token that is its own refresh
       * credential, breaks that premise and is rejected. Set true only if you
       * accept that the mode no longer contains the credential.
       */
      allowRefreshCapableToken?: boolean;
      /**
       * Longest access-token lifetime considered "short-lived". Exceeding it
       * is reported (not fatal). Default 900 s.
       */
      maxAccessTokenLifetimeSeconds?: number;
    }
  | {
      transport: "bff";
      healthUrl?: string;
      /** Credentialed POST that must destroy the backend session on logout. */
      logoutEndpoint?: string;
      csrf?: CsrfOptions;
      /**
       * Construct without a CSRF strategy anyway. Only correct when the
       * backend already enforces CSRF itself (e.g. it requires a custom
       * header this library does not manage, or checks Origin/Sec-Fetch-Site).
       */
      acknowledgeNoCsrf?: boolean;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    };

export class ServerManagedStorage implements TokenStorage {
  readonly kind = "server-managed" as const;
  readonly persistent = true;
  /**
   * Declared from the transport, not inferred. `bff` holds no browser
   * credential at all; `bearer-from-endpoint` mints a DIFFERENT short-lived
   * bearer per tab from one backend session.
   */
  readonly lifecycleIdentity: LifecycleIdentity;
  readonly transport: "bearer-from-endpoint" | "bff";
  readonly healthUrl?: string;
  readonly tokenEndpoint?: string;
  readonly logoutEndpoint?: string;
  /** True when a tokenProvider callback (rather than an endpoint URL) feeds this storage. */
  readonly hasTokenProvider: boolean;
  readonly hasCsrf: boolean;
  /** Passive metadata for diagnose(): reading these performs no I/O. */
  readonly acknowledgedNoCsrf: boolean;
  readonly acknowledgedRefreshCapableToken: boolean;
  readonly acknowledgedUnsafeMintMethod: boolean;
  readonly acknowledgedMintWithoutCsrf: boolean;
  /** Set when the last pulled token outlived maxAccessTokenLifetimeSeconds. */
  longLivedTokenObserved = false;
  /**
   * Sink for credentials the backend minted for a session that ended while the
   * pull was in flight. Wired by the client to its recovery registry; a
   * standalone storage drops them.
   */
  private discardedMintSink: ((token: StoredToken) => void) | null = null;
  onDiscardedMint(sink: (token: StoredToken) => void): void {
    this.discardedMintSink = sink;
  }
  private reportDiscardedMint(token: StoredToken): void {
    try {
      this.discardedMintSink?.(token);
    } catch {
      /* a failing sink must not break the pull */
    }
  }

  /** A frozen private snapshot. The caller-owned object is never retained. */
  private readonly options: ServerManagedOptions;
  private cache: StoredToken | null = null;
  private inflight: Promise<StoredToken | null> | null = null;
  /** Bumped by clear(); a pull started before the bump may not store its result. */
  private epoch = 0;

  constructor(options: ServerManagedOptions) {
    if (!options || typeof options !== "object") {
      throw new AuthError("ServerManagedStorage: options object is required.");
    }
    // Snapshot + freeze: the caller's object is never retained. Otherwise
    // endpoint, method, CSRF and fetchImpl remain swappable after
    // construction, silently redirecting every later credential mint.
    const o = options as Record<string, unknown>;
    const transport = strictEnum(
      o.transport,
      ["bearer-from-endpoint", "bff"] as const,
      "ServerManagedStorage.transport",
    );
    const snapshot: Record<string, unknown> = { transport };
    for (const key of ["tokenEndpoint", "healthUrl", "logoutEndpoint"]) {
      if (o[key] === undefined) continue;
      if (typeof o[key] !== "string") {
        throw new AuthError(`ServerManagedStorage.${key} must be a string.`);
      }
      // Canonicalize to absolute so a document <base> cannot move it later.
      const u = validateConfigUrl(o[key] as string, `ServerManagedStorage.${key}`, {
        allowRelative: true,
        allowQuery: true,
        allowInsecure: true,
      });
      snapshot[key] = u ? u.href : (o[key] as string);
    }
    if (o.tokenEndpointMethod !== undefined) {
      snapshot.tokenEndpointMethod = strictEnum(
        o.tokenEndpointMethod,
        ["GET", "POST"] as const,
        "ServerManagedStorage.tokenEndpointMethod",
      );
    }
    for (const key of [
      "acknowledgeNoCsrf",
      "acknowledgeUnsafeTokenEndpointMethod",
      "allowRefreshCapableToken",
    ]) {
      snapshot[key] = strictBoolean(o[key], `ServerManagedStorage.${key}`);
    }
    for (const key of ["staleSkewSeconds", "timeoutMs", "maxAccessTokenLifetimeSeconds"]) {
      if (o[key] === undefined) continue;
      if (
        typeof o[key] !== "number" ||
        !Number.isFinite(o[key] as number) ||
        (o[key] as number) < 0
      ) {
        throw new AuthError(`ServerManagedStorage.${key} must be a finite, non-negative number.`);
      }
      snapshot[key] = o[key];
    }
    if (o.csrf !== undefined) {
      const csrf = o.csrf as { headerName?: unknown; token?: unknown };
      if (
        typeof csrf?.headerName !== "string" ||
        !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(csrf.headerName)
      ) {
        throw new AuthError(
          "ServerManagedStorage.csrf.headerName must be a valid HTTP header name.",
        );
      }
      if (typeof csrf.token !== "string" && typeof csrf.token !== "function") {
        throw new AuthError("ServerManagedStorage.csrf.token must be a string or a function.");
      }
      snapshot.csrf = Object.freeze({ headerName: csrf.headerName, token: csrf.token });
    }
    if (o.tokenProvider !== undefined) {
      if (typeof o.tokenProvider !== "function") {
        throw new AuthError("ServerManagedStorage.tokenProvider must be a function.");
      }
      snapshot.tokenProvider = o.tokenProvider;
    }
    if (o.fetchImpl !== undefined) {
      if (typeof o.fetchImpl !== "function") {
        throw new AuthError("ServerManagedStorage.fetchImpl must be a function.");
      }
      snapshot.fetchImpl = o.fetchImpl;
    }
    options = Object.freeze(snapshot) as unknown as ServerManagedOptions;
    this.options = options;
    this.transport = options.transport;
    this.lifecycleIdentity = options.transport === "bff" ? "ambient" : "managed-bearer";
    this.healthUrl = options.healthUrl;
    this.logoutEndpoint = options.logoutEndpoint;
    this.tokenEndpoint =
      options.transport === "bearer-from-endpoint" ? options.tokenEndpoint : undefined;
    this.hasTokenProvider = options.transport === "bearer-from-endpoint" && !!options.tokenProvider;
    this.hasCsrf = !!options.csrf;
    this.acknowledgedNoCsrf = options.transport === "bff" && !!options.acknowledgeNoCsrf;
    this.acknowledgedUnsafeMintMethod =
      options.transport === "bearer-from-endpoint" && options.tokenEndpointMethod === "GET";
    this.acknowledgedMintWithoutCsrf =
      options.transport === "bearer-from-endpoint" && !!options.tokenEndpoint && !options.csrf;
    this.acknowledgedRefreshCapableToken =
      options.transport === "bearer-from-endpoint" && !!options.allowRefreshCapableToken;

    if (options.csrf && !options.csrf.headerName) {
      throw new AuthError("ServerManagedStorage: csrf.headerName is required.");
    }
    if (options.transport === "bearer-from-endpoint") {
      if (options.tokenEndpointMethod === "GET" && !options.acknowledgeUnsafeTokenEndpointMethod) {
        throw new AuthError(
          "ServerManagedStorage: minting a credential with GET is neither " +
            "safe nor idempotent — the URL is cached, prefetched and logged. " +
            "Use POST (the default), or set " +
            "acknowledgeUnsafeTokenEndpointMethod: true.",
        );
      }
      if (options.tokenEndpoint && !options.csrf && !options.acknowledgeNoCsrf) {
        throw new AuthError(
          "ServerManagedStorage: the token endpoint is called with credentials: " +
            '"include", which makes credential minting a cookie-authenticated ' +
            "state-changing request. Pass { csrf: { headerName, token } }, or " +
            "acknowledgeNoCsrf: true if the backend enforces CSRF itself.",
        );
      }
    }
    if (options.transport === "bff" && !options.csrf && !options.acknowledgeNoCsrf) {
      throw new AuthError(
        "ServerManagedStorage(bff) requires a CSRF strategy: every proxied " +
          'call is sent with credentials: "include", which is exactly the ' +
          "shape a cross-site request forgery exploits. SameSite alone does " +
          "not cover same-site subdomains. Pass { csrf: { headerName, token } }, " +
          "or { acknowledgeNoCsrf: true } if the backend already enforces CSRF " +
          "by another mechanism.",
      );
    }
  }

  /**
   * Headers a credentialed request to the backend must carry.
   *
   * THROWS rather than returning `{}` when a CSRF strategy is configured but
   * cannot produce a token. Empty headers would let the request go out with
   * `credentials: "include"` and no CSRF header — the exact configuration the
   * caller asked to prevent — whenever the cookie is missing or the getter
   * throws.
   */
  async csrfHeaders(): Promise<Record<string, string>> {
    const csrf = this.options.csrf;
    if (!csrf) return {};
    let value: string;
    try {
      value = typeof csrf.token === "function" ? await csrf.token() : csrf.token;
    } catch {
      // Deliberately does not echo the provider's error text: it may embed
      // the very token it failed to read.
      throw new CsrfUnavailableError("the CSRF token provider threw");
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new CsrfUnavailableError("the CSRF token provider returned nothing");
    }
    return { [csrf.headerName]: value };
  }

  /** Cached token WITHOUT contacting the backend. For diagnostics only. */
  peek(): StoredToken | null {
    return this.cache;
  }

  load(): MaybePromise<StoredToken | null> {
    if (this.options.transport === "bff") return null;
    const skew = this.options.staleSkewSeconds ?? 30;
    if (this.cache && !isExpired(this.cache.expiresAt, nowSeconds(), skew)) {
      return this.cache;
    }
    // Single-flight the backend pull: concurrent loads share one mint.
    if (!this.inflight) {
      // Identity-checked cleanup: a completed OLD pull must not null the
      // pointer belonging to a newer one started after a clear().
      const mine: Promise<StoredToken | null> = this.pull().finally(() => {
        if (this.inflight === mine) this.inflight = null;
      });
      this.inflight = mine;
    }
    return this.inflight;
  }

  private async pull(): Promise<StoredToken | null> {
    const opts = this.options;
    if (opts.transport !== "bearer-from-endpoint") return null;
    const startedAt = this.epoch;
    const store = (token: StoredToken | null): StoredToken | null => {
      // A clear() during the await means this result is stale.
      if (this.epoch !== startedAt) {
        // The backend MINTED this credential. Dropping it silently would make
        // the only reference to a live credential disappear here, so the
        // logout that raced it would complete with zero revocation attempts.
        // The owner of the recovery registry is told instead.
        // MUTATION ANCHOR: discarded mints are reported, not dropped.
        if (token) this.reportDiscardedMint(token);
        return null;
      }
      this.cache = token;
      return token;
    };
    try {
      if (opts.tokenProvider) {
        const provided = (await opts.tokenProvider()) ?? null;
        // A tokenProvider is caller code: canonicalize before the value is
        // ever used as a credential.
        return store(
          provided
            ? this.enforceContract(canonicalizeStoredToken(provided, "token-provider"))
            : null,
        );
      }
      if (!opts.tokenEndpoint) return null;
      const doFetch = opts.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
      let res: Response;
      try {
        res = await doFetch(opts.tokenEndpoint, {
          method: opts.tokenEndpointMethod ?? "POST",
          credentials: "include",
          // A minted credential must never be served from the HTTP cache, a
          // prefetch, or a service worker.
          cache: "no-store",
          // A redirected token endpoint means the session is gone (SSO bounce)
          // or something is intercepting; do not follow it with credentials.
          redirect: "error",
          headers: {
            Accept: "application/json",
            ...(await this.csrfHeaders()),
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;
      return store(this.enforceContract(normalizeTokenResponse(await res.json())));
    } catch (e) {
      // A broken contract is a configuration fault, not a transient miss:
      // swallowing it would silently downgrade the mode's guarantees.
      if (e instanceof StorageContractError || e instanceof CsrfUnavailableError) {
        throw e;
      }
      return null;
    }
  }

  /**
   * "bearer-from-endpoint" promises the browser never holds refresh
   * capability. Verify that instead of trusting the backend to behave.
   */
  private enforceContract(token: StoredToken): StoredToken {
    const opts = this.options;
    if (opts.transport !== "bearer-from-endpoint") return token;
    if (!opts.allowRefreshCapableToken) {
      if (token.refreshToken !== undefined) {
        throw new StorageContractError(
          "the token endpoint returned a refresh_token. In " +
            "bearer-from-endpoint mode the backend must retain refresh " +
            "capability and hand the browser only a short-lived access " +
            "token. Fix the endpoint, or set allowRefreshCapableToken: true " +
            "to accept that this mode no longer contains the credential.",
        );
      }
      if (token.accessTokenIsRefreshCredential) {
        throw new StorageContractError(
          "the token endpoint returned an access token that is also its own " +
            "refresh credential (broker mode). That defeats the point of " +
            "bearer-from-endpoint.",
        );
      }
    }
    const maxLife = opts.maxAccessTokenLifetimeSeconds ?? 900;
    const life = token.expiresAt - nowSeconds();
    this.longLivedTokenObserved = life > maxLife;
    return token;
  }

  save(token: StoredToken): void {
    // The backend owns persistence; we only refresh the in-memory mirror.
    if (this.options.transport === "bearer-from-endpoint") {
      this.cache = this.enforceContract(token);
    }
  }

  clear(_reason?: ClearReason): void {
    this.cache = null;
    // Invalidate any pull already in flight: otherwise a provider or endpoint
    // resolving after logout repopulates the cache with a live credential the
    // user just destroyed.
    this.epoch += 1;
    this.inflight = null;
  }

  /** Drop the cached token WITHOUT any network I/O. */
  invalidateCache(): void {
    this.cache = null;
    this.epoch += 1;
    this.inflight = null;
  }
}
