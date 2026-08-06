import {
  createCrossTab,
  deriveChannelName,
  withCrossTabLock,
  MESSAGE_MAX_AGE,
  type CrossTabHandle,
} from "./crosstab.js";
import { isExpired, isExpiring, nowSeconds } from "./jwt.js";
import {
  AuthError,
  LoginTransactionError,
  NotAuthenticatedError,
  RefreshError,
  CallbackError,
  RevocationError,
  canonicalizeStoredToken,
  SessionExpiredError,
  StorageContractError,
  classifyRefreshStatus,
  normalizeTokenResponse,
  summarizeToken,
} from "./token.js";
import {
  OriginNotAllowedError,
  RedirectNotAllowedError,
  buildAllowedOrigins,
  isSecureTransport,
  OIDC_RESPONSE_PARAMS,
  callbackMatches,
  canonicalReturnPath,
  fragmentResponseParams,
  scrubFragment,
  snapshotDestination,
  type Destination,
  normalizeForExactMatch,
  resolveRequestUrl,
  validateConfigUrl,
  validatePositiveNumber,
} from "./url.js";
import { SessionGate, type SessionLease } from "./session.js";
import {
  CredentialRegistry,
  revocationTargetsOf,
  type CredentialHandle,
  type RevocationOutcome,
  type RevocationTarget,
} from "./recovery.js";
import {
  PROMPTS,
  REFRESH_MODES,
  assertStorageShape,
  strictBoolean,
  strictFunction,
  strictNumber,
  strictString,
  strictStringArray,
  validateCallOptions,
} from "./validate.js";
import type {
  AuthConfig,
  SecurityWarningCode,
  AuthEvent,
  CrossTabMessage,
  DiagnoseCheck,
  DiagnoseReport,
  FetchAuthOptions,
  GetTokenOptions,
  LifecycleIdentity,
  LoginOptions,
  SessionEndReason,
  StoredToken,
  TokenStorage,
} from "./types.js";

/**
 * Unguessable transaction id. Fails closed: `Math.random()` is not a CSPRNG,
 * and silently downgrading a security identifier to it is worse than not
 * having one, because the calling code cannot tell.
 */
function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.getRandomValues) {
    throw new AuthError(
      "crypto.getRandomValues is unavailable, so a security transaction " +
        "identifier cannot be generated. Refusing to fall back to " +
        "Math.random(), which is predictable. Use a secure context (https or " +
        "localhost) or a runtime with Web Crypto.",
    );
  }
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface ServerManagedLike {
  transport?: string;
  tokenEndpoint?: string;
  healthUrl?: string;
  logoutEndpoint?: string;
  hasTokenProvider?: boolean;
  hasCsrf?: boolean;
  acknowledgedNoCsrf?: boolean;
  acknowledgedUnsafeMintMethod?: boolean;
  acknowledgedMintWithoutCsrf?: boolean;
  acknowledgedRefreshCapableToken?: boolean;
  csrfHeaders?: () => Promise<Record<string, string>>;
  peek?: () => StoredToken | null;
  onDiscardedMint?: (sink: (token: StoredToken) => void) => void;
}

/**
 * Wall clock in MILLISECONDS, for the lifecycle-message domain only.
 *
 * `AuthConfig.now` is a separate injectable SECONDS clock, used only to make
 * token expiry testable. Lifecycle messages carry `at` and `startedAt`, which
 * are compared against each other, so both must come from this millisecond
 * clock - mixing the two units puts any such comparison three orders of
 * magnitude out.
 */
function wallClockMs(): number {
  return Date.now();
}

/** The closed set a storage may declare. Anything else is a config error. */
const LIFECYCLE_IDENTITIES: readonly LifecycleIdentity[] = [
  "shared-credential",
  "managed-bearer",
  "per-tab",
  "ambient",
];

/**
 * What a storage CLAIMS to be, from its public `kind`/`transport` strings.
 *
 * A claim, not a proof. `TokenStorage` is a structural interface: any object
 * can set `kind: "cookie"`. This is used ONLY to check that a declaration is
 * consistent with the claim - never to decide the identity, and never to waive
 * the requirement to declare one.
 */
function claimedLifecycleIdentity(storage: TokenStorage): LifecycleIdentity | null {
  const sm = storage as { kind?: string; transport?: string };
  if (sm.kind === "server-managed") {
    return sm.transport === "bff" ? "ambient" : "managed-bearer";
  }
  if (sm.kind === "memory") return "per-tab";
  if (sm.kind === "cookie") return "shared-credential";
  return null;
}

/**
 * Decide, ONCE and from an explicit declaration, what a credential fingerprint
 * means in this deployment.
 *
 * MUTATION ANCHOR: the declaration is universal; `kind` never waives it.
 * `TokenStorage` is structural, so a `kind` string is self-asserted and can
 * never short-circuit the requirement: a tab-partitioned storage claiming
 * `kind: "cookie"` would be classified `shared-credential`, where a fingerprint
 * mismatch REJECTS a peer's logout and one tab's credential survives another
 * tab's sign-out. The built-in storage classes carry the field themselves, so
 * they need no caller configuration; nothing else gets a shortcut.
 *
 * `persistent: true` is a different axis (time, not space) and is deliberately
 * not consulted here.
 */
function classifyLifecycleIdentity(
  storage: TokenStorage,
  crossTabEnabled: boolean,
): LifecycleIdentity {
  const declared = (storage as { lifecycleIdentity?: unknown }).lifecycleIdentity;
  const claimed = claimedLifecycleIdentity(storage);

  if (declared !== undefined) {
    if (
      typeof declared !== "string" ||
      !(LIFECYCLE_IDENTITIES as readonly string[]).includes(declared)
    ) {
      throw new AuthError(
        `AuthConfig.storage.lifecycleIdentity must be one of ` +
          `${LIFECYCLE_IDENTITIES.join(" | ")}, got ${JSON.stringify(declared)}.`,
      );
    }
    // Consistency only, and only now that a declaration exists.
    if (claimed && declared !== claimed) {
      throw new AuthError(
        `AuthConfig.storage.lifecycleIdentity is ${JSON.stringify(declared)}, ` +
          `which contradicts a storage declaring kind ` +
          `${JSON.stringify(storage.kind)}${
            (storage as { transport?: string }).transport
              ? ` / transport ${JSON.stringify((storage as { transport?: string }).transport)}`
              : ""
          } (${claimed}). Fix one of the two: a declaration cannot change how a ` +
          "storage actually shares credentials between tabs.",
      );
    }
    return declared as LifecycleIdentity;
  }

  if (crossTabEnabled) {
    throw new AuthError(
      "AuthConfig.storage.lifecycleIdentity is required when cross-tab " +
        "coordination is enabled: it decides whether another tab's logout is " +
        "about this tab, and there is no safe way to guess it. The built-in " +
        "storages declare it for you; a custom storage must declare one of " +
        `${LIFECYCLE_IDENTITIES.join(" | ")} - "shared-credential" only if ` +
        "every tab genuinely reads the same stored credential (neither " +
        "persistence nor a `kind` string means that). Or set crossTab: false.",
    );
  }
  // Cross-tab is off, so no lifecycle message is ever received and this value
  // is never consulted. Report the conservative one rather than invent a
  // sharing claim.
  return "per-tab";
}

interface RefreshOutcome {
  token: StoredToken;
  /** True when this attempt actually performed a server-side rotation. */
  rotated: boolean;
}

interface RefreshInflight {
  promise: Promise<RefreshOutcome>;
  forced: boolean;
  /**
   * The session generation this attempt belongs to. A caller from a DIFFERENT
   * generation must never join it: adopting the result of an attempt made in
   * another session is a session-boundary crossing disguised as request
   * coalescing.
   */
  generation: number;
}

/** One peer tab's lifecycle operation, as tracked here. */
interface PeerOperation {
  /** This tab's own block, released only by this operation. */
  block: symbol;
  /** The peer epoch when it started; a newer session bumps it. */
  epoch: number;
  /** True once its local clear has resolved one way or the other. */
  settled: boolean;
}

/**
 * A logout that could not confirm every invalidation step.
 *
 * Distinguished from a pre-flight configuration/validation error, which throws
 * before anything is invalidated and therefore leaves no ambiguous state.
 */
class IncompleteLogoutError extends AuthError {}

/**
 * Framework-agnostic client for py-oidc-auth `auth/v2` routes.
 *
 * Topology-blind about deployment shape: it never guesses whether a backend
 * exists, and every storage mode stays constructible. It is NOT permissive
 * about credential handling - `storage` and the resource-origin allowlist are
 * both decisions the integrator has to state, because in broker mode the
 * Bearer this client attaches IS the refresh credential.
 */
export class PyOidcAuthClient {
  readonly storage: TokenStorage;
  readonly channelName: string;
  /** Origins permitted to receive the Authorization header. */
  readonly allowedResourceOrigins: readonly string[];
  /**
   * How this deployment relates a credential to a session. Decided once, from
   * the storage, and used for every cross-tab lifecycle decision. Exposed
   * because it changes an observable contract (see README, "Cross-tab
   * lifecycle by topology").
   */
  readonly lifecycleIdentity: LifecycleIdentity;

  private readonly base: string;
  private readonly redirectUri: string;
  private readonly postLogoutRedirectUri?: string;
  private readonly buffer: number;
  private readonly skew: number;
  private readonly timeoutMs: number;
  private readonly useNavLocks: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly navigate: (url: string) => void;
  private readonly warnReadable: boolean;
  private readonly requireLoginTransaction: boolean;
  private readonly allowInsecureTransport: boolean;
  private readonly loginTxnTtl: number;
  private readonly allowedRedirectUris: string[];
  private readonly allowedRedirectUrls: URL[] = [];
  private readonly allowedPostLogoutRedirectUris: string[];
  private readonly acknowledgeNoBackendLogout: boolean;
  private readonly acknowledgeUnsupportedRevocation: boolean;
  private readonly acknowledgeNoRevocation: boolean;
  private readonly acknowledgeMissingIssuer: boolean;
  private readonly acknowledgeNoLoginTransaction: boolean;
  private readonly expectedIssuer?: string;
  /** Canonical absolute snapshots; the caller's config object is not retained. */
  private readonly userinfoEndpoint?: string;
  private readonly postLogoutRedirectUriCanonical?: string;

  private readonly listeners = new Set<(e: AuthEvent) => void>();
  private crosstab: CrossTabHandle | null = null;
  private refreshInflight: RefreshInflight | null = null;
  /**
   * A freshly rotated token that `storage.save()` refused. The old credential
   * is already dead server-side, so dropping this would strand the session
   * with no signal. Held for the life of the page; wins over storage until a
   * save succeeds or the session is cleared.
   */
  private degraded: StoredToken | null = null;
  private warnedRefreshCapableBearer = false;
  private warnedLongLivedManagedToken = false;
  private warnedUnsupportedRevocation = false;
  /**
   * Peer lifecycle operations currently being tracked, keyed by
   * `(tabId, operationId)`. Keyed rather than single-slot so two overlapping
   * peer logouts cannot overwrite each other's block.
   */
  private readonly peerOperations = new Map<string, PeerOperation>();
  /**
   * Peer operations that a later, established session has superseded, or that
   * have already run their terminal step. A message from one of these must not
   * clear storage, terminate the gate or release a block: it belongs to a
   * session that is already over.
   */
  private readonly retiredPeerOperations = new Map<string, number>();
  /**
   * Bumped whenever peer operations are retired. An asynchronous continuation
   * inside `onCrossTab` captures it and refuses to act if it has moved on.
   */
  private peerEpoch = 0;
  /**
   * Held while a logout could not confirm that the credential is gone. Survives
   * `login()`; released only by a logout that completes successfully.
   */
  private logoutFailedBlock: symbol | null = null;
  /**
   * Retained blocks taken because a peer clear or a terminal-refresh
   * transition could not remove the credential. They survive `login()`; a
   * local logout that COMPLETES resolves the condition they exist for and
   * releases them all.
   */
  private readonly recoveryBlocks = new Set<symbol>();
  /**
   * Block held because a credential is known to be live and unrevoked. Cleared
   * only when its revocation finally succeeds.
   */
  private pendingRevocationBlock: symbol | null = null;
  /**
   * Every credential this page knows about that may still be usable: minted
   * but unconfirmed, and - crucially - every one whose revocation failed. The
   * latter must be retained or a retry has nothing left to revoke with.
   */
  private readonly credentials = new CredentialRegistry();
  /** Serializes token persistence against logout clearing. */
  private storageMutation: Promise<unknown> = Promise.resolve();
  private observedRefreshCapableBearer = false;
  /** Set once the server answers 404/405 on /revoke. Surfaced by diagnose(). */
  private revocationUnsupported = false;
  /**
   * Independently owned blockers plus a monotonic generation. Ownership keeps a
   * peer's clear from releasing a local logout's block, and the generation stops
   * work started before a logout from finishing afterwards and recreating the
   * credential.
   */
  private readonly gate = new SessionGate();
  /** Coalesces concurrent logout() calls onto one operation. */
  private logoutInflight: Promise<void> | null = null;

  constructor(config: AuthConfig) {
    if (!config || !config.storage) {
      throw new AuthError(
        "AuthConfig.storage is required - choosing where the credential " +
          "rests is a deployment decision (MemoryStorage | CookieStorage | " +
          "ServerManagedStorage | custom TokenStorage). See docs/SPEC.md §3.",
      );
    }

    // RUNTIME validation of every security-relevant value. TypeScript types
    // are erased, so a plain-JS caller could pass allowInsecureTransport:
    // "false" and have the truthy string ENABLE plaintext transport.
    assertStorageShape(config.storage, "AuthConfig.storage");
    const sec = (config.security ?? {}) as Record<string, unknown>;
    for (const key of [
      "warnOnBrowserReadableRefresh",
      "requireLoginTransaction",
      "acknowledgeNoLoginTransaction",
      "allowInsecureTransport",
      "acknowledgeNoBackendLogout",
      "acknowledgeUnsupportedRevocation",
      "acknowledgeNoRevocation",
      "acknowledgeMissingIssuer",
    ]) {
      strictBoolean(
        sec[key],
        `AuthConfig.security.${key}`,
        key === "warnOnBrowserReadableRefresh" || key === "requireLoginTransaction",
      );
    }
    strictStringArray(sec.allowedResourceOrigins, "AuthConfig.security.allowedResourceOrigins");
    strictStringArray(sec.allowedRedirectUris, "AuthConfig.security.allowedRedirectUris");
    strictStringArray(
      sec.allowedPostLogoutRedirectUris,
      "AuthConfig.security.allowedPostLogoutRedirectUris",
    );
    strictString(sec.expectedIssuer, "AuthConfig.security.expectedIssuer");
    strictNumber(sec.loginTransactionTtlSeconds, "AuthConfig.security.loginTransactionTtlSeconds", {
      min: 1,
      max: 86400,
    });
    const cfg = config as unknown as Record<string, unknown>;
    strictBoolean(cfg.crossTab, "AuthConfig.crossTab", true);
    strictBoolean(cfg.useNavigatorLocks, "AuthConfig.useNavigatorLocks", true);
    strictString(cfg.channelNamespace, "AuthConfig.channelNamespace", { maxLength: 256 });
    strictString(cfg.channelName, "AuthConfig.channelName", { maxLength: 256 });
    strictFunction(cfg.fetchImpl, "AuthConfig.fetchImpl");
    strictFunction(cfg.onEvent, "AuthConfig.onEvent");
    strictFunction(cfg.now, "AuthConfig.now");
    strictFunction(cfg.navigate, "AuthConfig.navigate");
    strictNumber(cfg.refreshBufferSeconds, "AuthConfig.refreshBufferSeconds", {
      min: 0,
      max: 86400,
    });
    strictNumber(cfg.clockSkewSeconds, "AuthConfig.clockSkewSeconds", { min: 0, max: 86400 });
    strictNumber(cfg.refreshTimeoutMs, "AuthConfig.refreshTimeoutMs", { min: 1, max: 600000 });

    // Fail closed on configuration: a bad base URL or a plaintext redirect
    // must not surface as a mysterious 401 (or a credential on the wire) an
    // hour into the session. Every value is checked in RESOLVED absolute form.
    const insecureOk = strictBoolean(
      sec.allowInsecureTransport,
      "AuthConfig.security.allowInsecureTransport",
    );
    const baseUrl = validateConfigUrl(config.authBaseUrl, "AuthConfig.authBaseUrl", {
      allowRelative: true,
      allowInsecure: insecureOk,
    });
    const redirect = validateConfigUrl(config.redirectUri, "AuthConfig.redirectUri", {
      allowRelative: true,
      allowQuery: true,
      allowInsecure: insecureOk,
    });
    if (config.postLogoutRedirectUri !== undefined) {
      validateConfigUrl(config.postLogoutRedirectUri, "AuthConfig.postLogoutRedirectUri", {
        allowRelative: true,
        allowQuery: true,
        allowInsecure: insecureOk,
      });
    }
    let userinfo: string | undefined;
    if (config.userinfoEndpoint !== undefined) {
      const u = validateConfigUrl(config.userinfoEndpoint, "AuthConfig.userinfoEndpoint", {
        allowRelative: true,
        allowQuery: true,
        allowInsecure: insecureOk,
      });
      // Canonical ABSOLUTE, snapshotted: the caller's config object is never
      // read again, and a <base> cannot move it later.
      userinfo = u ? u.href : config.userinfoEndpoint;
    }
    this.userinfoEndpoint = userinfo;
    this.postLogoutRedirectUriCanonical =
      config.postLogoutRedirectUri !== undefined
        ? (validateConfigUrl(config.postLogoutRedirectUri, "AuthConfig.postLogoutRedirectUri", {
            allowRelative: true,
            allowQuery: true,
            allowInsecure: insecureOk,
          })?.href ?? config.postLogoutRedirectUri)
        : undefined;
    validatePositiveNumber(config.refreshBufferSeconds, "AuthConfig.refreshBufferSeconds");
    validatePositiveNumber(config.clockSkewSeconds, "AuthConfig.clockSkewSeconds");
    validatePositiveNumber(config.refreshTimeoutMs, "AuthConfig.refreshTimeoutMs", {
      allowZero: false,
    });
    validatePositiveNumber(
      config.security?.loginTransactionTtlSeconds,
      "AuthConfig.security.loginTransactionTtlSeconds",
      { allowZero: false },
    );

    this.storage = config.storage;
    // Snapshotted here: mutating `storage.lifecycleIdentity` afterwards cannot
    // change policy.
    this.lifecycleIdentity = classifyLifecycleIdentity(config.storage, config.crossTab !== false);
    // A server-managed pull can mint a credential and then find the session
    // gone. The storage discards it (correctly - it must not be cached), but
    // something has to remember that it EXISTS and is live server-side.
    (this.storage as ServerManagedLike).onDiscardedMint?.((token) => {
      this.adoptDiscardedMint(token);
    });
    // Canonical ABSOLUTE base: a relative one would later be re-resolved
    // against the document base URL, which a `<base>` element controls.
    this.base = (baseUrl ? baseUrl.href : config.authBaseUrl).replace(/\/+$/, "");
    this.redirectUri = redirect ? redirect.href : config.redirectUri;
    this.postLogoutRedirectUri = this.postLogoutRedirectUriCanonical;
    this.buffer = config.refreshBufferSeconds ?? 120;
    this.skew = config.clockSkewSeconds ?? 30;
    this.timeoutMs = config.refreshTimeoutMs ?? 10_000;
    this.useNavLocks = config.useNavigatorLocks ?? true;
    this.fetchImpl =
      config.fetchImpl ??
      (typeof fetch !== "undefined"
        ? fetch.bind(globalThis)
        : (() => {
            throw new AuthError("No fetch implementation available.");
          })());
    this.now = config.now ?? nowSeconds;
    this.navigate =
      config.navigate ??
      ((url: string) => {
        if (typeof location !== "undefined") location.assign(url);
      });
    this.warnReadable = config.security?.warnOnBrowserReadableRefresh ?? true;
    this.requireLoginTransaction = config.security?.requireLoginTransaction ?? true;
    this.allowInsecureTransport = config.security?.allowInsecureTransport ?? false;
    this.loginTxnTtl = config.security?.loginTransactionTtlSeconds ?? 600;
    this.allowedResourceOrigins = Object.freeze(
      buildAllowedOrigins(
        baseUrl,
        config.security?.allowedResourceOrigins,
        this.allowInsecureTransport,
      ),
    );

    // Exact-match redirect allowlists. Defaulting to the single configured
    // URI means the safe case needs no extra config, while a second target is
    // a deliberate, reviewable line.
    this.allowedRedirectUris = this.buildRedirectAllowlist(
      config.security?.allowedRedirectUris ?? [config.redirectUri],
      "security.allowedRedirectUris",
      redirect,
    );
    this.acknowledgeNoBackendLogout = config.security?.acknowledgeNoBackendLogout ?? false;
    this.acknowledgeUnsupportedRevocation =
      config.security?.acknowledgeUnsupportedRevocation ?? false;
    this.acknowledgeNoRevocation = config.security?.acknowledgeNoRevocation ?? false;
    this.acknowledgeMissingIssuer = config.security?.acknowledgeMissingIssuer ?? false;
    this.acknowledgeNoLoginTransaction = config.security?.acknowledgeNoLoginTransaction ?? false;
    // The expected issuer is itself security configuration: an http or
    // query-bearing "issuer" cannot be what RFC 9207 compares against.
    if (config.security?.expectedIssuer !== undefined) {
      const iss = validateConfigUrl(config.security.expectedIssuer, "security.expectedIssuer", {
        allowRelative: false,
      });
      if (iss && iss.protocol !== "https:") {
        throw new AuthError(
          "security.expectedIssuer must be an https URL (RFC 9207 issuer " +
            "identifiers are https origins).",
        );
      }
    }
    this.expectedIssuer = config.security?.expectedIssuer;
    // Turning the login-CSRF check off is a security opt-out, not a knob.
    if (config.security?.requireLoginTransaction === false && !this.acknowledgeNoLoginTransaction) {
      throw new AuthError(
        "security.requireLoginTransaction: false also requires " +
          "security.acknowledgeNoLoginTransaction. Disabling the login-CSRF " +
          "check is a deliberate exposure and must be reported by diagnose().",
      );
    }
    this.allowedPostLogoutRedirectUris = this.buildRedirectAllowlist(
      config.security?.allowedPostLogoutRedirectUris ??
        (config.postLogoutRedirectUri ? [config.postLogoutRedirectUri] : []),
      "security.allowedPostLogoutRedirectUris",
      null,
    );

    // Endpoints the storage will call with ambient credentials are policed
    // too - a logout endpoint on another origin would otherwise receive the
    // CSRF secret and the session cookie.
    const smEndpoints = this.serverManaged();
    for (const [label, value] of [
      ["ServerManagedStorage.tokenEndpoint", smEndpoints?.tokenEndpoint],
      ["ServerManagedStorage.healthUrl", smEndpoints?.healthUrl],
      ["ServerManagedStorage.logoutEndpoint", smEndpoints?.logoutEndpoint],
    ] as const) {
      if (!value) continue;
      const u = validateConfigUrl(value, label, {
        allowRelative: true,
        allowQuery: true,
        allowInsecure: this.allowInsecureTransport,
      });
      if (u && !this.allowedResourceOrigins.includes(u.origin)) {
        throw new OriginNotAllowedError(
          u.origin,
          [...this.allowedResourceOrigins],
          `credentialed requests for ${label}`,
        );
      }
    }
    if (config.onEvent) this.listeners.add(config.onEvent);

    this.channelName =
      config.channelName ??
      deriveChannelName({
        authBaseUrl: this.base,
        namespace: config.channelNamespace,
        storageKey: this.storageKey(),
      });

    if (config.crossTab ?? true) {
      this.crosstab = createCrossTab(this.channelName, (m) => this.onCrossTab(m));
    }

    if (this.warnReadable) {
      if (this.storage.kind === "cookie") {
        this.emit({
          type: "security-warning",
          code: "browser-readable-refresh-credential",
          message:
            "CookieStorage holds a refresh-capable broker JWT readable by " +
            "any same-origin script (httpOnly=false), and RFC 6265 attaches " +
            "it to every matching same-origin request - including its " +
            "proxies, middleware and access logs. Compatibility mode only: " +
            "pair with a strict CSP, or prefer ServerManagedStorage / " +
            "MemoryStorage.",
        });
      } else if (!this.storage.kind || this.storage.kind === "custom") {
        this.emit({
          type: "security-warning",
          code: "unverifiable-custom-storage",
          message:
            "Custom TokenStorage: this library cannot verify whether it " +
            "protects refresh-capable credentials.",
        });
      }
    }
    // Compatibility acknowledgements are announced unconditionally. They are
    // not "warnings you can turn off": each records that someone accepted a
    // known-unsafe state, and warnOnBrowserReadableRefresh must not hide that.
    for (const ack of this.compatibilityAcknowledgements()) {
      this.emit({
        type: "security-warning",
        code: ack.code,
        message: ack.message,
      });
    }
  }

  /**
   * Every active compatibility acknowledgement, as passive metadata.
   *
   * Reading this performs NO I/O and changes no state, so `diagnose()` can use
   * it. Each entry becomes both a construction-time warning and a failed
   * diagnostic check - an acknowledgement records accepted risk, it never
   * marks the deployment healthy.
   */
  private compatibilityAcknowledgements(): Array<{
    code: SecurityWarningCode;
    name: string;
    message: string;
  }> {
    const out: Array<{ code: SecurityWarningCode; name: string; message: string }> = [];
    const sm = this.serverManaged();

    if (this.allowInsecureTransport) {
      out.push({
        code: "insecure-transport",
        name: "ack:insecure-transport",
        message:
          "security.allowInsecureTransport is set: credentials may travel over " +
          "plaintext http, where anyone on the path can take the session.",
      });
    }
    if (this.acknowledgeNoBackendLogout) {
      out.push({
        code: "no-backend-logout",
        name: "ack:no-backend-logout",
        message:
          "security.acknowledgeNoBackendLogout is set: logout does not contact " +
          "the backend holding the session, so the user stays logged in there.",
      });
    }
    if (this.acknowledgeUnsupportedRevocation) {
      out.push({
        code: "unsupported-revocation",
        name: "ack:unsupported-revocation",
        message:
          "security.acknowledgeUnsupportedRevocation is set: a logout cannot " +
          "invalidate the credential server-side.",
      });
    }
    if (this.acknowledgeNoLoginTransaction) {
      out.push({
        code: "no-login-transaction",
        name: "ack:no-login-transaction",
        message:
          "security.acknowledgeNoLoginTransaction is set: callbacks are " +
          "accepted without evidence that a login began in this tab.",
      });
    }
    if (this.acknowledgeMissingIssuer) {
      out.push({
        code: "missing-issuer",
        name: "ack:missing-issuer",
        message:
          "security.acknowledgeMissingIssuer is set: authorization responses " +
          "are accepted without the RFC 9207 `iss` parameter.",
      });
    }
    if (
      (this.storage as { acknowledgedInsecureTransport?: boolean }).acknowledgedInsecureTransport
    ) {
      out.push({
        code: "insecure-cookie-transport",
        name: "ack:insecure-cookie-transport",
        message:
          "CookieStorage allowInsecureTransport is set: a refresh-capable " +
          "cookie is in use on a plaintext origin.",
      });
    }
    if ((this.storage as { acknowledgedInsecureCookie?: boolean }).acknowledgedInsecureCookie) {
      out.push({
        code: "insecure-cookie-transport",
        name: "ack:insecure-cookie",
        message:
          "CookieStorage acknowledgeInsecureCookie is set: the refresh cookie " +
          "is written without the Secure attribute.",
      });
    }
    if (sm?.acknowledgedUnsafeMintMethod) {
      out.push({
        code: "unsafe-token-endpoint-method",
        name: "ack:unsafe-token-endpoint-method",
        message:
          "ServerManagedStorage mints credentials with GET, which is neither " +
          "safe nor idempotent and may be cached, prefetched or logged.",
      });
    }
    if (sm?.acknowledgedMintWithoutCsrf) {
      out.push({
        code: "token-endpoint-without-csrf",
        name: "ack:token-endpoint-without-csrf",
        message:
          "ServerManagedStorage mints credentials with ambient cookies and no " +
          "CSRF header managed by this library.",
      });
    }
    if (this.acknowledgeNoRevocation) {
      out.push({
        code: "no-revocation",
        name: "ack:no-revocation",
        message:
          "security.acknowledgeNoRevocation is set: logout never attempts " +
          "revocation, so the refresh credential stays live until it expires.",
      });
    }
    if (
      (this.storage as { acknowledgedBrokerSingleToken?: boolean }).acknowledgedBrokerSingleToken
    ) {
      out.push({
        code: "legacy-cookie-storage",
        name: "ack:legacy-cookie-storage",
        message:
          "CookieStorage legacy single-token contract acknowledged: a " +
          "refresh-capable JWT is script-readable and rides every same-origin " +
          "request.",
      });
    }
    if (sm?.acknowledgedNoCsrf) {
      out.push({
        code: "bff-without-csrf",
        name: "ack:bff-without-csrf",
        message:
          "ServerManagedStorage(bff) acknowledgeNoCsrf is set: credentialed " +
          "requests carry no CSRF header managed by this library.",
      });
    }
    if (sm?.acknowledgedRefreshCapableToken) {
      out.push({
        code: "refresh-capable-managed-token",
        name: "ack:refresh-capable-managed-token",
        message:
          "ServerManagedStorage allowRefreshCapableToken is set: the browser " +
          "holds refresh capability, which this transport exists to prevent.",
      });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------

  on(listener: (event: AuthEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AuthEvent): void {
    // A lost credential with nobody listening must not be silent. The message
    // is FIXED - never the storage's own exception text, which can embed the
    // credential it just failed to write.
    if (event.type === "storage-write-failed" && this.listeners.size === 0) {
      console.warn(
        `[py-oidc-auth] storage rejected a freshly rotated token during ` +
          `${event.phase} (${event.reasonCode}). The session is running from ` +
          `a per-page memory mirror and will not survive a reload.`,
      );
    }
    // MUTATION ANCHOR: clear failures describe a failed clear.
    // A distinct incident from the one above, with a different remedy: an OLD
    // credential could not be removed and the client is fail-closed, not a
    // fresh token sitting in a memory mirror. Fixed text; the storage's own
    // exception is never forwarded.
    if (event.type === "session-clear-failed" && this.listeners.size === 0) {
      console.warn(
        `[py-oidc-auth] a ${event.scope} session end could not clear the ` +
          `stored credential (${event.reasonCode}). It may still be present ` +
          "in this browser, so token reads and authenticated requests are " +
          "blocked here until a logout() completes.",
      );
    }
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* listener errors must not break auth */
      }
    }
  }

  /** Close cross-tab channels and drop listeners (tests, SPA teardown). */
  destroy(): void {
    this.crosstab?.close();
    this.crosstab = null;
    this.listeners.clear();
  }

  /**
   * True when a rotated credential could not be persisted and the session is
   * running from the per-page memory mirror (it will not survive a reload).
   */
  isStorageDegraded(): boolean {
    return this.degraded !== null;
  }

  // ------------------------------------------------------------------
  // Login & callback
  // ------------------------------------------------------------------

  /**
   * Build the login URL. NOTE: this is a pure builder - it does NOT establish
   * the login transaction that `handleCallback()` requires. Use `login()` for
   * the full flow; if you must navigate yourself, call `beginLogin()` to get a
   * URL *and* record the transaction.
   */
  loginUrl(options: LoginOptions = {}): string {
    this.assertBrowserCodeFlowAllowed("loginUrl()");
    // Runtime validation FIRST - before a transaction or return path is
    // written, and before anything is sent.
    validateCallOptions(options, "loginUrl(options)", {
      booleans: ["offlineAccess"],
      enums: { prompt: PROMPTS },
      strings: ["scope", "redirectUri"],
    });
    // `next` is NOT accepted by the pure builder: it is a destination-like
    // value that only means something once a transaction is established.
    // Claiming "every option is validated" while quietly ignoring it would be
    // the worst of both. Use login() or beginLogin().
    if ((options as { next?: unknown }).next !== undefined) {
      throw new AuthError(
        "loginUrl({ next }) is not supported: loginUrl() is a pure builder " +
          "and establishes no login transaction, so a return path would be " +
          "silently dropped. Use login() or beginLogin().",
      );
    }
    const target = options.redirectUri ?? this.redirectUri;
    // An unchecked redirect_uri is an authorization-code harvesting primitive:
    // the IDP sends the code wherever this says.
    const canonical = this.assertRedirectAllowed(
      target,
      this.allowedRedirectUris,
      "login({ redirectUri })",
    );
    // Send the CANONICAL absolute value that was validated, not the raw one.
    const params = new URLSearchParams({ redirect_uri: canonical });
    if (options.prompt !== undefined) params.set("prompt", options.prompt);
    if (options.scope !== undefined) params.set("scope", options.scope);
    if (options.offlineAccess !== undefined) {
      params.set("offline_access", String(options.offlineAccess));
    }
    return `${this.base}/login?${params.toString()}`;
  }

  /**
   * URL for a login you will navigate to yourself, WITH the transaction
   * recorded - the pairing `loginUrl()` deliberately does not provide.
   */
  beginLogin(options: LoginOptions = {}): string {
    this.assertLoginAllowed("beginLogin()");
    const { next, ...builder } = options;
    const url = this.loginUrl(builder);
    this.prepareLoginState({ ...builder, next });
    this.gate.reset();
    this.retirePeerOperations();
    return url;
  }

  /** Stores the return path (non-secret) and performs a top-level redirect. */
  login(options: LoginOptions = {}): void {
    this.assertLoginAllowed("login()");
    this.assertBrowserCodeFlowAllowed("login()");
    // Validate everything BEFORE any state is written or navigation happens.
    const { next, ...builder } = options;
    const url = this.loginUrl(builder);
    this.prepareLoginState({ ...builder, next });
    this.gate.reset();
    this.retirePeerOperations();
    this.emit({ type: "login-started", url });
    // A `login-started` listener can synchronously call logout(). Recheck
    // after emitting, and if the lifecycle moved, remove the state written
    // here rather than navigate through a login the application cancelled.
    if (this.gate.lifecycleBusy() || this.gate.blocked()) {
      this.removeSession(this.txnKey());
      this.removeSession(this.nextKey());
      throw new NotAuthenticatedError(
        "login() was cancelled by a listener that started a session-ending " +
          "operation; the login transaction has been removed and no " +
          "navigation was performed.",
      );
    }
    this.navigate(url);
  }

  /** Write the return path and one-time transaction for a login about to start. */
  private prepareLoginState(options: LoginOptions): void {
    if (options.next !== undefined) {
      const canonical = canonicalReturnPath(options.next);
      if (canonical === null) {
        throw new AuthError(
          'login({ next }) must be a same-origin relative path (e.g. "/plots/42"). ' +
            "Control characters, whitespace, backslashes and anything that " +
            "resolves off-origin are rejected.",
        );
      }
      this.writeSession(this.nextKey(), canonical);
    }
    // Record that a login started in THIS tab. handleCallback() will not
    // accept a code+state pair without it, which is what stops an attacker
    // from planting their own authorization code in the victim's session.
    this.writeSession(this.txnKey(), JSON.stringify({ id: randomId(), at: this.now() }));
  }

  isCallbackUrl(url?: string): boolean {
    const u = this.parseUrl(url);
    if (!u) return false;
    // Only our own registered callback route counts, so an unrelated app URL
    // is never mistaken for an OIDC response.
    if (!this.isConfiguredCallback(u)) return false;
    // ROUTING: anything response-SHAPED on an owned route belongs to the
    // handler - code-only, state-only, error-only, an unsupported front-channel
    // token, duplicates. Not routing them means the app's router skips
    // handleCallback() and the credentials stay in the address bar.
    for (const key of OIDC_RESPONSE_PARAMS) {
      if (u.searchParams.has(key)) return true;
    }
    // Implicit/hybrid responses arrive in the FRAGMENT. Refusing to route them
    // leaves an access token sitting in the address bar and in history.
    return fragmentResponseParams(u).size > 0;
  }

  /**
   * Exchange code+state via GET {base}/callback (an XHR - no app backend
   * needed; py-oidc-auth completes PKCE and the confidential exchange
   * server-side), save the token, and scrub ONLY the OIDC params from the
   * address bar, preserving the app route, other params and hash.
   */
  async handleCallback(url?: string): Promise<StoredToken> {
    const lease = this.gate.lease();
    const u = this.parseUrl(url);
    if (!u) throw new AuthError("handleCallback: no URL available.");
    // Scrub whenever the URL being handled IS the current location - whether
    // passed implicitly or explicitly. Routers commonly hand over
    // `location.href` (or an equivalent constructed URL), and that style must
    // not silently skip the history cleanup. Genuinely foreign URLs (tests,
    // server-side parsing) remain non-scrubbing.
    const isCurrentLocation =
      typeof location !== "undefined" && (url === undefined || u.href === location.href);

    // The response must arrive at a callback we actually registered. Without
    // this, handleCallback(someForeignUrl) will happily exchange an attacker's
    // code against our session.
    if (!this.isConfiguredCallback(u)) {
      throw new RedirectNotAllowedError(
        `${u.origin}${u.pathname}`,
        this.allowedRedirectUris,
        "handleCallback: callback URL",
      );
    }

    // Snapshot every response parameter BEFORE scrubbing, then scrub, then
    // validate. Throwing a validation error first would leave `code` and
    // `state` in the address bar and browser history for exactly the responses
    // most likely to be hostile.
    const response = {
      code: u.searchParams.get("code"),
      state: u.searchParams.get("state"),
      error: u.searchParams.get("error"),
      errorDescription: u.searchParams.get("error_description"),
      iss: u.searchParams.getAll("iss"),
    };
    const duplicated = [...OIDC_RESPONSE_PARAMS].filter((k) => u.searchParams.getAll(k).length > 1);
    const mixed = u.searchParams.has("code") && u.searchParams.has("error");
    const fragmentParams = fragmentResponseParams(u);
    const unsupportedMode =
      ["id_token", "access_token", "response"].some((k) => u.searchParams.has(k)) ||
      fragmentParams.size > 0;

    // Scrubbing happens BEFORE every remaining check - topology, blocked
    // session, issuer, transaction, response shape. A callback refused because
    // it arrived during a logout (or while a retained failure block is held)
    // must not keep `code` and `state` in the address bar and browser history:
    // that is the exact leak scrubbing exists to prevent.
    //
    // Only after the scrub: is this topology even allowed to run a browser code
    // flow, and is the session in a state that may accept a new credential?
    // MUTATION ANCHOR: callback scrub precedes lifecycle rejection.
    this.scrubCallbackParams(u, isCurrentLocation);
    this.assertBrowserCodeFlowAllowed("handleCallback()");
    this.assertNotLoggingOut();

    if (duplicated.length > 0) {
      this.consumeLoginTransaction();
      throw new CallbackError("duplicate-parameter");
    }
    if (mixed) {
      this.consumeLoginTransaction();
      throw new CallbackError("mixed-response");
    }
    if (unsupportedMode) {
      // A token delivered in the front channel is scrubbed and refused: this
      // client only supports the authorization-code flow.
      this.consumeLoginTransaction();
      throw new CallbackError("unsupported-response-mode");
    }
    this.assertIssuer(response.iss);

    const error = response.error;
    if (error) {
      const description = response.errorDescription ?? "(no description)";
      const errorTxn = this.consumeLoginTransaction();
      if (this.requireLoginTransaction && !errorTxn) {
        throw new LoginTransactionError(
          "handleCallback: an error response arrived without a login " +
            "transaction started in this tab, so it cannot be attributed to a " +
            "login the user began here.",
        );
      }
      // The provider controls `error` and `error_description`, so neither is
      // interpolated into a message that applications log verbatim.
      void description;
      throw new CallbackError("provider-error");
    }
    const code = response.code;
    const state = response.state;
    if (!code || !state) {
      this.consumeLoginTransaction();
      throw new CallbackError("missing-code-or-state");
    }

    const txn = this.consumeLoginTransaction();
    if (this.requireLoginTransaction) {
      if (!txn) {
        throw new LoginTransactionError(
          "handleCallback: no login transaction was started in this tab, so " +
            "this callback cannot be attributed to a login the user began " +
            "here (login-CSRF defense). Start the flow with auth.login(), or " +
            "set security.requireLoginTransaction = false together with " +
            "security.acknowledgeNoLoginTransaction.",
        );
      }
      if (this.now() - txn.at > this.loginTxnTtl) {
        throw new LoginTransactionError(
          `handleCallback: the login transaction started in this tab expired ` +
            `(older than ${this.loginTxnTtl}s). Start the login again.`,
        );
      }
    }

    const qs = new URLSearchParams({ code, state });
    const callbackDest = this.bindDestination(
      `${this.base}/callback?${qs}`,
      "the authorization code",
    );
    // Reserved BEFORE the exchange: if this page is already tracking more
    // unconfirmed credentials than it can account for, the right answer is to
    // not ask the server for another one.
    const handle = this.reserveCredential("handleCallback()");
    // MUTATION ANCHOR: reservation released on every non-minting exit.
    // Network failure, a non-success status, a parse/contract rejection: the
    // slot must come back, or a page that hits three transient errors is
    // permanently unable to log in. It is a no-op once the handle holds a real
    // credential - that slot is released by `release()` and nothing else.
    try {
      const res = await this.fetchImpl(callbackDest.href, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        redirect: "error",
      });
      if (!res.ok) {
        throw new AuthError(`Callback exchange failed with ${res.status}.`);
      }
      const token = normalizeTokenResponse(await res.json(), this.now());
      // Registered before the lease check for the same reason as in postRefresh:
      // the credential now EXISTS server-side, so something must be able to
      // invalidate it even if this operation is about to be discarded.
      this.credentials.register(handle, token);
      // A logout that drained this reservation while the exchange was in
      // flight already ended the operation; whatever arrived is an orphan.
      if (!lease.valid() || this.credentials.wasCancelled(handle)) {
        await this.disownOrphanCredential(handle, token);
        this.assertLease(lease); // throws
      }
      this.noteTokenRisks(token);
      await this.persist(token, "callback", lease);
      this.assertLease(lease);
      this.credentials.release(handle);
      this.noteSessionEstablished(token);
      return this.completeCallback(token, lease);
    } finally {
      this.credentials.releaseReservation(handle);
    }
  }

  /** Announce, emit and return a token the callback exchange has persisted. */
  private completeCallback(token: StoredToken, lease: SessionLease): StoredToken {
    this.crosstab?.post({
      type: "token-updated",
      sessionVersion: token.sessionVersion,
      exp: token.expiresAt,
    });
    this.emit({
      type: "login-completed",
      token: summarizeToken(token),
      hasReturnPath: this.peekReturnPath() !== null,
    });
    // MUTATION ANCHOR: post-event lease validation (login-completed).
    // An application listener can synchronously call logout(); returning the
    // token afterwards hands back a credential the user just destroyed.
    this.assertLease(lease);
    return token;
  }

  /** Read-and-clear the path stashed by login({ next }). */
  consumeReturnPath(): string | null {
    const value = this.peekReturnPath();
    this.removeSession(this.nextKey()); // clear even when the value was rejected
    return value;
  }

  // ------------------------------------------------------------------
  // Tokens
  // ------------------------------------------------------------------

  async getToken(options: GetTokenOptions = {}): Promise<StoredToken | null> {
    validateCallOptions(options, "getToken(options)", {
      enums: { refresh: REFRESH_MODES },
    });
    this.assertNotLoggingOut();
    const lease = (options as { lease?: SessionLease }).lease ?? this.gate.lease();
    if (this.isBff()) return null; // bff: tokens never enter JS
    const mode = options.refresh ?? "auto";
    const token = await this.loadToken();
    this.assertLease(lease);
    if (mode === "never" || !token) return token;
    if (mode === "force") {
      return this.refreshWithOutcome(true, lease).then((r) => {
        this.assertLease(lease);
        return r.token;
      });
    }
    if (!isExpiring(token.expiresAt, this.now(), this.buffer)) return token;
    try {
      const refreshed = (await this.refreshWithOutcome(false, lease)).token;
      this.assertLease(lease);
      return refreshed;
    } catch (e) {
      // A terminal session end is ALREADY handled: storage was cleared, the
      // generation invalidated and the events emitted. `null` is the safe
      // answer and carries no credential, so it is returned before the lease
      // check below (which that very transition has just invalidated).
      if (e instanceof SessionExpiredError) return null; // already cleared+emitted
      // Other FAILURE branches are session boundaries too: a transient error
      // must not be converted into "return the old token" after a logout, and a
      // session-invalidated error must never become the stale-token fallback.
      // MUTATION ANCHOR: refresh failure-branch lease validation.
      this.assertLease(lease);
      if (e instanceof RefreshError && !isExpired(token.expiresAt, this.now(), this.skew)) {
        // Transient failure but the current token is still valid: use it.
        return token;
      }
      throw e;
    }
  }

  async requireToken(): Promise<StoredToken> {
    const token = await this.getToken();
    if (!token) throw new NotAuthenticatedError();
    return token;
  }

  /**
   * Single-flight per page; rotation-aware across tabs.
   *
   * A forced caller never joins a non-forced attempt in flight: the 401-retry
   * path forces precisely because the server rejected a token that looks
   * locally fine, and a non-forced refresh may short-circuit and hand back
   * that same rejected token.
   */
  refresh(options: { force?: boolean } = {}): Promise<StoredToken> {
    validateCallOptions(options, "refresh(options)", { booleans: ["force"] });
    this.assertNotLoggingOut();
    const lease = this.gate.lease();
    // A listener reacting to `token-refreshed` can have ended the session
    // before this handler runs.
    // MUTATION ANCHOR: public refresh() completion lease validation.
    return this.refreshWithOutcome(options.force === true, lease).then((r) => {
      this.assertLease(lease);
      return r.token;
    });
  }

  private refreshWithOutcome(force: boolean, lease: SessionLease): Promise<RefreshOutcome> {
    const current = this.refreshInflight;
    // Coalescing is only legitimate WITHIN one session. An entry from another
    // generation belongs to a session that has ended (or that this caller
    // predates); adopting its result would hand one session's credential to an
    // operation that belongs to another.
    if (current && current.generation === lease.generation && (!force || current.forced)) {
      return current.promise;
    }

    const entry: RefreshInflight = {
      forced: force,
      generation: lease.generation,
      promise: undefined as unknown as Promise<RefreshOutcome>,
    };
    // MUTATION ANCHOR: cross-generation refresh waiting.
    // Queueing behind an attempt from ANOTHER generation is not serialization,
    // it is a dependency on an operation whose result we may not use and whose
    // request may never return. The new session would sit behind a stranded
    // one indefinitely. The old attempt still holds its own lease and discards
    // or invalidates its own result.
    const settled: Promise<RefreshOutcome | null> =
      current && current.generation === lease.generation
        ? current.promise.then(
            (r) => r,
            () => null,
          )
        : Promise.resolve(null);
    entry.promise = settled
      .then((prior) => {
        // The attempt we queued behind may have taken arbitrarily long, and a
        // logout can have happened while we waited our turn.
        this.assertLease(lease);
        // If the attempt we queued behind actually rotated, its token is
        // brand new. Rotating again would immediately invalidate the result
        // the first caller is still holding, and burn a server rotation for
        // nothing - strict rotation means the loser then takes a 401.
        // Only adopt it when it belongs to OUR session.
        if (force && prior?.rotated) {
          return prior;
        }
        return this.doRefresh(force, lease);
      })
      .finally(() => {
        if (this.refreshInflight === entry) this.refreshInflight = null;
      });
    this.refreshInflight = entry;
    return entry.promise;
  }

  private async doRefresh(force: boolean, lease: SessionLease): Promise<RefreshOutcome> {
    if (this.isBff()) {
      throw new AuthError(
        "refresh() is not applicable in bff transport: the backend owns the " +
          "token lifecycle. Configure healthUrl pings server-side if needed.",
      );
    }
    if (this.isServerManaged()) {
      return { token: await this.serverManagedRefresh(lease), rotated: true };
    }

    const start = await this.loadToken();
    // storage.load() is an awaited boundary owned by third-party code; it can
    // resolve long after the session it was started for has ended.
    // MUTATION ANCHOR: initial refresh load validation.
    this.assertLease(lease);
    if (!start) {
      throw new NotAuthenticatedError("Cannot refresh: no token in storage.");
    }
    if (start.refreshable === false) {
      throw new AuthError(
        "Token is marked non-refreshable (refreshable=false); re-login " +
          "through the auth-code flow instead.",
      );
    }
    // Fail before taking the cross-tab lock and before any network call.
    this.refreshCredentialOf(start);

    return withCrossTabLock<RefreshOutcome>(
      `${this.channelName}:refresh`,
      this.useNavLocks,
      async () => {
        // Waiting for the lock is unbounded - another tab holds it - so the
        // session can end entirely between requesting and acquiring it.
        // MUTATION ANCHOR: cross-tab-lock validation.
        this.assertLease(lease);
        // Re-load under the lock: another tab may have rotated already.
        // Each continuation below revalidates for itself, immediately before it
        // returns, sends or persists a credential - one check per call site, so
        // deleting any single one is individually detectable.
        const latest = await this.loadToken();
        if (!latest) {
          // The session disappeared underneath us while we held the lock. Same
          // transition: block, invalidate every lease, clear, announce.
          await this.endSessionLocally("refresh-token-rejected", {
            expiredReason: "cleared-during-refresh",
            // `start` is the credential this operation loaded before taking
            // the lock: the last thing this page knows to have existed.
            known: start,
          });
          throw new SessionExpiredError();
        }
        const rotatedByPeer =
          latest.sessionVersion !== start.sessionVersion &&
          !isExpiring(latest.expiresAt, this.now(), this.buffer);
        if (rotatedByPeer) {
          // This branch RETURNS A TOKEN it read from storage, without any
          // network call - the shortest path there is from "an operation from a
          // dead session" to "the new session's credential in the caller's
          // hands". It is also the first thing that happens after the awaited
          // re-load, so it validates for that boundary too.
          // MUTATION ANCHOR: peer-rotation early return.
          this.assertLease(lease);
          return { token: latest, rotated: false };
        }
        // Re-check on the re-loaded token too: a peer may have swapped in a
        // non-refreshable one. (CookieStorage cannot preserve this flag -
        // it stores the raw JWT only - so the check is best-effort there.)
        if (latest.refreshable === false) {
          throw new AuthError(
            "Token is marked non-refreshable (refreshable=false); re-login " +
              "through the auth-code flow instead.",
          );
        }
        if (!force && !isExpiring(latest.expiresAt, this.now(), this.buffer)) {
          // Second credential-returning early exit: same rule.
          this.assertLease(lease);
          return { token: latest, rotated: false };
        }
        return this.postRefresh(latest, lease);
      },
      // In-page chain scoped by generation: a stranded refresh from a
      // session that is over must not gate the new session's first refresh.
      `${this.channelName}:refresh:${lease.generation}`,
    );
  }

  private async postRefresh(current: StoredToken, lease: SessionLease): Promise<RefreshOutcome> {
    // No `?? accessToken` fallback: an access-only token is NOT a refresh
    // credential. Only a real refreshToken, or an explicitly acknowledged
    // legacy single-token contract (CookieStorage), may be sent to /token.
    const credential = this.refreshCredentialOf(current);
    const body = new URLSearchParams({ "refresh-token": credential });
    const tokenDest = this.bindDestination(`${this.base}/token`, "the refresh credential");
    // Reserved BEFORE the request that mints the next credential, and freed
    // again by the outer `finally` on every path that does not register one.
    const handle = this.reserveCredential("refresh()");
    try {
      return await this.postRefreshExchange(current, lease, handle, tokenDest, body);
    } finally {
      this.credentials.releaseReservation(handle);
    }
  }

  private async postRefreshExchange(
    current: StoredToken,
    lease: SessionLease,
    handle: CredentialHandle,
    tokenDest: { href: string },
    body: URLSearchParams,
  ): Promise<RefreshOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      // Immediately before the credential leaves the page. Everything above -
      // binding the destination, deriving the credential - is synchronous, but
      // this method was reached through several awaits.
      this.assertLease(lease);
      res = await this.fetchImpl(tokenDest.href, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof NotAuthenticatedError) throw e; // session ended, not network
      this.emit({ type: "refresh-failed", kind: "transient_network" });
      throw new RefreshError("transient_network");
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const kind = classifyRefreshStatus(res.status);
      if (kind === "terminal_invalid_session") {
        // Strict rotation means the LOSER of a concurrent refresh also gets a
        // 401 - while the winner's freshly minted token is alive in shared
        // storage. Clearing unconditionally would destroy that winner's
        // session. Only clear when storage still holds the very credential
        // the server just rejected.
        let latest: StoredToken | null = null;
        try {
          const raw = await this.storage.load();
          // Canonicalize here too: comparing a storage-supplied sessionVersion
          // against a recomputed one would make every re-read look like a peer
          // rotation and skip the terminal clear.
          latest = raw ? canonicalizeStoredToken(raw, "storage") : null;
        } catch {
          latest = null;
        }
        // A NON-SUCCESS response is a session boundary too. This recovery path
        // reads storage and can RETURN what it finds; after a logout and a new
        // login what it finds is the new session's token.
        // MUTATION ANCHOR: refresh 401 branch validation.
        this.assertLease(lease);
        if (latest && latest.sessionVersion !== current.sessionVersion) {
          this.degraded = null;
          this.emit({
            type: "token-refreshed",
            token: summarizeToken(latest),
            source: "tab",
          });
          // A listener of the event emitted just above may have ended the
          // session.
          // MUTATION ANCHOR: refresh 401 branch post-emit validation.
          this.assertLease(lease);
          return { token: latest, rotated: false };
        }
        this.emit({ type: "refresh-failed", kind, status: res.status });
        // The old jti is gone forever (strict rotation). Never retry it. This
        // is a real SESSION TRANSITION, not an error return.
        // MUTATION ANCHOR: terminal transition invalidates the known credential.
        // The server rejected the REFRESH credential. With split tokens the
        // access token is a different, still-unexpired bearer that nothing has
        // invalidated, so clearing storage alone leaves it live: the rejected
        // credential must be handed to the transition for revocation.
        await this.endSessionLocally("refresh-token-rejected", { known: current });
        throw new SessionExpiredError();
      }
      this.emit({ type: "refresh-failed", kind, status: res.status });
      this.assertLease(lease);
      throw new RefreshError(kind, res.status);
    }

    const token = normalizeTokenResponse(await res.json(), this.now());
    // Register BEFORE the lease check. The server has already minted this
    // credential; if the session ended in the meantime it is an orphan that is
    // live server-side, and something has to invalidate it.
    this.credentials.register(handle, token);
    // The session may have ended while this response was in flight. Persisting
    // or returning it now would recreate the credential the user destroyed.
    if (!lease.valid() || this.credentials.wasCancelled(handle)) {
      await this.disownOrphanCredential(handle, token);
      this.assertLease(lease); // throws
    }
    this.noteTokenRisks(token);
    await this.persist(token, "refresh", lease);
    this.assertLease(lease);
    this.credentials.release(handle);
    this.crosstab?.post({
      type: "token-updated",
      sessionVersion: token.sessionVersion,
      exp: token.expiresAt,
    });
    this.emit({
      type: "token-refreshed",
      token: summarizeToken(token),
      source: "self",
    });
    // Application listeners run synchronously here and are free to call
    // logout(). Returning after that hands back a credential the user has
    // already destroyed - and `persist()` above put it in storage, which is
    // why the logout that the listener started is what has to win.
    // MUTATION ANCHOR: post-event lease validation.
    this.assertLease(lease);
    return { token, rotated: true };
  }

  /**
   * The single terminal session transition, used by every path that discovers
   * the session is over without the application asking for it: a `/token`
   * response that says the session is terminally invalid, and a refresh that
   * finds the credential gone while holding the lock.
   *
   * This is a session TRANSITION, not an error return: the generation must be
   * invalidated so operations already in flight cannot go on to return the very
   * credential the server just rejected, and a clear that fails must leave a
   * block behind rather than let the rejected credential stay readable.
   *
   * Order matches `logout()`'s, for the same reasons:
   *   1. block SYNCHRONOUSLY, before the first await
   *   2. invalidate every outstanding lease
   *   3. clear through the mutation queue, so no in-flight save can race it
   *   4. announce to peers with a correlated operation id
   *   5. emit only after the local state is safe
   *   6. release the block only if the clear actually succeeded
   */
  private async endSessionLocally(
    reason: SessionEndReason,
    options: { expiredReason?: string; known?: StoredToken | null } = {},
  ): Promise<void> {
    // MUTATION ANCHOR: terminal refresh generation invalidation.
    // Steps 1 and 2. Without them, an operation that started before this point
    // still holds a lease it believes is valid.
    const held = this.gate.blockLocal();
    this.gate.terminate();
    this.gate.beginPendingOp();
    const operationId = randomId().slice(0, 16);
    const startedAt = wallClockMs();
    this.degraded = null;
    let clearFailed = false;
    const invalidate: StoredToken[] = [];
    // MUTATION ANCHOR: terminal transition seeds the known credential.
    // "The server rejected the refresh credential" is not "the access token is
    // dead". In split-token deployments they are different values with
    // different lifetimes, so the rejected credential must be queued for
    // revocation rather than merely dropped.
    if (options.known) invalidate.push(options.known);
    const boundTo = options.known?.sessionVersion;
    if (this.storage.persistent) {
      this.crosstab?.post({
        type: "session-cleared",
        reason,
        operationId,
        startedAt,
        sessionVersion: boundTo,
      });
    }
    // try/finally around EVERYTHING that owns state: an unexpected throw from
    // revocation setup, an origin-policy fault or a listener would otherwise
    // strand the local block and the pending-op counter, leaving a client that
    // refuses every operation forever with nothing able to release it.
    try {
      try {
        await this.runStorageMutation(async () => {
          invalidate.push(...this.credentials.drainForInvalidation());
          await this.storage.clear(reason);
        });
      } catch {
        clearFailed = true;
      }
      // Every distinct access/refresh target of everything this page knows to
      // exist. Failures stay retained and keep the client fail-closed.
      if (invalidate.length && !this.acknowledgeNoRevocation) {
        try {
          await this.revokeWithOutcomes(invalidate);
        } catch {
          for (const t of invalidate) this.credentials.retain(t);
          this.syncPendingRevocationBlock();
        }
      } else if (this.acknowledgeNoRevocation) {
        for (const t of invalidate) this.credentials.forget(t);
        this.syncPendingRevocationBlock();
      }
      if (this.storage.persistent) {
        // Shared session is dead for every tab; memory tabs own their own.
        this.crosstab?.post({
          type: "logout",
          reason,
          operationId,
          startedAt,
          sessionVersion: boundTo,
        });
      }
      this.emit({
        type: "session-expired",
        reason: options.expiredReason ?? reason,
      });
    } finally {
      this.gate.endPendingOp();
      if (clearFailed) {
        // The credential the server just rejected is demonstrably still in this
        // browser: the clear that would have removed it failed. Reopening the
        // client here is what keeps that credential being served, so the block
        // is retained instead.
        // MUTATION ANCHOR: terminal clear-failure retention.
        this.retainTerminalFailureBlock();
      }
      this.gate.releaseLocal(held);
    }
  }

  /**
   * When THIS tab's current session was established, in wall-clock
   * milliseconds. `0` means "no session here".
   *
   * Used as the fallback binding for a lifecycle message that carries no
   * session fingerprint (tokenless BFF state): an operation that STARTED before
   * our session did cannot be about our session.
   *
   * Set ONLY by a completed `handleCallback()` - the one session transition
   * this client can verify locally. `load()`, `peek()`, subscription delivery,
   * a token pull, a refresh and first observation all leave it alone, so it
   * stays `0` in every mode with no browser-side login (`managed-bearer`,
   * `ambient`) and in any tab whose credential simply existed when it started.
   * `0` means "no trusted epoch", and lifecycle messages are then honoured
   * conservatively rather than measured against a value nothing wrote. See
   * `messageTargetsThisSession()`.
   */
  private sessionEstablishedAt = 0;

  /**
   * The fingerprint of the session this tab believes it is in.
   *
   * `adoptObservedSession()` is the ONLY writer of this field and of
   * `sessionEstablishedAt`. Direct assignment from anywhere else lets the two
   * fields disagree about which session this tab is in.
   */
  private currentSessionVersion: string | null = null;

  /**
   * Adopt the session state implied by a credential this tab has ACTUALLY
   * OBSERVED, or `null` for "this tab holds no session".
   *
   * The caller must pass a canonicalized token - `canonicalizeStoredToken()`
   * recomputes `sessionVersion` from the access token, so a storage plugin or
   * a peer cannot choose what this tab believes its session to be.
   */
  private adoptObservedSession(
    token: StoredToken | null,
    options: { established?: boolean } = {},
  ): void {
    if (!token) {
      this.currentSessionVersion = null;
      this.sessionEstablishedAt = 0;
      return;
    }
    // MUTATION ANCHOR: observation is not establishment.
    // Observing a credential does not prove "this session is newer than your
    // logout". A tab that starts listening late, misses `session-cleared`, and
    // pulls a bearer from a backend session already being torn down would stamp
    // an epoch AFTER the logout began - and then ignore the terminal message,
    // keeping the token. The pull succeeded BECAUSE the session it belongs to
    // is the one being ended. Same for a preloaded per-tab credential: loading
    // it is not the moment it came into existence.
    //
    // Only an explicit, locally verifiable transition sets the epoch, and
    // `handleCallback()` completing is the only one this client has.
    if (options.established) {
      this.sessionEstablishedAt = wallClockMs();
    }
    this.currentSessionVersion = token.sessionVersion;
  }

  /** A brand-new session was established here (browser code flow). */
  private noteSessionEstablished(token: StoredToken | null): void {
    this.adoptObservedSession(token, { established: true });
  }

  /**
   * A credential the backend minted for a session that had already ended.
   *
   * Nothing in this page ever held it - the storage discarded it as stale - so
   * without this it would be live server-side with no record of its existence.
   * It goes into the registry to be revoked now if possible, and retried by a
   * later logout if not.
   */
  private adoptDiscardedMint(token: StoredToken): void {
    const handle = this.credentials.reserve("a late server-managed mint");
    this.credentials.register(handle, token);
    void this.disownOrphanCredential(handle, token).catch(() => {
      // disown already retains on failure; never an unhandled rejection.
    });
  }

  /** Fail-closed state for a terminal transition whose clear did not work. */
  private retainTerminalFailureBlock(): void {
    this.recoveryBlocks.add(this.gate.blockRetained());
    this.emit({
      type: "security-warning",
      code: "terminal-clear-failed-blocked",
      message:
        "The server rejected this session, but the credential could not be " +
        "removed from local storage, so it is still present in this browser. " +
        "Token reads and authenticated requests stay blocked; call logout() " +
        "to retry the removal.",
    });
  }

  /**
   * The value that may legitimately be POSTed to /token, or a thrown error.
   * Reusing the access token when none was issued would present a credential
   * the server never granted.
   */
  private refreshCredentialOf(token: StoredToken): string {
    // A non-empty refreshToken, or nothing. There is deliberately no
    // token-carried "legacy contract" flag: token data is untrusted input, and
    // a flag inside it let any storage self-authorize reusing its access token
    // as a refresh credential. CookieStorage's acknowledged single-token mode
    // already loads the same JWT into both fields, so it needs no bypass.
    if (token.refreshToken) return token.refreshToken;
    throw new AuthError(
      "Refusing to refresh: this token carries no refresh credential. An " +
        "access-only token is not a refresh token, and reusing it would " +
        "present a capability the server never granted. Re-login through the " +
        "auth-code flow, or use storage that declares the acknowledged legacy " +
        "single-token contract.",
    );
  }

  /** server-managed bearer-from-endpoint: the backend rotates; we re-pull. */
  private async serverManagedRefresh(lease: SessionLease): Promise<StoredToken> {
    const sm = this.serverManaged();
    this.assertLease(lease);
    if (sm?.healthUrl) {
      // Validated at construction, re-asserted here: it is a credentialed call.
      const dest = this.bindDestination(sm.healthUrl, "ambient session cookies");
      const headers = await this.serverManagedCsrfHeaders();
      // The CSRF provider is caller-supplied and may await a cookie refresh, a
      // network round trip or a user gesture. Sending a credentialed health
      // request after logout re-asserts the session we just destroyed.
      // MUTATION ANCHOR: server-managed post-CSRF validation.
      this.assertLease(lease);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        await this.fetchImpl(dest.href, {
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          headers,
          signal: controller.signal,
        });
      } catch {
        /* health ping is best-effort - but a CSRF/origin fault threw above */
      } finally {
        clearTimeout(timer);
      }
      this.assertLease(lease); // after the health response
    }
    // Routed through the same queue as every other mutation, so it cannot
    // interleave with a logout's snapshot-and-clear.
    await this.runStorageMutation(() => this.storage.clear("manual"));
    this.assertLease(lease);
    // MUTATION ANCHOR: server-managed mints enter the reservation lifecycle.
    // A tokenProvider or token endpoint is a credential-producing boundary
    // exactly like POST /token, so what it mints is tracked the same way.
    const handle = this.reserveCredential("refresh() (server-managed)");
    let token: StoredToken | null;
    try {
      token = await this.storage.load();
    } finally {
      this.credentials.releaseReservation(handle);
    }
    if (token) this.credentials.register(handle, token);
    // The token provider / token endpoint is another unbounded boundary, and
    // it MINTS a credential.
    if (token && (!lease.valid() || this.credentials.wasCancelled(handle))) {
      await this.disownOrphanCredential(handle, token);
    }
    this.assertLease(lease);
    this.credentials.release(handle);
    if (!token) {
      this.emit({ type: "refresh-failed", kind: "unknown" });
      throw new RefreshError(
        "unknown",
        undefined,
        "ServerManagedStorage could not obtain a token from its endpoint; " +
          "run diagnose() to check tokenEndpoint/healthUrl reachability.",
      );
    }
    this.noteTokenRisks(token);
    // Immediately before caching, emitting and returning.
    this.assertLease(lease);
    this.emit({
      type: "token-refreshed",
      token: summarizeToken(token),
      source: "self",
    });
    // Same re-entrancy rule as the broker path: listeners run synchronously.
    this.assertLease(lease);
    return token;
  }

  // ------------------------------------------------------------------
  // Request decoration
  // ------------------------------------------------------------------

  /**
   * Build a RequestInit carrying the credential for `input`.
   *
   * `input` is required: the resource-origin policy cannot be applied to a
   * request whose destination the library never sees.
   */
  async buildRequest(
    input: RequestInfo | URL,
    init: RequestInit = {},
    options: FetchAuthOptions = {},
  ): Promise<Request> {
    // Returns a Request, not a credentialed RequestInit: an init object can be
    // reused against ANY url, which would unbind the credential from the
    // destination that was validated.
    validateCallOptions(options, "buildRequest(options)", {
      booleans: ["requireAuth", "retryOn401"],
      enums: { refresh: REFRESH_MODES },
    });
    const lease = this.gate.lease();
    const bound = this.bindRequest(input, init);
    this.assertNotLoggingOut();
    if (this.isBff()) {
      const req = await this.bffRequest(bound.request);
      this.assertLease(lease);
      return req;
    }
    const token = await this.getToken({
      refresh: options.refresh ?? "auto",
      lease,
    } as GetTokenOptions);
    this.assertLease(lease);
    if (!token) {
      if (options.requireAuth ?? true) throw new NotAuthenticatedError();
      return bound.request;
    }
    return new Request(bound.request, this.authOverlay(bound.request, token));
  }

  /**
   * fetch with the lifecycle attached: load -> refresh-if-expiring -> Bearer ->
   * send -> at most ONE 401 retry, and only when the token is locally
   * expired/near-expiry or the server says `error="invalid_token"`.
   * Permission/audience 401s pass through untouched.
   *
   * The target origin must be allow-listed before any credential is attached.
   */
  async fetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
    options: FetchAuthOptions = {},
  ): Promise<Response> {
    validateCallOptions(options, "fetch(options)", {
      booleans: ["requireAuth", "retryOn401"],
      enums: { refresh: REFRESH_MODES },
    });
    // Snapshot destination AND request synchronously, before the first await.
    const lease = this.gate.lease();
    const bound = this.bindRequest(input, init);
    this.assertNotLoggingOut();
    // An explicit non-error redirect mode on a credentialed request is refused.
    if (init.redirect !== undefined) this.credentialedRedirectMode(init.redirect);
    const replay = () => (bound.replayable ? bound.request.clone() : null);

    if (this.isBff()) {
      const req = await this.bffRequest(bound.request);
      this.assertLease(lease); // the CSRF provider may have taken a while
      const bffRes = await this.fetchImpl(req);
      // A cookie-authenticated response that arrives after logout is still an
      // authenticated response; handing it to the application completes an
      // operation the user cancelled.
      this.assertLease(lease);
      return bffRes;
    }
    const refreshMode = options.refresh ?? "auto";
    let token = await this.getToken({ refresh: refreshMode, lease } as GetTokenOptions);
    this.assertLease(lease);
    if (!token) {
      if (options.requireAuth ?? true) throw new NotAuthenticatedError();
      return this.fetchImpl(bound.request.clone());
    }

    const first = replay() ?? bound.request;
    let res = await this.fetchImpl(new Request(first, this.authOverlay(first, token)));
    // The response to a credentialed request is itself protected data. If the
    // session ended while it was in flight, returning it completes an operation
    // the user cancelled - and, on a 401, starts the retry machinery below in a
    // session this operation never belonged to.
    // MUTATION ANCHOR: fetch response validation.
    this.assertLease(lease);
    if (res.status === 401 && (options.retryOn401 ?? true) && refreshMode !== "never") {
      const www = res.headers.get("WWW-Authenticate") ?? "";
      const eligible =
        isExpiring(token.expiresAt, this.now(), this.buffer) ||
        www.includes('error="invalid_token"');
      if (eligible) {
        // Deliberately NOT revalidated again here: nothing has been awaited
        // since the check above, so a second call would only shadow the control
        // that matters and make it unverifiable by mutation.
        try {
          // MUTATION ANCHOR: fetch retry lease propagation.
          // The retry stays inside the operation - and the session - that
          // started it. The PUBLIC refresh() captures a fresh lease, which
          // would let a request that began before a logout be retried with the
          // credentials of a login that happened afterwards.
          token = await this.forcedRefresh(lease);
        } catch (e) {
          if (e instanceof NotAuthenticatedError) throw e; // session ended
          return res; // terminal already emitted session-expired; surface the 401
        }
        const retryBody = replay();
        if (!retryBody) {
          // A one-shot stream cannot be replayed; surface the 401 rather than
          // silently sending an empty body.
          return res;
        }
        this.assertLease(lease); // before re-sending the credential
        res = await this.fetchImpl(new Request(retryBody, this.authOverlay(retryBody, token)));
        this.assertLease(lease); // after the retry response
      }
    }
    return res;
  }

  /**
   * Forced refresh INSIDE an existing operation.
   *
   * The public `refresh()` is a new public entry and therefore captures a new
   * lease; that is correct for an application call and wrong for a
   * continuation. Nothing internal may go through it.
   */
  private forcedRefresh(lease: SessionLease): Promise<StoredToken> {
    this.assertLease(lease);
    return this.refreshWithOutcome(true, lease).then((r) => {
      this.assertLease(lease);
      return r.token;
    });
  }

  // ------------------------------------------------------------------
  // Logout & userinfo
  // ------------------------------------------------------------------

  logoutUrl(postLogoutRedirectUri?: string): string {
    let canonical: string | undefined;
    if (postLogoutRedirectUri !== undefined) {
      // Same validation as logout(), and the canonical absolute value is what
      // gets sent.
      canonical = this.assertRedirectAllowed(
        postLogoutRedirectUri,
        this.allowedPostLogoutRedirectUris,
        "logoutUrl({ postLogoutRedirectUri })",
      );
    }
    const target = canonical ?? this.postLogoutRedirectUri;
    const qs = target ? `?${new URLSearchParams({ post_logout_redirect_uri: target })}` : "";
    return `${this.base}/logout${qs}`;
  }

  /**
   * Order matters: kill the backend session FIRST, because clearing locally
   * and then failing to reach the backend leaves a live server-side session
   * that the user believes they logged out of.
   */
  async logout(
    options: {
      localOnly?: boolean;
      postLogoutRedirectUri?: string;
    } = {},
  ): Promise<void> {
    validateCallOptions(options, "logout(options)", {
      booleans: ["localOnly"],
      strings: ["postLogoutRedirectUri"],
    });
    // Enter the blocked state SYNCHRONOUSLY, before the first storage read.
    // Anything else lets a concurrent getToken()/fetch() slip a credential out
    // while the logout is still resolving its first await.
    if (this.logoutInflight) return this.logoutInflight;
    // Take an OWN block synchronously - before the first storage read, and
    // released by nobody else.
    const held = this.gate.blockLocal();
    this.logoutInflight = this.runLogout(options)
      .then(
        (v) => {
          this.gate.terminate();
          // MUTATION ANCHOR: successful local recovery releases peer blocks.
          // A local logout that COMPLETES has resolved the exact condition
          // every fail-closed block here protects against - the credential is
          // gone and the server has confirmed it - so it releases them all.
          // Releasing only its own would leave a client that a peer had blocked
          // permanently unusable however many successful logouts it performs.
          this.resolveAllRecoveryBlocks();
          return v;
        },
        (e) => {
          this.gate.terminate();
          // MUTATION ANCHOR: retained failed-logout block.
          // The block must outlive this handler: releasing it regardless of
          // outcome turns "logout incomplete: the credential may still be
          // present" into a fully usable session one microtask later.
          // Every outcome that leaves a credential possibly alive - a local
          // clear that rejected, an unconfirmed backend logout, an unconfirmed
          // revocation - enters the retained state. A pre-flight validation
          // error (a disallowed postLogoutRedirectUri, a missing
          // logoutEndpoint) invalidated nothing and does not.
          if (e instanceof IncompleteLogoutError || e instanceof RevocationError) {
            this.retainLogoutFailureBlock();
          }
          throw e;
        },
      )
      .finally(() => {
        this.logoutInflight = null;
        // Runs AFTER the handlers above, so the retained block is already held
        // when the local block goes away.
        this.gate.releaseLocal(held);
      });
    return this.logoutInflight;
  }

  /** Enter (or stay in) the persistent `logout-failed-blocked` state. */
  private retainLogoutFailureBlock(): void {
    if (this.logoutFailedBlock === null) {
      this.logoutFailedBlock = this.gate.blockRetained();
    }
    this.emit({
      type: "security-warning",
      code: "logout-failed-blocked",
      message:
        "A logout could not confirm that the credential was invalidated, so " +
        "authenticated requests and token reads stay blocked in this tab. " +
        "Call logout() again; a logout that completes releases the block.",
    });
  }

  private releaseLogoutFailureBlock(): void {
    if (this.logoutFailedBlock === null) return;
    this.gate.release(this.logoutFailedBlock);
    this.logoutFailedBlock = null;
  }

  /**
   * A confirmed-complete local logout is the recovery operation for every
   * fail-closed state this client can be in: the credential is gone locally,
   * the outstanding invalidations were retried, and the peer operation that
   * was waiting for exactly this outcome is retired so its terminal message
   * cannot come back and clear a session established afterwards.
   */
  private resolveAllRecoveryBlocks(): void {
    this.releaseLogoutFailureBlock();
    for (const token of this.recoveryBlocks) this.gate.release(token);
    this.recoveryBlocks.clear();
    // Every peer-owned block, not just one: a completed local logout has
    // resolved the condition all of them are protecting against.
    for (const [key, op] of this.peerOperations) {
      this.gate.release(op.block);
      this.retiredPeerOperations.set(key, wallClockMs());
    }
    this.peerOperations.clear();
    this.retirePeerOperations();
    this.adoptObservedSession(null);
    // Pending revocations were just retried; only release if they SUCCEEDED.
    this.syncPendingRevocationBlock();
  }

  private async runLogout(options: {
    localOnly?: boolean;
    postLogoutRedirectUri?: string;
  }): Promise<void> {
    // Bounded opaque id correlating session-cleared with its terminal logout,
    // so a stale message from an older operation cannot release a newer block.
    const operationId = randomId().slice(0, 16);
    const startedAt = wallClockMs();
    if (options.postLogoutRedirectUri !== undefined) {
      this.assertRedirectAllowed(
        options.postLogoutRedirectUri,
        this.allowedPostLogoutRedirectUris,
        "logout({ postLogoutRedirectUri })",
      );
    }
    const sm = this.serverManaged();

    if (sm && !sm.logoutEndpoint && !this.acknowledgeNoBackendLogout) {
      throw new AuthError(
        "logout() in server-managed mode requires ServerManagedStorage." +
          "logoutEndpoint: the backend holds the real session, so clearing " +
          "only the client mirror would leave the user logged in while " +
          "telling them otherwise. Configure it, or set " +
          "security.acknowledgeNoBackendLogout to accept that gap (diagnose() " +
          "will stay non-OK).",
      );
    }

    // LOCAL FIRST. The credential is dropped and peers are told before any
    // network wait: a hanging backend must never leave this tab holding a
    // usable token. Completion is still gated on the network steps below.
    const degradedSnapshot = this.degraded;
    this.degraded = null;
    let clearFailed = false;
    // Collected inside the queued step so a clear that REJECTS still leaves us
    // holding everything we found - the credential is then demonstrably still
    // present, which is exactly when revocation matters most.
    const invalidate: StoredToken[] = [];
    if (degradedSnapshot) invalidate.push(degradedSnapshot);
    // MUTATION ANCHOR: logout binds to the credential it actually destroyed.
    // Derived from the ACTIVE token - the degraded mirror if one is live,
    // otherwise whatever the canonical snapshot below reads - and never from a
    // retained or candidate credential, which belong to operations that are
    // over. Reading `currentSessionVersion` instead would leave a tab that has
    // never called getToken() sending both lifecycle messages unbound, and
    // every peer that knows the session would have to refuse them.
    let activeToken: StoredToken | null = degradedSnapshot;
    try {
      // MUTATION ANCHOR: queued token snapshot.
      // Reading and clearing happen in ONE queued step, after every earlier
      // mutation, so nothing can be written in between and every credential
      // this page caused to exist is in the invalidation set. Reading before
      // entering the queue would miss a save still in flight - a token this
      // page just caused the server to mint - and a rotation landing between
      // the read and the clear would be destroyed locally while staying alive
      // server-side.
      await this.runStorageMutation(async () => {
        // In-flight candidates AND every credential an earlier attempt failed
        // to revoke. Without the latter a retry has nothing to retry with and
        // reports success without sending a single request.
        invalidate.push(...this.credentials.drainForInvalidation());
        if (sm) {
          // Never mint a credential in order to destroy one: read the cache.
          const cached = sm.peek ? sm.peek() : null;
          if (cached) {
            invalidate.push(cached);
            activeToken ??= cached;
          }
        } else {
          try {
            const raw = await this.storage.load();
            if (raw) {
              const active = canonicalizeStoredToken(raw, "storage");
              invalidate.push(active);
              // Canonicalized: the fingerprint is recomputed from the access
              // token, so a storage plugin cannot choose the binding.
              activeToken ??= active;
            }
          } catch {
            /* unreadable storage is still cleared below */
          }
        }
        await this.storage.clear("logout");
      });
    } catch {
      // A local clear that fails means the credential is STILL THERE. We must
      // not report success - but we still try to invalidate it server-side.
      clearFailed = true;
    }
    const endingSessionVersion =
      activeToken?.sessionVersion ?? this.currentSessionVersion ?? undefined;
    this.crosstab?.post({
      type: "session-cleared",
      reason: "user-logout",
      operationId,
      startedAt,
      sessionVersion: endingSessionVersion,
    });

    let backendLogoutError: unknown = null;
    if (sm?.logoutEndpoint) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        // Destination binding and the CSRF provider are INSIDE the try: a
        // failure in either is recorded, not thrown, so the independent
        // revocation step below still runs.
        const dest = this.bindDestination(sm.logoutEndpoint, "ambient session cookies");
        const headers = {
          Accept: "application/json",
          ...(await this.serverManagedCsrfHeaders()),
        };
        const res = await this.fetchImpl(dest.href, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          headers,
          signal: controller.signal,
        });
        if (!res.ok) {
          backendLogoutError = new IncompleteLogoutError(
            `Backend logout endpoint returned ${res.status}: the server-side ` +
              "session may still be alive.",
          );
        }
      } catch (e) {
        // A CSRF/origin/setup failure is RECORDED, not thrown: revocation is
        // an independent invalidation step and must still be attempted.
        if (e instanceof AuthError) {
          backendLogoutError = new IncompleteLogoutError(
            "Backend logout could not be attempted; the server-side session " +
              "may still be alive.",
          );
        } else {
          backendLogoutError = new IncompleteLogoutError(
            "Backend logout endpoint could not be reached; the server-side " +
              "session may still be alive.",
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }

    // Independent of whether the local clear or the backend logout succeeded:
    // every safe invalidation step is attempted, for EVERY credential this
    // page caused to exist - not only the one storage happened to return.
    // Credentials whose revocation does not succeed stay in the registry, so
    // the NEXT logout retries them.
    let revocationError: RevocationError | null = null;
    if (invalidate.length && !this.acknowledgeNoRevocation) {
      const outcomes = await this.revokeWithOutcomes(invalidate);
      for (const o of outcomes) {
        if (o.error instanceof RevocationError && !revocationError) {
          revocationError = o.error;
        }
      }
    } else if (this.acknowledgeNoRevocation) {
      // The deployment has explicitly accepted that credentials are not
      // revoked; retaining references to them would block the client forever.
      for (const t of invalidate) this.credentials.forget(t);
      this.syncPendingRevocationBlock();
    }

    const failure = backendLogoutError ?? revocationError;
    if (clearFailed) {
      // Fixed, redacted: the storage's own error text is not ours to forward.
      throw new IncompleteLogoutError(
        "Logout incomplete: local credential storage could not be cleared, so " +
          "the credential may still be present in this browser. Server-side " +
          "invalidation was still attempted. Authenticated requests stay " +
          "blocked in this tab until a logout completes.",
      );
    }
    if (failure) throw failure;

    // Only now is the logout genuinely complete everywhere.
    this.crosstab?.post({
      type: "logout",
      reason: "user-logout",
      operationId,
      startedAt,
      sessionVersion: endingSessionVersion,
    });
    this.emit({ type: "logout", localOnly: !!options.localOnly });
    if (!options.localOnly) {
      this.navigate(this.logoutUrl(options.postLogoutRedirectUri));
    }
  }

  /**
   * Best-effort server-side revocation, but NOT best-effort reporting: a 500
   * or 401 here means the credential may still be usable, and a logout that
   * silently leaves a live refresh credential behind is the worst outcome.
   *
   * 404/405/501 ("not shipped yet") is still a failure: the credential stays
   * usable. `security.acknowledgeUnsupportedRevocation` downgrades it to a
   * warning for migration, and keeps `diagnose().ok === false`.
   */
  private async revoke(current: StoredToken): Promise<RevocationError | null> {
    return this.revokeAll([current]);
  }

  /**
   * Revoke every distinct credential, deduplicated by value, and REMEMBER the
   * ones that did not succeed.
   *
   * Per-target outcomes, not "the first error": with split tokens the refresh
   * credential can be torn down while the access token's revocation 500s, and
   * collapsing that into one error loses which value is still live. A
   * credential is forgotten only when every one of its targets was confirmed
   * invalid (or an explicit acknowledgement applies); otherwise it stays in the
   * registry so the next logout retries it.
   */
  private async revokeAll(tokens: readonly StoredToken[]): Promise<RevocationError | null> {
    const outcomes = await this.revokeWithOutcomes(tokens);
    let first: RevocationError | null = null;
    for (const o of outcomes) {
      if (o.error instanceof RevocationError && !first) first = o.error;
    }
    return first;
  }

  private async revokeWithOutcomes(tokens: readonly StoredToken[]): Promise<RevocationOutcome[]> {
    // Deduplicate by VALUE across every credential: the same JWT frequently
    // appears in several of them, and sending it twice is pure noise. A value
    // seen in both roles is revoked once, with the stronger hint.
    const targets = new Map<string, RevocationTarget>();
    for (const current of tokens) {
      for (const t of revocationTargetsOf(current)) {
        if (!t.token) continue;
        const existing = targets.get(t.token);
        if (existing && existing.hint === "refresh_token") continue;
        targets.set(t.token, t);
      }
    }
    // Attempt EVERY revocation even when an earlier one fails: stopping at the
    // first failure leaves the remaining credentials live for no reason.
    const outcomes: RevocationOutcome[] = [];
    const failedValues = new Set<string>();
    for (const target of targets.values()) {
      const error = await this.revokeOne(target.auth, target.token, target.hint);
      outcomes.push({ target, error });
      if (error) failedValues.add(target.token);
    }
    // A credential survives in the registry unless EVERY value it carries was
    // confirmed invalid. Half-revoked is not revoked.
    for (const current of tokens) {
      const values = revocationTargetsOf(current)
        .map((t) => t.token)
        .filter(Boolean);
      const anyFailed = values.some((v) => failedValues.has(v));
      if (anyFailed) this.credentials.retain(current);
      else this.credentials.forget(current);
    }
    this.syncPendingRevocationBlock();
    return outcomes;
  }

  /**
   * Fail closed exactly as long as a credential is known to be live and
   * unrevoked - and stop as soon as one finally is.
   */
  private syncPendingRevocationBlock(): void {
    if (this.credentials.hasPending()) {
      if (this.pendingRevocationBlock === null) {
        this.pendingRevocationBlock = this.gate.blockRetained();
      }
      return;
    }
    if (this.pendingRevocationBlock !== null) {
      this.gate.release(this.pendingRevocationBlock);
      this.pendingRevocationBlock = null;
    }
  }

  /**
   * Reserve capacity for a credential-producing operation BEFORE the request
   * that mints the credential is sent. Refusing to create one more credential
   * is safe; forgetting one that already exists is not.
   */
  private reserveCredential(what: string): CredentialHandle {
    return this.credentials.reserve(what);
  }

  /**
   * A credential was minted for a session that ended while the response was in
   * flight, and no logout is left to sweep it up. Revoke it here rather than
   * leaving it alive server-side.
   *
   * The revocation RESULT must be inspected, not just its exceptions: these
   * helpers RETURN their error rather than throwing, and a failed orphan
   * revocation that is discarded takes the only reference to a live credential
   * with it.
   */
  private async disownOrphanCredential(
    handle: CredentialHandle,
    token: StoredToken,
  ): Promise<void> {
    this.credentials.release(handle);
    if (this.acknowledgeNoRevocation) return;
    let outcome: RevocationOutcome[] = [];
    try {
      outcome = await this.revokeWithOutcomes([token]);
    } catch {
      // A thrown fault (origin policy) is as unconfirmed as a returned one.
      this.credentials.retain(token);
      this.syncPendingRevocationBlock();
      this.noteOrphanRetained();
      return;
    }
    // MUTATION ANCHOR: orphan revocation result inspected.
    if (outcome.some((o) => o.error !== null)) this.noteOrphanRetained();
  }

  private warnedOrphanRetained = false;
  private noteOrphanRetained(): void {
    if (this.warnedOrphanRetained) return;
    this.warnedOrphanRetained = true;
    this.emit({
      type: "security-warning",
      code: "pending-revocation-blocked",
      message:
        "A credential was issued for a session that had already ended and it " +
        "could not be revoked, so it remains valid server-side. This tab stays " +
        "fail-closed and has kept a reference to it; call logout() to retry " +
        "the invalidation.",
    });
  }

  private async revokeOne(
    current: StoredToken,
    token: string,
    hint: "refresh_token" | "access_token",
  ): Promise<RevocationError | null> {
    const url = `${this.base}/revoke`;
    this.assertOriginAllowed(url, "the credential being revoked");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `${current.tokenType} ${current.accessToken}`,
        },
        body: new URLSearchParams({
          token,
          token_type_hint: hint,
        }).toString(),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (res.ok) return null;
      if (res.status === 404 || res.status === 405 || res.status === 501) {
        // "Not implemented yet" still means the credential remains valid
        // server-side, so by default it fails the logout like any other
        // unsuccessful revocation.
        this.revocationUnsupported = true;
        this.emit({
          type: "revocation-failed",
          reasonCode: "unsupported",
          status: res.status,
        });
        if (this.acknowledgeUnsupportedRevocation) {
          this.warnUnsupportedRevocation();
          return null;
        }
        return new RevocationError("unsupported", res.status);
      }
      this.emit({
        type: "revocation-failed",
        reasonCode: "http-error",
        status: res.status,
      });
      return new RevocationError("http-error", res.status);
    } catch (e) {
      if (e instanceof AuthError) throw e; // origin policy fault, not network
      this.emit({ type: "revocation-failed", reasonCode: "network-error" });
      return new RevocationError("network-error");
    } finally {
      clearTimeout(timer);
    }
  }

  async userinfo<T = Record<string, unknown>>(): Promise<T> {
    const endpoint = this.userinfoEndpoint ?? `${this.base}/userinfo`;
    if (this.isBff() && !this.userinfoEndpoint) {
      throw new AuthError(
        "userinfo() in bff transport requires config.userinfoEndpoint: " +
          `${this.base}/userinfo expects a Bearer token, which bff never ` +
          "attaches. Point userinfoEndpoint at your backend's " +
          "session-userinfo route.",
      );
    }
    const res = await this.fetch(endpoint, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new AuthError(`userinfo failed with ${res.status}.`);
    return (await res.json()) as T;
  }

  // ------------------------------------------------------------------
  // diagnose()
  // ------------------------------------------------------------------

  /**
   * One structured startup report instead of mysterious 401s an hour later.
   * Non-fatal by design: topology-blind means report, don't refuse. Only
   * checks with severity "error" (the default) can fail the report - a
   * passthrough-mode server missing broker JWKS is information, not a fault.
   */
  async diagnose(): Promise<DiagnoseReport> {
    const checks: DiagnoseCheck[] = [];
    checks.push({
      name: "config",
      ok: true,
      detail: `authBaseUrl=${this.base} redirectUri=${this.redirectUri} storage=${this.storageKey()}`,
    });
    checks.push({
      name: "resource-origins",
      ok: true,
      severity: "info",
      detail: `Authorization header allowed for: ${this.allowedResourceOrigins.join(", ")}`,
      hint: "Extend with security.allowedResourceOrigins if your API lives elsewhere.",
    });

    try {
      const res = await this.fetchImpl(`${this.base}/.well-known/jwks.json`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      checks.push({
        name: "broker-jwks",
        ok: res.ok,
        // Absence means passthrough mode, which is a legitimate deployment.
        severity: "warn",
        detail: `GET /.well-known/jwks.json -> ${res.status}`,
        hint: res.ok
          ? undefined
          : "Server may run passthrough mode (no broker JWKS) or authBaseUrl is wrong.",
      });
    } catch {
      checks.push({
        name: "broker-jwks",
        ok: false,
        severity: "warn",
        detail: "network error",
        hint: "Is the API reachable from this origin? Check CORS and authBaseUrl.",
      });
    }

    checks.push(await this.diagnoseStorage());

    if (this.degraded) {
      checks.push({
        name: "storage-degraded",
        ok: false,
        detail:
          "A rotated credential could not be persisted; this page is running " +
          "from an in-memory mirror.",
        hint: "The session will not survive a reload. See the storage-write-failed event.",
      });
    }

    // Never call storage.load() here. For bearer-from-endpoint that contacts
    // (and MINTS from) the token endpoint, and for a custom TokenStorage it may
    // do anything at all. A diagnostic must not change authentication state.
    //
    // Precisely: diagnose() performs no CREDENTIAL-STORAGE and no
    // TOKEN-MINTING I/O. It is not I/O-free - it makes one unauthenticated
    // GET to /.well-known/jwks.json (see the broker-jwks check above), which
    // carries no credential and changes no state. Use probeConnectivity() for
    // the explicit credentialed check.
    const smPeek = this.serverManaged();
    const known: StoredToken | null = this.degraded ?? (smPeek?.peek ? smPeek.peek() : null);
    // Every acknowledged compatibility exception fails the report, with error
    // severity. An acknowledgement records that someone accepted the risk; it
    // never makes the deployment healthy.
    for (const ack of this.compatibilityAcknowledgements()) {
      checks.push({
        name: ack.name,
        ok: false,
        severity: "error",
        detail: ack.message,
        hint: "Remove the acknowledgement once the underlying gap is closed.",
      });
    }
    // MUTATION ANCHOR: recovery state fails diagnose.
    // A client sitting in a recovery state is not healthy, and saying so is
    // the only way an operator learns that a credential this page issued is
    // still live. Reads flags only; this check performs no I/O at all.
    if (this.gate.hasRetained() || this.credentials.hasPending()) {
      const reasons: string[] = [];
      if (this.logoutFailedBlock !== null) reasons.push("logout-failed");
      if (this.recoveryBlocks.size > 0) reasons.push("clear-failed");
      if (this.credentials.hasPending()) {
        reasons.push(`pending-revocations=${this.credentials.pendingCount()}`);
      }
      checks.push({
        name: "recovery-state",
        ok: false,
        severity: "error",
        detail:
          `This client is fail-closed pending recovery (${reasons.join(", ")}). ` +
          "Token reads and authenticated requests are refused.",
        hint:
          "A credential may still be present locally or valid server-side. " +
          "Call logout(); it retries every outstanding invalidation and " +
          "releases the state once they succeed.",
      });
    }
    if (this.revocationUnsupported) {
      checks.push({
        name: "revocation",
        ok: false,
        severity: "error",
        detail: "The server does not implement POST /revoke.",
        hint:
          "Logout cannot invalidate the credential server-side; a stolen token " +
          "stays valid until it expires.",
      });
    }

    if (known?.accessTokenIsRefreshCredential || this.observedRefreshCapableBearer) {
      checks.push({
        name: "refresh-capable-bearer",
        ok: false,
        severity: "warn",
        detail: "The server returned the same JWT as both access and refresh token.",
        hint:
          "Every API call therefore carries a refresh credential, so any log, " +
          "proxy or compromised resource server that sees it holds the session. " +
          "This can only be fixed server-side (py-oidc-auth split-token mode); " +
          "until then keep the API surface minimal and the token lifetime short.",
      });
    }

    const report: DiagnoseReport = {
      storageKind: this.storageKey(),
      checks,
      ok: checks.every((c) => c.ok || (c.severity ?? "error") !== "error"),
    };
    this.emit({ type: "diagnose", report });
    return report;
  }

  /**
   * EXPLICIT, network-touching connectivity check. Separate from diagnose()
   * precisely because it is credentialed and mutating-adjacent: it carries the
   * configured CSRF header, a timeout, no-store and redirect:"error", and its
   * destination is validated like any other credentialed call.
   */
  async probeConnectivity(): Promise<DiagnoseCheck> {
    this.assertNotLoggingOut();
    const sm = this.serverManaged();
    if (!sm?.healthUrl) {
      return {
        name: "connectivity",
        ok: true,
        severity: "info",
        detail: "no healthUrl configured; nothing to probe",
      };
    }
    const lease = this.gate.lease();
    const dest = this.bindDestination(sm.healthUrl, "ambient session cookies");
    const headers = await this.serverManagedCsrfHeaders();
    // The CSRF provider is caller code and may take arbitrarily long.
    this.assertLease(lease);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(dest.href, {
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers,
        signal: controller.signal,
      });
      const reachable = res.status < 500;
      return {
        name: "connectivity",
        ok: reachable,
        detail: `healthUrl -> ${res.status}${res.status === 401 ? " (reachable; backend session absent)" : ""}`,
      };
    } catch {
      return {
        name: "connectivity",
        ok: false,
        detail: "healthUrl -> network error",
        hint: "No backend answered this credentialed probe.",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async diagnoseStorage(): Promise<DiagnoseCheck> {
    const kind = this.storage.kind ?? "custom";
    if (kind === "memory") {
      return { name: "storage", ok: true, detail: "memory (per-tab)" };
    }
    if (kind === "cookie") {
      if (typeof document === "undefined") {
        return {
          name: "storage",
          ok: false,
          detail: "cookie storage without a document",
          hint: "CookieStorage needs a browser environment.",
        };
      }
      // Prefer the storage's own probe: it round-trips with the ACTUAL
      // attributes (path/SameSite/Secure), catching e.g. Secure-on-http.
      const ownProbe = (this.storage as { probe?: () => boolean }).probe;
      let ok: boolean;
      if (typeof ownProbe === "function") {
        ok = !!ownProbe.call(this.storage);
      } else {
        const probe = `__poa_probe_${Math.random().toString(36).slice(2)}`;
        document.cookie = `${probe}=1; Path=/; SameSite=Strict`;
        ok = document.cookie.includes(`${probe}=1`);
        document.cookie = `${probe}=; Path=/; Max-Age=0; SameSite=Strict`;
      }
      return {
        name: "storage",
        ok,
        detail: ok
          ? "cookie write/read round-trip ok (actual attributes)"
          : "cookie probe failed with the configured attributes",
        hint: ok
          ? undefined
          : "Cookies disabled, Secure on an http origin, or a Path that does not cover this page?",
      };
    }
    if (kind === "server-managed") {
      const s = this.serverManaged() ?? {};
      if (s.healthUrl) {
        // Deliberately NOT probed here: diagnose() is passive, and a health
        // request is credentialed. Use probeConnectivity() for an explicit
        // network check.
        return {
          name: "storage",
          ok: true,
          severity: "info",
          detail: `server-managed (${s.transport}) with healthUrl configured; not probed`,
          hint: "Call probeConnectivity() for an explicit, credentialed check.",
        };
      }
      if (s.hasTokenProvider) {
        return {
          name: "storage",
          ok: true,
          detail:
            "server-managed (bearer-from-endpoint) with a tokenProvider " +
            "callback; endpoint reachability not probeable",
        };
      }
      if (s.tokenEndpoint) {
        // Deliberately NOT probed: a request to the token endpoint mints a
        // credential, and diagnose() would then throw it away - burning a
        // rotation and writing a live token into logs for nothing.
        return {
          name: "storage",
          ok: true,
          severity: "info",
          detail: `server-managed (${s.transport}) with tokenEndpoint configured; not probed`,
          hint:
            "diagnose() will not call a token-minting endpoint. Configure " +
            "healthUrl for a probeable, side-effect-free liveness check.",
        };
      }
      return {
        name: "storage",
        ok: s.transport === "bff",
        detail: `server-managed (${s.transport ?? "?"}) with no endpoint configured`,
        hint:
          s.transport === "bff"
            ? "bff transport: ensure the backend proxies API calls with credentials."
            : "Configure tokenEndpoint, tokenProvider or healthUrl so the library can obtain tokens.",
      };
    }
    return {
      name: "storage",
      ok: true,
      detail: "custom storage - protections cannot be verified by the library",
    };
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Storage read that honours the degraded memory mirror. When a rotation
   * could not be persisted, the mirror holds the ONLY live credential - the
   * value still sitting in storage was invalidated server-side.
   */
  private async loadToken(): Promise<StoredToken | null> {
    if (this.degraded) {
      this.noteTokenRisks(this.degraded);
      this.adoptObservedSession(this.degraded);
      return this.degraded;
    }
    const raw = await this.storage.load();
    if (!raw) return null;
    // Storage is a trust boundary: a plugin could hand back a "Basic" token
    // type, a non-finite expiry, or a sessionVersion of its choosing.
    const token = canonicalizeStoredToken(raw, "storage");
    this.noteTokenRisks(token);
    // Remember the fingerprint (metadata, not the credential) so a peer's
    // session-bound lifecycle message can be matched against it.
    this.adoptObservedSession(token);
    return token;
  }

  /**
   * Serialize every storage mutation. Without this a save already in flight
   * and a logout clear interleave, whichever resolves last wins, and a logout
   * can be followed by a save that puts the credential straight back.
   */
  private runStorageMutation<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.storageMutation.then(fn, fn);
    this.storageMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async persist(
    token: StoredToken,
    phase: "refresh" | "callback",
    lease: SessionLease,
  ): Promise<void> {
    try {
      // Revalidate BEFORE taking the lock, and again after the awaited save:
      // the session can end at either boundary.
      this.assertLease(lease);
      await this.runStorageMutation(async () => {
        this.assertLease(lease);
        await this.storage.save(token);
        // If the session ended DURING the save, undo it rather than leave a
        // live credential behind a completed logout.
        if (!lease.valid()) {
          await this.storage.clear("logout");
          throw new NotAuthenticatedError(
            "The session ended while this token was being stored; it has been " +
              "cleared rather than left behind.",
          );
        }
      });
      this.degraded = null;
      this.adoptObservedSession(token);
    } catch (e) {
      // A SECURITY-POLICY rejection is not a capacity problem: converting it
      // into memory degradation would retain exactly the credential the
      // storage just refused. Only a genuine write failure degrades.
      if (e instanceof StorageContractError) throw e;
      // The server already deleted the old jti before minting this one, so
      // discarding it here would strand the session with no signal at all.
      // Keep it in memory, report it, and let the caller carry on with a
      // working (if non-persistent) session.
      // A storage error must not restore a degraded token after logout.
      if (!lease.valid()) throw e;
      this.degraded = token;
      // `e` is deliberately NOT inspected. A custom TokenStorage can throw an
      // error whose message embeds the token it failed to persist, and this
      // event goes straight to console and to whatever telemetry is attached.
      void e;
      this.emit({
        type: "storage-write-failed",
        phase,
        reasonCode: "storage-threw",
        token: summarizeToken(token),
        degradedToMemory: true,
      });
    }
  }

  private warnUnsupportedRevocation(): void {
    if (this.warnedUnsupportedRevocation) return;
    this.warnedUnsupportedRevocation = true;
    this.emit({
      type: "security-warning",
      code: "unsupported-revocation",
      message:
        "The server does not implement POST /revoke, and this deployment has " +
        "acknowledged that. Logging out cannot invalidate the credential " +
        "server-side; diagnose() stays non-OK until the endpoint ships.",
    });
  }

  /**
   * A new login may not begin while a LOCAL logout is still running: resetting
   * the gate would clear that logout's own block and let the page keep using
   * the credential the user asked to destroy.
   */
  private assertLoginAllowed(what: string): void {
    // MUTATION ANCHOR: pending lifecycle operations refuse login.
    // An UNSETTLED peer clear or terminal transition blocks a login too, not
    // just a local logout: the login resets the gate, dropping the block that
    // clear is holding, and the still-present credential becomes readable again
    // before anything has established whether it is gone.
    // MUTATION ANCHOR: login refused in every fail-closed state.
    // A RETAINED block also refuses. A fresh login is not a way out of it:
    // `handleCallback()` refuses at `assertNotLoggingOut()`, so the flow is
    // guaranteed to fail AFTER the user has been sent to the IDP and back.
    // The recovery path is a logout() that completes.
    if (this.gate.lifecycleBusy() || this.gate.blocked()) {
      throw new NotAuthenticatedError(
        `${what} is not available while this client is fail-closed: a ` +
          "session-ending operation is still running, or one did not confirm " +
          "that the credential was invalidated. A login started now would be " +
          "refused at the callback. Call logout() - it retries the outstanding " +
          "invalidations and releases the state when they succeed.",
      );
    }
  }

  /**
   * The browser-side authorization-code flow hands a token to JavaScript, which
   * is what server-managed topologies exist to prevent, so running it there is
   * a configuration error rather than a supported path.
   *
   * REQUIRED EXTERNAL CONTRACT: a server-managed deployment must complete the
   * OIDC flow on the backend and establish its own session cookie. This client
   * then obtains short-lived access tokens (bearer-from-endpoint) or sends
   * nothing at all (bff).
   */
  private assertBrowserCodeFlowAllowed(what: string): void {
    const sm = this.serverManaged();
    if (!sm) return;
    throw new AuthError(
      `${what} is not available in ${sm.transport} mode: the browser-side ` +
        "authorization-code flow would deliver a token to JavaScript, which " +
        "is exactly what this topology exists to prevent. Complete the login " +
        "on the backend and let it establish its session, then use " +
        "getToken()/fetch() here.",
    );
  }

  /**
   * Re-check after an awaited boundary and immediately before caching,
   * persisting, returning or sending a credential.
   */
  private assertLease(lease: SessionLease): void {
    lease.assertValid(() => {
      throw new NotAuthenticatedError(
        "The session ended while this operation was in flight; its result is " +
          "discarded rather than recreating the credential.",
      );
    });
  }

  /** No authenticated work may proceed once a logout has begun. */
  private assertNotLoggingOut(): void {
    if (this.gate.blocked()) {
      throw new NotAuthenticatedError(
        "A logout is in progress; authenticated requests are withheld until " + "it completes.",
      );
    }
  }

  private noteTokenRisks(token: StoredToken): void {
    this.noteRefreshCapableBearer(token);
    const sm = this.serverManaged();
    if (
      sm?.transport === "bearer-from-endpoint" &&
      (this.storage as { longLivedTokenObserved?: boolean }).longLivedTokenObserved &&
      !this.warnedLongLivedManagedToken &&
      this.warnReadable
    ) {
      this.warnedLongLivedManagedToken = true;
      this.emit({
        type: "security-warning",
        code: "long-lived-managed-token",
        message:
          "The bearer-from-endpoint backend is minting access tokens that " +
          "outlive the configured short-lifetime threshold. This mode's " +
          "containment depends on the browser holding only a brief credential.",
      });
    }
  }

  private noteRefreshCapableBearer(token: StoredToken): void {
    if (token.accessTokenIsRefreshCredential) {
      // Remembered so diagnose() can report it without re-reading storage.
      this.observedRefreshCapableBearer = true;
    }
    if (
      !token.accessTokenIsRefreshCredential ||
      this.warnedRefreshCapableBearer ||
      !this.warnReadable
    ) {
      return;
    }
    this.warnedRefreshCapableBearer = true;
    this.emit({
      type: "security-warning",
      code: "refresh-capable-bearer",
      message:
        "The server issued one JWT as both access and refresh token, so every " +
        "API request carries a credential that can mint new sessions. Only the " +
        "server can separate them (py-oidc-auth split-token mode); until then " +
        "the resource-origin allowlist is the client's main containment.",
    });
  }

  /**
   * Build an OWNED Request synchronously from (input, init), preserving every
   * Fetch property, and validate its absolute URL. Passing the caller's
   * `Request` straight through would drop method/headers/body/signal, and
   * re-deriving it later would race a mutated URL.
   */
  private bindRequest(
    input: RequestInfo | URL,
    init: RequestInit,
    what = "the Authorization header",
  ): { request: Request; dest: Destination; replayable: boolean } {
    const dest = this.bindDestination(input, what);
    // `new Request(input, init)` applies Fetch's own merge rules: init wins,
    // everything else (method, headers, body, signal, credentials, cache,
    // mode, integrity, referrer, ...) is inherited from a Request input.
    const base = new Request(input as RequestInfo, init);
    // Re-anchor to the validated absolute URL without losing anything else.
    const request = new Request(dest.href, base);
    // A stream body can be sent once. Anything else can be replayed for the
    // single 401 retry.
    const hadStreamBody =
      typeof input === "object" && input instanceof Request
        ? input.bodyUsed === false && init.body === undefined && input.body !== null
        : false;
    const replayable = !(init.body instanceof ReadableStream) && !hadStreamBody;
    return { request, dest, replayable };
  }

  /**
   * Snapshot + validate in one step, BEFORE any await. Returns the exact
   * absolute href that must be sent: passing the caller's original `URL`
   * object or relative string to fetch would let it change (mutation, or a
   * `<base>` element) between validation and the request.
   */
  private bindDestination(
    input: RequestInfo | URL,
    what = "the Authorization header",
  ): Destination {
    const dest = snapshotDestination(input);
    if (!dest) {
      throw new AuthError(
        "Could not resolve the request URL to an absolute origin (or it " +
          "contained a backslash or control character), so the credential " +
          "policy cannot be applied. Pass a clean absolute URL.",
      );
    }
    this.assertOriginAllowed(dest.url, what);
    return dest;
  }

  /**
   * The resource-origin policy. In broker mode the Authorization header IS the
   * refresh credential, so an unbounded `auth.fetch(url)` would turn one
   * URL-injection bug into full session compromise.
   */
  private assertOriginAllowed(input: RequestInfo | URL, what = "the Authorization header"): void {
    const url = input instanceof URL ? input : resolveRequestUrl(input);
    if (!url) {
      throw new AuthError(
        "Could not resolve the request URL to an absolute origin (or it " +
          "contained a backslash), so the credential policy cannot be " +
          "applied. Pass a clean absolute URL.",
      );
    }
    if (!isSecureTransport(url) && !this.allowInsecureTransport) {
      throw new AuthError(
        `Refusing to send the credential to ${url.origin} over plaintext http. ` +
          "The broker JWT is a refresh credential, so anyone on the path gets " +
          "the whole session. Use https, a loopback host, or set " +
          "security.allowInsecureTransport if you accept that risk.",
      );
    }
    if (!this.allowedResourceOrigins.includes(url.origin)) {
      throw new OriginNotAllowedError(url.origin, [...this.allowedResourceOrigins], what);
    }
  }

  /** Resolve + validate an exact-match redirect allowlist. */
  private buildRedirectAllowlist(
    values: string[],
    label: string,
    mustInclude: URL | null,
  ): string[] {
    const out = new Set<string>();
    for (const v of values) {
      const u = validateConfigUrl(v, `${label} entry`, {
        allowRelative: true,
        allowQuery: true,
        allowInsecure: this.allowInsecureTransport,
      });
      if (u) {
        out.add(normalizeForExactMatch(u));
        if (label.includes("allowedRedirectUris")) this.allowedRedirectUrls.push(u);
      }
    }
    if (mustInclude) {
      out.add(normalizeForExactMatch(mustInclude));
      if (
        label.includes("allowedRedirectUris") &&
        !this.allowedRedirectUrls.some((x) => x.href === mustInclude.href)
      ) {
        this.allowedRedirectUrls.push(mustInclude);
      }
    }
    return [...out];
  }

  /** Exact-match check for an outbound redirect target. */
  private assertRedirectAllowed(value: string, allowlist: string[], label: string): string {
    const u = validateConfigUrl(value, label, {
      allowRelative: true,
      allowQuery: true,
      allowInsecure: this.allowInsecureTransport,
    });
    // Unresolvable (SSR relative) cannot be matched; refuse rather than guess.
    if (!u || !allowlist.includes(normalizeForExactMatch(u))) {
      throw new RedirectNotAllowedError(value, allowlist, label);
    }
    return u.href;
  }

  /**
   * Is this URL one of our configured callback destinations?
   * Compares origin + path only: the authorization response supplies the query.
   */
  private isConfiguredCallback(u: URL): boolean {
    return this.allowedRedirectUrls.some((allowed) => callbackMatches(allowed, u));
  }

  /**
   * CSRF headers for a credentialed backend call.
   *
   * Deliberately does NOT catch: if a CSRF strategy is configured and cannot
   * produce a token, the request must not go out at all. Catching here turns
   * "the CSRF cookie is missing" into "send it credentialed and unprotected",
   * which is the precise state the configuration forbids.
   */
  private async serverManagedCsrfHeaders(): Promise<Record<string, string>> {
    const sm = this.serverManaged();
    if (!sm?.csrfHeaders) return {};
    return sm.csrfHeaders();
  }

  /**
   * Overlay BFF credentials onto the ALREADY-BOUND owned request, so method,
   * caller headers, body, signal, cache, mode, integrity and referrer all
   * survive. Rebuilding headers from `init.headers` would discard every header
   * a `Request` input carries.
   */
  private async bffRequest(request: Request): Promise<Request> {
    const headers = new Headers(request.headers);
    // The configured CSRF value is authoritative: a colliding caller header
    // must not be able to suppress or replace it.
    for (const [k, v] of Object.entries(await this.serverManagedCsrfHeaders())) {
      headers.set(k, v);
    }
    return new Request(request, {
      headers,
      credentials: "include",
      redirect: this.credentialedRedirectMode(request.redirect),
    });
  }

  /**
   * A new session has been established here, so every peer operation this tab
   * has finished tracking belongs to a session that is over. Their terminal
   * messages must no longer clear storage, terminate the gate or release a
   * block - all three would tear down the session that replaced them.
   *
   * Every tracked operation is retired individually: with a single slot, two
   * overlapping `session-cleared` messages overwrite each other, only the last
   * is retired, and the first one's terminal message then arrives and clears
   * the new session.
   */
  private retirePeerOperations(): void {
    this.peerEpoch += 1;
    for (const [key, op] of this.peerOperations) {
      // Only operations that have SETTLED are retired. One still deciding
      // whether the credential is gone keeps its block (and login is refused
      // while it runs), so there is nothing here to retire prematurely.
      if (op.settled) {
        this.retiredPeerOperations.set(key, wallClockMs());
        this.peerOperations.delete(key);
      }
    }
    this.pruneRetiredPeerOperations();
  }

  /**
   * Bounded by MESSAGE LIFETIME, not by count.
   *
   * A fixed-size FIFO drops the oldest entry as soon as a seventeenth arrives
   * - and a hostile same-origin script can post seventeen `session-cleared`
   * messages in a millisecond, evicting the one id that still matters. The
   * cross-tab layer already refuses messages older than its freshness bound,
   * so an id older than that bound can never be quoted at us again and is the
   * only thing safe to forget.
   */
  private pruneRetiredPeerOperations(): void {
    // Milliseconds: the same unit the entries are stamped in, and the same one
    // the message freshness bound is expressed in.
    const cutoff = wallClockMs() - MESSAGE_MAX_AGE;
    for (const [id, at] of this.retiredPeerOperations) {
      if (at < cutoff) this.retiredPeerOperations.delete(id);
    }
  }

  /**
   * Identity of a peer lifecycle operation.
   *
   * `(tabId, operationId)` - not the id alone. Ids are 64 bits of randomness
   * from another context; nothing stops two tabs (or one hostile script) from
   * presenting the same one, and collapsing them would let one operation
   * release another's block.
   */
  private peerKey(message: { tabId: string; operationId: string }): string {
    return `${message.tabId}\u0000${message.operationId}`;
  }

  private isRetiredPeerOperation(key: string): boolean {
    this.pruneRetiredPeerOperations();
    return this.retiredPeerOperations.has(key);
  }

  /**
   * MUTATION ANCHOR: lifecycle targeting is decided by topology.
   *
   * `sessionVersion` fingerprints an ACCESS TOKEN. Whether that identifies a
   * SESSION depends entirely on the storage topology:
   *
   *  - **shared-credential** - cookie or a persistent custom storage every tab
   *    reads. One credential, one session: an exact recomputed fingerprint IS
   *    the identity, and a mismatch really does mean "not about us".
   *  - **managed-bearer** - one backend session mints a different short-lived
   *    bearer per tab. Two tabs of the same session hold different
   *    fingerprints by design, so a mismatch is not evidence of anything and
   *    must never reject a same-channel logout.
   *  - **per-tab** - MemoryStorage: every tab owns its token outright. Same
   *    conclusion, more obviously.
   *  - **ambient** - BFF: there is no browser credential at all, so there is
   *    nothing to fingerprint.
   *
   * Where the fingerprint is not an identity, the only fact this client can
   * still trust is TIME: an operation that began before this tab's session was
   * established cannot be about it. That preserves the one protection that
   * matters - a demonstrably newer callback session is not destroyed by a
   * stale message - while letting a legitimate peer logout through.
   *
   * Deliberately NOT used to decide this: a peer-supplied fingerprint as a new
   * identity (it is unverified), any unsigned JWT claim such as `sid` (this
   * client never trusts token contents it has not had verified server-side),
   * and "any successful request means a new session" for BFF (an ordinary
   * response may belong to the very session a logout is already ending).
   */
  private messageTargetsThisSession(message: {
    sessionVersion?: string;
    startedAt: number;
  }): boolean {
    if (this.lifecycleIdentity === "shared-credential") {
      if (message.sessionVersion !== undefined) {
        // A fingerprint we can compare: it must match. If this tab has not
        // observed a session at all there is nothing to compare against, and
        // honouring a clear is the fail-closed choice.
        return (
          this.currentSessionVersion === null ||
          message.sessionVersion === this.currentSessionVersion
        );
      }
      // No fingerprint, in the one topology where the sender could have
      // supplied one. A message that names no session is not evidence about
      // the session we know we are in.
      if (this.currentSessionVersion !== null) return false;
      return this.startedAfterOurSession(message);
    }
    // managed-bearer / per-tab / ambient: the fingerprint is not a session
    // identity here (two tabs of one session hold different credentials, or
    // there is no credential at all), so it neither accepts nor rejects. The
    // only remaining question is whether this tab's session demonstrably began
    // AFTER the operation did.
    return this.startedAfterOurSession(message);
  }

  /**
   * MUTATION ANCHOR: protection for a demonstrably newer session.
   *
   * `sessionEstablishedAt === 0` means this tab has no TRUSTED establishment
   * epoch - it never completed a callback here. That is the normal state for
   * managed-bearer and BFF tabs, which have no browser-side login at all, and
   * for any tab whose credential simply existed when it started. Nothing can
   * be claimed to be "newer" then, so the message is honoured: conservatively
   * fail-closed, and in particular a terminal `logout` remains an effective
   * fallback for a tab that missed `session-cleared`.
   *
   * When the epoch IS trusted, an operation that began before it cannot be
   * about the session established since, and must not destroy it.
   */
  private startedAfterOurSession(message: { startedAt: number }): boolean {
    if (this.sessionEstablishedAt === 0) return true;
    return message.startedAt >= this.sessionEstablishedAt;
  }

  /**
   * Drop this tab's credential because a peer ended the session.
   *
   * MUTATION ANCHOR: managed-cache invalidation on a peer lifecycle message.
   * `clear()` is a storage-contract method; a server-managed storage ALSO
   * holds an in-memory cache and an in-flight pull, and a peer's logout has to
   * reach both - otherwise `peek()` keeps serving the bearer this tab minted
   * for a session that is over, and a pull already in flight repopulates it.
   * `ServerManagedStorage.clear()` does this itself; calling `invalidateCache()`
   * explicitly means a custom server-managed-like storage cannot satisfy the
   * contract while quietly keeping its cache.
   */
  private clearForTerminalLifecycle(): Promise<void> {
    return this.clearForPeerLifecycle();
  }

  private async clearForPeerLifecycle(): Promise<void> {
    (this.storage as { invalidateCache?: () => void }).invalidateCache?.();
    await this.storage.clear("logout");
  }

  /** Fixed, redacted report of a peer clear this tab could not honour. */
  private emitPeerClearFailure(scope: "peer" | "terminal"): void {
    this.emit({
      type: "security-warning",
      code: "peer-clear-failed-blocked",
      message:
        "A peer tab ended the session but this tab's storage refused to " +
        "clear the credential, so token reads and authenticated requests " +
        "stay blocked here. Logging in again does not release the block; " +
        "call logout() to retry the invalidation.",
    });
    // A DEDICATED event, never `storage-write-failed`: that one means "a
    // freshly rotated token could not be persisted and the session is running
    // from a memory mirror", which would tell operators the opposite of the
    // real state here - a clear failed and the client is fail-closed.
    this.emit({
      type: "session-clear-failed",
      scope,
      reasonCode: "storage-threw",
      blocked: true,
    });
  }

  private onCrossTab(message: CrossTabMessage): void {
    if (message.type === "session-cleared") {
      const key = this.peerKey(message);
      // MUTATION ANCHOR: retired peer-operation handling (session-cleared).
      if (this.isRetiredPeerOperation(key)) return;
      // Duplicates are idempotent: the same operation announced twice must not
      // take a second block that nothing will ever release.
      if (this.peerOperations.has(key)) return;
      // The SAME targeting decision as the terminal message. Checking only for
      // an explicit mismatch would let a versionless clear through on the
      // grounds that clearing is fail-closed - but a message from an operation
      // that demonstrably began before this session existed is not about this
      // session, and honouring it destroys a credential the user just obtained.
      // "Fail closed" is not a licence to do that.
      // MUTATION ANCHOR: stale session-cleared rejection.
      if (!this.messageTargetsThisSession(message)) return;
      const owned = this.gate.block();
      const epoch = this.peerEpoch;
      const op: PeerOperation = { block: owned, epoch, settled: false };
      this.peerOperations.set(key, op);
      this.degraded = null;
      // Until this settles nothing is known about the credential, so a login
      // must not be allowed to declare the situation resolved and drop the
      // block: beginLogin() must not be admitted mid-clear.
      // MUTATION ANCHOR: pending peer clear blocks login.
      this.gate.beginPendingOp();
      // Routed through the SAME queue as persistence and logout clearing, so a
      // peer clear cannot interleave with a save that is already in flight.
      void this.runStorageMutation(() => this.clearForPeerLifecycle())
        .then(() => {
          this.gate.endPendingOp();
          op.settled = true;
          // Both continuations verify the captured epoch before emitting,
          // retaining, terminating or releasing.
          if (epoch !== this.peerEpoch) return; // retired; a newer session owns us
          this.adoptObservedSession(null);
          this.emit({ type: "session-cleared", reasonCode: message.reason });
        })
        .catch(() => {
          this.gate.endPendingOp();
          op.settled = true;
          if (epoch !== this.peerEpoch) return; // retired; not ours to block
          // Storage would not clear: the old token may still be readable, so
          // STAY blocked - and stay blocked THROUGH a later login.
          this.gate.retain(owned);
          this.recoveryBlocks.add(owned);
          this.emitPeerClearFailure("peer");
        });
      return;
    }
    if (message.type === "logout") {
      const key = this.peerKey(message);
      // MUTATION ANCHOR: retired peer-operation handling.
      // A terminal message from an operation a newer session has superseded
      // must do NOTHING: clearing storage or terminating the gate would destroy
      // a session established after that operation ended.
      if (this.isRetiredPeerOperation(key)) return;
      const tracked = this.peerOperations.get(key);
      // A terminal logout may arrive without the earlier session-cleared
      // (message loss, a tab that started late) - but then it has to prove it
      // is about the session we are actually in.
      if (!tracked && !this.messageTargetsThisSession(message)) return;
      const held = tracked?.block ?? this.gate.block();
      const epoch = tracked?.epoch ?? this.peerEpoch;
      this.peerOperations.delete(key);
      this.retiredPeerOperations.set(key, wallClockMs());
      this.degraded = null;
      this.gate.beginPendingOp();
      // MUTATION ANCHOR: the terminal message is a real invalidation.
      // For a tab that MISSED `session-cleared` this is the only chance to
      // drop the credential, so reaching here must actually clear storage.
      void this.runStorageMutation(() => this.clearForTerminalLifecycle())
        .then(() => {
          this.gate.endPendingOp();
          if (epoch !== this.peerEpoch) {
            // Retired mid-flight: release only our own block and leave the
            // newer session's generation and storage completely alone.
            this.gate.release(held);
            return;
          }
          this.adoptObservedSession(null);
          this.gate.terminate();
          this.emit({ type: "logout", localOnly: true });
          this.gate.release(held);
        })
        .catch(() => {
          this.gate.endPendingOp();
          if (epoch !== this.peerEpoch) {
            this.gate.release(held);
            return;
          }
          // Never release while the old token may still be readable.
          this.gate.retain(held);
          this.recoveryBlocks.add(held);
          this.emitPeerClearFailure("terminal");
        });
      return;
    }

    if (message.type === "token-updated") {
      if (this.gate.blocked()) return; // a dead session is not updated
      const sm = this.serverManaged();
      if (sm) {
        // NEVER mint from a peer's say-so: a forged message would otherwise
        // make us call the token provider/endpoint. Drop the cache; the next
        // genuine authenticated operation will fetch.
        (this.storage as { invalidateCache?: () => void }).invalidateCache?.();
        return;
      }
      if (!this.storage.persistent) return;
      // The lease is captured HERE, before the read - this is a continuation
      // of the session that was current when the message arrived, and
      // `storage.load()` is third-party code that can take arbitrarily long.
      const lease = this.gate.lease();
      // Read locally and emit ONLY when the fingerprint we compute matches the
      // one announced - a peer cannot make us report a token we did not see.
      void Promise.resolve()
        .then(() => this.storage.load())
        .then((raw) => {
          // Without a lease check here, a read that resolves after a logout and
          // a replacement login would announce the OLD session's token into the
          // new one - and, because the adoption below rebinds this tab, would
          // corrupt the new session's binding with it.
          // MUTATION ANCHOR: post-await lifecycle validation in token-updated.
          if (!lease.valid()) return;
          if (!raw) return;
          // Canonicalize before anything is believed: `sessionVersion` is
          // recomputed from the access token, so neither the storage plugin
          // nor the peer chooses what this tab thinks its session is.
          const token = canonicalizeStoredToken(raw, "storage");
          const summary = summarizeToken(token);
          if (summary.sessionVersion !== message.sessionVersion) return;
          if (!lease.valid()) return;
          // Verified and still current: this IS the session now. Emitting the
          // event while keeping the old fingerprint would make the peer's next
          // legitimate lifecycle message for this session look like a mismatch
          // and be refused - leaving this tab authenticated.
          // MUTATION ANCHOR: adoption of a verified token update.
          this.adoptObservedSession(token);
          this.emit({ type: "token-refreshed", token: summary, source: "tab" });
        })
        .catch(() => {
          /* a failing storage read must not become an unhandled rejection */
        });
    }
    // MemoryStorage ignores token-updated by design: tabs own their sessions.
  }

  /**
   * Overlay the credential onto an OWNED request without discarding anything
   * the caller set. `new Request(base, { headers })` REPLACES the header list,
   * so the merge has to start from the request's own headers.
   */
  private authOverlay(request: Request, token: StoredToken): RequestInit {
    const headers = new Headers(request.headers);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `${token.tokenType} ${token.accessToken}`);
    }
    return { headers, redirect: this.credentialedRedirectMode(request.redirect) };
  }

  /**
   * Pin the redirect policy of a credentialed request.
   *
   * Per the Fetch standard a cross-origin redirect strips `Authorization`, but
   * NOT custom headers such as an app's CSRF header - and it strips nothing on
   * a same-origin redirect chain that ends elsewhere. Following a redirect this
   * library has not validated risks replaying credentials at a destination that
   * was never allow-listed.
   */
  private credentialedRedirectMode(requested?: RequestRedirect): RequestRedirect {
    // "follow" is the Fetch default, so only an EXPLICIT non-error value from
    // the caller is a refusal; a plain Request carries "follow" by default.
    if (requested !== undefined && requested !== "error" && requested !== "follow") {
      throw new AuthError(
        `Refusing redirect mode ${JSON.stringify(requested)} on a request ` +
          "carrying credentials. A redirect this library has not validated may " +
          "replay cookies or a CSRF header at an origin outside " +
          "security.allowedResourceOrigins. Handle redirects yourself with " +
          'auth.getToken(), or keep redirect: "error".',
      );
    }
    return "error";
  }

  private scrubCallbackParams(u: URL, isCurrentLocation: boolean): void {
    if (!isCurrentLocation || typeof history === "undefined") return;
    for (const p of OIDC_RESPONSE_PARAMS) {
      u.searchParams.delete(p);
    }
    // Scrub protocol parameters out of the FRAGMENT too, preserving any
    // unrelated SPA hash (a router path, an anchor).
    const cleanedHash = scrubFragment(u.hash);
    const qs = u.searchParams.toString();
    history.replaceState(history.state, "", u.pathname + (qs ? `?${qs}` : "") + cleanedHash);
  }

  /**
   * RFC 9207 issuer validation. Exact string comparison, no normalization.
   */
  private assertIssuer(issValues: string[]): void {
    if (issValues.length > 1) throw new CallbackError("duplicate-parameter");
    const iss = issValues[0];
    if (this.expectedIssuer) {
      if (iss === undefined) {
        if (this.acknowledgeMissingIssuer) return;
        throw new CallbackError("issuer-missing");
      }
      if (iss !== this.expectedIssuer) {
        throw new CallbackError("issuer-mismatch");
      }
      return;
    }
    if (iss !== undefined) {
      throw new CallbackError("issuer-unexpected");
    }
  }

  private parseUrl(url?: string): URL | null {
    try {
      if (url) {
        return new URL(url, typeof location !== "undefined" ? location.href : undefined);
      }
      if (typeof location !== "undefined") return new URL(location.href);
      return null;
    } catch {
      return null;
    }
  }

  private isBff(): boolean {
    return this.serverManaged()?.transport === "bff";
  }

  private isServerManaged(): boolean {
    return this.storage.kind === "server-managed";
  }

  private serverManaged(): ServerManagedLike | null {
    return this.storage.kind === "server-managed"
      ? (this.storage as unknown as ServerManagedLike)
      : null;
  }

  private storageKey(): string {
    if (this.storage.kind === "cookie") {
      const name = (this.storage as { name?: string }).name;
      return `cookie:${name ?? "?"}`;
    }
    if (this.storage.kind === "server-managed") {
      const t = this.serverManaged()?.transport;
      return `server-managed:${t ?? "?"}`;
    }
    return this.storage.kind ?? "custom";
  }

  private nextKey(): string {
    return `${this.channelName}:next`;
  }

  private txnKey(): string {
    return `${this.channelName}:txn`;
  }

  private writeSession(key: string, value: string): void {
    if (typeof sessionStorage === "undefined") return;
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* sessionStorage unavailable (private mode, quota) */
    }
  }

  private removeSession(key: string): void {
    if (typeof sessionStorage === "undefined") return;
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  /** Read-and-delete the pending login transaction, if any. */
  private consumeLoginTransaction(): { id: string; at: number } | null {
    if (typeof sessionStorage === "undefined") return null;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(this.txnKey());
    } catch {
      return null;
    }
    this.removeSession(this.txnKey());
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { id?: unknown; at?: unknown };
      if (typeof parsed.id !== "string" || typeof parsed.at !== "number") {
        return null;
      }
      return { id: parsed.id, at: parsed.at };
    } catch {
      return null;
    }
  }

  private peekReturnPath(): string | null {
    if (typeof sessionStorage === "undefined") return null;
    try {
      // Re-validate identically on read: another same-origin script could
      // have written the slot. Only the canonical same-origin form is returned.
      return canonicalReturnPath(sessionStorage.getItem(this.nextKey()));
    } catch {
      return null;
    }
  }
}
