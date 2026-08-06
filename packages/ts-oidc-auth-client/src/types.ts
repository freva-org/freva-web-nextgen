/**
 * Core types for the py-oidc-auth TypeScript client.
 *
 * Design invariants (see docs/SPEC.md):
 * - Topology-blind about deployment: the library never guesses whether a
 *   backend exists. Credential handling is not permissive, though - `storage`
 *   and the resource-origin allowlist are explicit integrator decisions.
 * - In broker mode the stored JWT doubles as the refresh credential (refresh
 *   accepts expired JWTs - only `jti` matters), so storage choices are
 *   security choices.
 * - Tokens never enter localStorage. Cross-tab sync carries metadata only.
 * - Events carry METADATA ONLY, so anything that logs an event verbatim
 *   (Sentry breadcrumbs, redux devtools) cannot thereby log a credential.
 */

export type MaybePromise<T> = T | Promise<T>;

/**
 * How this deployment's storage relates a CREDENTIAL to a SESSION, which
 * decides whether a cross-tab lifecycle message is about this tab.
 *
 * - `shared-credential` - every tab reads the same stored credential (cookie,
 *   or a persistent custom storage). One credential, one session: the
 *   recomputed access-token fingerprint IS the session identity.
 * - `managed-bearer` - `ServerManagedStorage({transport:"bearer-from-endpoint"})`.
 *   One backend session mints a different short-lived bearer per tab, so two
 *   tabs of the SAME session hold different fingerprints by design.
 * - `per-tab` - `MemoryStorage`, and any storage each tab holds its own copy
 *   of, persistent or not (sessionStorage, a tab-keyed IndexedDB record).
 * - `ambient` - `ServerManagedStorage({transport:"bff"})`. No browser
 *   credential exists, so there is nothing to fingerprint.
 */
export type LifecycleIdentity = "shared-credential" | "managed-bearer" | "per-tab" | "ambient";

/**
 * The ONLY reasons a session may end. Deliberately a closed machine-readable
 * union: cross-tab messages arrive from any same-origin script, so no
 * attacker-supplied reason text can reach AuthEvents or telemetry.
 */
export type SessionEndReason = "user-logout" | "refresh-token-rejected";

export const SESSION_END_REASONS: readonly SessionEndReason[] = [
  "user-logout",
  "refresh-token-rejected",
];

export type ClearReason = "logout" | "refresh-token-rejected" | "manual" | string;

/** Normalized token as held by the library and its storage plugins. */
export interface StoredToken {
  accessToken: string;
  /** In broker mode this equals `accessToken` (one JWT, two roles). */
  refreshToken?: string;
  tokenType: string;
  /** Epoch seconds. `0` means "unknown/expired - usable only as refresh credential". */
  expiresAt: number;
  /** Epoch seconds. */
  refreshExpiresAt?: number;
  scope?: string;
  /** Future server field; `false` means the server will reject refresh attempts. */
  refreshable?: boolean;
  /**
   * True when the server returns the SAME string as both access and refresh
   * token - the Bearer attached to API calls is itself a refresh credential.
   * The client can only detect and report this; only split tokens from the
   * server fix it.
   */
  accessTokenIsRefreshCredential?: boolean;
  /** Short non-secret fingerprint of the access token; used for cross-tab sync. */
  sessionVersion: string;
}

/**
 * The redacted view of a token that events carry. Deliberately contains no
 * `accessToken` / `refreshToken` string: call `getToken()` when you need the
 * value, so the credential only ever reaches code that asked for it.
 */
export interface TokenSummary {
  /** Always the literal "Bearer"; nothing else is supported. */
  tokenType: "Bearer";
  expiresAt: number;
  refreshExpiresAt?: number;
  refreshable?: boolean;
  accessTokenIsRefreshCredential?: boolean;
  sessionVersion: string;
}

export interface TokenStorage {
  load(): MaybePromise<StoredToken | null>;
  save(token: StoredToken): MaybePromise<void>;
  clear(reason?: ClearReason): MaybePromise<void>;
  /** Optional change feed (e.g. cookie poll or in-memory listeners). */
  subscribe?(listener: (token: StoredToken | null) => void): () => void;
  readonly kind?: "memory" | "cookie" | "server-managed" | "custom";
  /**
   * Whether the credential survives a tab close/reopen.
   *
   * ORTHOGONAL to `lifecycleIdentity`. Persistence is about TIME (does the
   * value outlive this page?); lifecycle identity is about SPACE (do other
   * tabs read the same value?). sessionStorage, an IndexedDB record keyed by
   * tab, and a partitioned worker cache are all persistent AND per-tab, so
   * persistence must never be used to infer sharing.
   */
  readonly persistent?: boolean;
  /**
   * How this storage relates a credential to a session across tabs.
   *
   * REQUIRED for a custom storage whenever cross-tab coordination is enabled:
   * it decides whether a peer's lifecycle message is about this tab, and there
   * is no safe way to guess it. Built-in storages declare their own; a value
   * that contradicts a built-in is a construction error. Read ONCE at client
   * construction, so mutating it later cannot change policy.
   */
  readonly lifecycleIdentity?: LifecycleIdentity;
}

/** Only `terminal_invalid_session` may clear storage. */
export type RefreshFailureKind =
  | "terminal_invalid_session"
  | "transient_network"
  | "transient_server"
  | "cors_or_config"
  | "unknown";

/** Machine-readable codes for `security-warning`, so apps can branch. */
export type SecurityWarningCode =
  | "refresh-capable-bearer"
  | "browser-readable-refresh-credential"
  | "unverifiable-custom-storage"
  | "bff-without-csrf"
  | "long-lived-managed-token"
  | "no-backend-logout"
  | "unsupported-revocation"
  | "no-revocation"
  | "legacy-cookie-storage"
  | "insecure-transport"
  | "insecure-cookie-transport"
  | "no-login-transaction"
  | "missing-issuer"
  | "unsafe-token-endpoint-method"
  | "token-endpoint-without-csrf"
  | "refresh-capable-managed-token"
  /**
   * A logout could not confirm every invalidation step, so this tab stays
   * fail-closed: token reads and authenticated requests are refused until a
   * logout completes. A new login does not clear it.
   */
  | "logout-failed-blocked"
  /**
   * A peer tab announced a session clear and this tab's storage refused to
   * drop the credential. Same fail-closed state, peer-originated.
   */
  | "peer-clear-failed-blocked"
  /**
   * A credential is known to be live and unrevoked: an invalidation attempt did
   * not succeed and the reference has been retained so a later `logout()` can
   * retry it. `diagnose().ok` stays false while this holds.
   */
  | "pending-revocation-blocked"
  /**
   * The server declared the session terminally invalid and this tab's storage
   * refused to drop the rejected credential. Fail-closed until a logout clears
   * it.
   */
  | "terminal-clear-failed-blocked";

export type AuthEvent =
  | { type: "login-started"; url: string }
  | {
      type: "login-completed";
      token: TokenSummary;
      /**
       * Whether a return path was stashed - NOT the path itself, which is
       * application data that has carried query strings into telemetry.
       * Call `consumeReturnPath()` to read it.
       */
      hasReturnPath: boolean;
    }
  | { type: "token-refreshed"; token: TokenSummary; source: "self" | "tab" }
  | { type: "session-expired"; reason: string }
  | { type: "logout"; localOnly: boolean }
  /**
   * Local credentials were dropped, but the logout is NOT yet known to have
   * succeeded (a peer tab is still awaiting backend logout / revocation).
   * Re-render as signed out; do not report a completed logout.
   */
  | { type: "session-cleared"; reasonCode: SessionEndReason }
  | { type: "refresh-failed"; kind: RefreshFailureKind; status?: number }
  /**
   * A freshly rotated credential could not be persisted. The old one is
   * already dead server-side, so this is a real incident, not a warning:
   * the client keeps the new token in a per-page memory mirror and the
   * session degrades to memory semantics until the next full login.
   */
  | {
      type: "storage-write-failed";
      phase: "refresh" | "callback";
      /**
       * A FIXED code, never the underlying exception text. A custom storage
       * can throw an error whose message embeds the credential it just failed
       * to write, and events go to Sentry breadcrumbs and console.
       */
      reasonCode: "storage-threw";
      token: TokenSummary;
      degradedToMemory: boolean;
    }
  /**
   * A session-ending CLEAR did not succeed, so the credential is still present
   * locally and this tab is fail-closed.
   *
   * Distinct from `storage-write-failed`, which means "a freshly rotated token
   * could not be persisted and the session now runs from a memory mirror".
   * The two must stay separate events: reporting one as the other tells
   * operators the opposite of what happened.
   */
  | {
      type: "session-clear-failed";
      /** "peer" - another tab ended it; "terminal" - the server did. */
      scope: "peer" | "terminal";
      /** FIXED code, never the storage's exception text. */
      reasonCode: "storage-threw";
      /** Whether this tab is now refusing credential use. Always true today. */
      blocked: boolean;
    }
  /** A best-effort server-side revocation did not succeed. */
  | {
      type: "revocation-failed";
      reasonCode: "http-error" | "network-error" | "unsupported";
      status?: number;
    }
  | {
      type: "security-warning";
      code: SecurityWarningCode;
      message: string;
    }
  | { type: "diagnose"; report: DiagnoseReport };

/** `error` fails the report; `warn`/`info` are reported without failing it. */
export type DiagnoseSeverity = "info" | "warn" | "error";

export interface DiagnoseCheck {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
  /** Defaults to "error" when absent, i.e. `ok: false` fails the report. */
  severity?: DiagnoseSeverity;
}

export interface DiagnoseReport {
  storageKind: string;
  checks: DiagnoseCheck[];
  ok: boolean;
}

export interface SecurityOptions {
  /**
   * Emit a warning when a refresh-capable JWT lands in browser-readable
   * storage (CookieStorage, unknown custom storage). Default true.
   */
  warnOnBrowserReadableRefresh?: boolean;
  /**
   * Origins allowed to receive the Authorization header from `auth.fetch()`
   * and `decorateRequest()`, beyond the page's own origin and the origin of
   * `authBaseUrl` (both always allowed). Anything else throws
   * `OriginNotAllowedError`.
   *
   * In broker mode the Bearer IS the refresh credential, so an unbounded
   * `auth.fetch(userControlledUrl)` turns one URL-injection bug into full
   * session compromise.
   */
  allowedResourceOrigins?: string[];
  /**
   * Permit sending the credential to a plaintext, non-loopback http origin.
   * Off by default: the broker JWT is a refresh credential, so http exposes
   * the whole session to anyone on the path.
   */
  allowInsecureTransport?: boolean;
  /**
   * Exact-match allowlist of redirect URIs `loginUrl()` / `login()` may send,
   * and that `handleCallback()` will accept a response on. Defaults to the
   * single configured `redirectUri`.
   */
  allowedRedirectUris?: string[];
  /** Exact-match allowlist for `post_logout_redirect_uri`. */
  allowedPostLogoutRedirectUris?: string[];
  /**
   * Permit a server-managed (bff / bearer-from-endpoint) deployment to "log
   * out" without a backend `logoutEndpoint`. The backend session cookie then
   * survives, so the user is not actually logged out. Explicit acknowledgement
   * only; reported by `diagnose()`, which stays non-OK.
   */
  acknowledgeNoBackendLogout?: boolean;
  /**
   * Accept a server that does not implement `POST /revoke` (404/405/501).
   * Logout then cannot invalidate the credential server-side. Explicit
   * acknowledgement only; `diagnose()` stays non-OK.
   */
  acknowledgeUnsupportedRevocation?: boolean;
  /**
   * Log out WITHOUT attempting server-side revocation at all. The refresh
   * credential stays live until it expires. Explicit acknowledgement only;
   * `diagnose()` stays non-OK.
   */
  acknowledgeNoRevocation?: boolean;
  /**
   * Accept an authorization server that does not send `iss` even though
   * `expectedIssuer` is configured. Explicit acknowledgement only; `diagnose()`
   * stays non-OK.
   */
  acknowledgeMissingIssuer?: boolean;
  /**
   * Expected `iss` for authorization responses (RFC 9207). When set, an `iss`
   * parameter must match it exactly. When unset, a response carrying `iss` is
   * rejected rather than silently ignored.
   */
  expectedIssuer?: string;
  /**
   * Require that a login started in THIS tab before `handleCallback()` will
   * accept a code+state pair.
   *
   * SCOPE: this proves only that *some* login began in this browsing context.
   * It is NOT state binding - the server owns `state` (it carries the PKCE
   * verifier), so the client cannot bind a response to a specific request;
   * that needs server-side support. Default true.
   */
  requireLoginTransaction?: boolean;
  /**
   * Required to actually turn `requireLoginTransaction` off, so that dropping
   * the login-CSRF check is always a deliberate, visible opt-out.
   */
  acknowledgeNoLoginTransaction?: boolean;
  /** Lifetime of a pending login transaction, seconds. Default 600. */
  loginTransactionTtlSeconds?: number;
}

export interface AuthConfig {
  /** e.g. "https://api.example.org/api/freva-nextgen/auth/v2" or a same-origin path. */
  authBaseUrl: string;
  /** Absolute URL of the SPA route that handles the IDP redirect. */
  redirectUri: string;
  postLogoutRedirectUri?: string;
  /**
   * Endpoint for userinfo(). Defaults to `{authBaseUrl}/userinfo` (Bearer).
   * REQUIRED in bff transport, where requests carry no Bearer token and the
   * server's own /userinfo would reject the credentialed bare call - point
   * it at the backend's session-userinfo route instead.
   */
  userinfoEndpoint?: string;

  /** REQUIRED - no default. Choosing where the credential rests is a deployment decision. */
  storage: TokenStorage;

  refreshBufferSeconds?: number; // default 120
  clockSkewSeconds?: number; // default 30
  refreshTimeoutMs?: number; // default 10000

  crossTab?: boolean; // default true
  /** Isolates sessions for two apps on one origin (e.g. admin vs public UI). */
  channelNamespace?: string;
  /** Full override of the derived channel name. */
  channelName?: string;
  useNavigatorLocks?: boolean; // default true

  fetchImpl?: typeof fetch;
  onEvent?: (event: AuthEvent) => void;
  security?: SecurityOptions;
  /** Injectable clock (epoch seconds) for tests. */
  now?: () => number;
  /** Injectable navigation (default: location.assign). For tests/embedding. */
  navigate?: (url: string) => void;
}

export interface LoginOptions {
  prompt?: "login" | "consent" | "select_account" | "none";
  offlineAccess?: boolean;
  scope?: string;
  redirectUri?: string;
  /** App route to return to after the callback; stored in sessionStorage (non-secret). */
  next?: string;
}

export interface FetchAuthOptions {
  requireAuth?: boolean; // default true
  retryOn401?: boolean; // default true
  refresh?: "auto" | "force" | "never"; // default "auto"
}

export interface GetTokenOptions {
  refresh?: "auto" | "force" | "never"; // default "auto"
}

/** Cross-tab messages. NEVER carry token values. */
export type CrossTabMessage =
  | {
      type: "token-updated";
      tabId: string;
      sessionVersion: string;
      exp: number;
      at: number;
    }
  | {
      type: "logout";
      tabId: string;
      reason: SessionEndReason;
      /**
       * Bounded opaque id correlating this with its session-cleared.
       * MANDATORY: an uncorrelated terminal message could clear any session
       * at all.
       */
      operationId: string;
      /**
       * Session binding, metadata only. The fingerprint of the credential the
       * operation is ending - never the credential itself. Absent when the
       * sender holds no token (BFF), in which case `startedAt` is the binding.
       */
      sessionVersion?: string;
      /**
       * When the operation began: MILLISECONDS since the Unix epoch, the same
       * unit as `at`. A stable epoch for binding tokenless (BFF) state, where
       * there is no credential to fingerprint.
       */
      startedAt: number;
      at: number;
    }
  /** Drop local credentials now; the initiating tab has not finished yet. */
  | {
      type: "session-cleared";
      tabId: string;
      reason: SessionEndReason;
      operationId: string;
      sessionVersion?: string;
      startedAt: number;
      at: number;
    };
