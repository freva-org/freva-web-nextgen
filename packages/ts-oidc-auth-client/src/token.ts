import { fingerprint, jwtExp, nowSeconds } from "./jwt.js";
import type { RefreshFailureKind, StoredToken, TokenSummary } from "./types.js";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    // Subclassing Error leaves `name` as "Error" unless set explicitly, and
    // callers do branch on it.
    this.name = "AuthError";
  }
}

export class NotAuthenticatedError extends AuthError {
  constructor(message = "Not authenticated: no token in storage.") {
    super(message);
    this.name = "NotAuthenticatedError";
  }
}

export class SessionExpiredError extends AuthError {
  constructor(message = "Session expired or rotated away; re-login required.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export class InvalidTokenResponseError extends AuthError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenResponseError";
  }
}

/**
 * A login callback arrived without a matching transaction started in this tab.
 * Either a login-CSRF attempt, a stale/replayed callback URL, or a genuinely
 * IDP-initiated flow (for which `security.requireLoginTransaction: false` is
 * the explicit opt-out).
 */
export class LoginTransactionError extends AuthError {
  constructor(message: string) {
    super(message);
    this.name = "LoginTransactionError";
  }
}

/**
 * A credentialed request needed a CSRF token and could not get one. Carries no
 * provider text: that message can embed the token it failed to read.
 */
export class CsrfUnavailableError extends AuthError {
  constructor(detail: string) {
    super(
      `Refusing to send a credentialed request without its CSRF header: ${detail}. ` +
        "Sending it anyway would enter exactly the unprotected state the CSRF " +
        "configuration exists to prevent.",
    );
    this.name = "CsrfUnavailableError";
  }
}

/** A storage mode's security contract was violated by the server response. */
export class StorageContractError extends AuthError {
  constructor(detail: string) {
    super(`Storage contract violated: ${detail}`);
    this.name = "StorageContractError";
  }
}

/** Server-side revocation did not succeed; the credential may still be live. */
export class RevocationError extends AuthError {
  readonly reasonCode: "http-error" | "network-error" | "unsupported";
  readonly status?: number;
  constructor(reasonCode: "http-error" | "network-error" | "unsupported", status?: number) {
    super(
      `Token revocation failed (${reasonCode}${status ? ` ${status}` : ""}). ` +
        "Local credentials were cleared, but the server-side session may " +
        "still be usable — do not report this as a complete logout.",
    );
    this.name = "RevocationError";
    this.reasonCode = reasonCode;
    this.status = status;
  }
}

export class RefreshError extends AuthError {
  readonly kind: RefreshFailureKind;
  readonly status?: number;
  constructor(kind: RefreshFailureKind, status?: number, message?: string) {
    super(message ?? `Token refresh failed (${kind}${status ? ` ${status}` : ""})`);
    this.name = "RefreshError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Map an HTTP status from POST /token to a failure class.
 * Only `terminal_invalid_session` may clear storage: py-oidc-auth's
 * broker_refresh signals a dead/rotated session exclusively with 401.
 * 400 means our request shape is wrong (config), not a dead session.
 */
export function classifyRefreshStatus(status: number): RefreshFailureKind {
  if (status === 401) return "terminal_invalid_session";
  if (status === 429 || status >= 500) return "transient_server";
  if (status === 400) return "cors_or_config";
  return "unknown";
}

/**
 * Strip every credential string AND every provider-controlled free-form value.
 * `scope` is an arbitrary server string and never reaches telemetry.
 * `sessionVersion` is recomputed here rather than trusted, so a storage plugin
 * cannot inject content into an event.
 */
export function summarizeToken(token: StoredToken): TokenSummary {
  return {
    tokenType: "Bearer",
    expiresAt: Number.isFinite(token.expiresAt) ? token.expiresAt : 0,
    refreshExpiresAt: Number.isFinite(token.refreshExpiresAt as number)
      ? token.refreshExpiresAt
      : undefined,
    refreshable: token.refreshable === false ? false : undefined,
    accessTokenIsRefreshCredential:
      token.accessTokenIsRefreshCredential === true ? true : undefined,
    sessionVersion: fingerprint(token.accessToken),
  };
}

/** Machine-readable classes for an authorization-response failure. */
export type CallbackFailureCode =
  | "provider-error"
  | "duplicate-parameter"
  | "mixed-response"
  | "unsupported-response-mode"
  | "issuer-mismatch"
  | "issuer-missing"
  | "issuer-unexpected"
  | "missing-code-or-state";

/**
 * A callback failure with a FIXED message. The provider controls `error` and
 * `error_description`, so neither is interpolated into a thrown message that
 * applications log.
 */
export class CallbackError extends AuthError {
  readonly code: CallbackFailureCode;
  constructor(code: CallbackFailureCode) {
    super(
      `Authorization response rejected (${code}). Details are deliberately ` +
        "omitted: the provider controls them and this message reaches logs.",
    );
    this.name = "CallbackError";
    this.code = code;
  }
}

/**
 * THE trust boundary for a credential. Everything that produces a StoredToken
 * — the token endpoint, a tokenProvider callback, a storage read — passes
 * through here before the value is used, so a provider or storage plugin
 * cannot inject an unsupported authorization scheme or a nonsense expiry.
 */
export function canonicalizeStoredToken(
  candidate: unknown,
  source: "token-endpoint" | "token-provider" | "storage",
): StoredToken {
  if (!candidate || typeof candidate !== "object") {
    throw new StorageContractError(`${source} produced a non-object token.`);
  }
  const t = candidate as Record<string, unknown>;
  if (typeof t.accessToken !== "string" || t.accessToken.length === 0) {
    throw new StorageContractError(`${source} produced no access token.`);
  }
  if (t.tokenType !== undefined) {
    if (typeof t.tokenType !== "string" || t.tokenType.toLowerCase() !== "bearer") {
      // Never send a provider- or storage-chosen scheme such as Basic.
      throw new StorageContractError(
        `${source} produced an unsupported token type; only Bearer is supported.`,
      );
    }
  }
  const refreshToken =
    typeof t.refreshToken === "string" && t.refreshToken.length > 0 ? t.refreshToken : undefined;
  if (t.refreshToken !== undefined && refreshToken === undefined) {
    throw new StorageContractError(`${source} produced an unusable refresh token.`);
  }
  const num = (v: unknown, label: string, required: boolean): number | undefined => {
    if (v === undefined) {
      if (required) throw new StorageContractError(`${source} produced no ${label}.`);
      return undefined;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new StorageContractError(`${source} produced a non-finite ${label}.`);
    }
    return v;
  };
  const expiresAt = num(t.expiresAt, "expiry", true) as number;
  const refreshExpiresAt = num(t.refreshExpiresAt, "refresh expiry", false);
  if (t.refreshable !== undefined && typeof t.refreshable !== "boolean") {
    throw new StorageContractError(`${source} produced a non-boolean refreshable flag.`);
  }
  if (
    t.accessTokenIsRefreshCredential !== undefined &&
    typeof t.accessTokenIsRefreshCredential !== "boolean"
  ) {
    throw new StorageContractError(
      `${source} produced a non-boolean accessTokenIsRefreshCredential flag.`,
    );
  }
  // Preserve an EXPLICIT true: deriving this only from token equality would
  // discard a provider's own declaration that its access token is
  // refresh-capable, and bearer-from-endpoint would then accept the very
  // credential it exists to exclude. `false` may never override equality
  // detection.
  const equalTokens = refreshToken !== undefined && refreshToken === t.accessToken;
  const refreshCapable =
    t.accessTokenIsRefreshCredential === true || equalTokens ? true : undefined;
  return {
    accessToken: t.accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresAt,
    refreshExpiresAt,
    scope: typeof t.scope === "string" ? t.scope : undefined,
    refreshable: t.refreshable === false ? false : undefined,
    accessTokenIsRefreshCredential: refreshCapable,
    // Never trusted from the source; always recomputed.
    sessionVersion: fingerprint(t.accessToken),
  };
}

interface TokenResponseLike {
  access_token?: unknown;
  token_type?: unknown;
  expires?: unknown;
  expires_at?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_expires?: unknown;
  refresh_expires_at?: unknown;
  refresh_expires_in?: unknown;
  scope?: unknown;
  refreshable?: unknown;
}

function canonicalTokenType(v: unknown): string {
  if (v === undefined || v === null) return "Bearer";
  if (typeof v !== "string" || v.toLowerCase() !== "bearer") {
    throw new InvalidTokenResponseError(
      "Unsupported token_type: this client only supports Bearer.",
    );
  }
  return "Bearer";
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}

/**
 * Normalize a py-oidc-auth token response into a StoredToken.
 * Canonical fields are `expires`/`refresh_expires` (epoch seconds, schema.Token);
 * `*_in` second-offsets and `*_at` aliases are accepted for robustness, then the
 * JWT's own `exp` claim, then a conservative now+180 (the server's own fallback).
 *
 * The raw response is deliberately NOT retained: it contains the credential in
 * full, and anything retained here rides along inside every emitted event.
 */
export function normalizeTokenResponse(json: unknown, now: number = nowSeconds()): StoredToken {
  const data = (json ?? {}) as TokenResponseLike;
  const accessToken = data.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new InvalidTokenResponseError("Token response missing access_token.");
  }
  const expiresIn = asNumber(data.expires_in);
  const expiresAt =
    asNumber(data.expires) ??
    asNumber(data.expires_at) ??
    (expiresIn !== undefined ? now + expiresIn : undefined) ??
    jwtExp(accessToken) ??
    now + 180;

  const refreshIn = asNumber(data.refresh_expires_in);
  const refreshExpiresAt =
    asNumber(data.refresh_expires) ??
    asNumber(data.refresh_expires_at) ??
    (refreshIn !== undefined ? now + refreshIn : undefined);

  const refreshToken =
    typeof data.refresh_token === "string" && data.refresh_token.length > 0
      ? data.refresh_token
      : undefined;

  const candidate = {
    accessToken,
    refreshToken,
    // Only Bearer is supported. Anything else would be attached to requests
    // as an unknown scheme, and the raw string would reach headers and logs.
    tokenType: canonicalTokenType(data.token_type),
    expiresAt,
    refreshExpiresAt,
    scope: typeof data.scope === "string" ? data.scope : undefined,
    // Passed through UNMODIFIED so the central validator rejects a malformed
    // value instead of quietly coercing it to undefined.
    refreshable: data.refreshable as boolean | undefined,
    // Broker mode returns one JWT in both fields: the Bearer we send to the
    // API is therefore itself a refresh credential.
    accessTokenIsRefreshCredential: refreshToken === accessToken || undefined,
  };
  // ONE validator for every source: the token endpoint gets exactly the checks
  // a provider or a storage read does, and sessionVersion is recomputed here
  // rather than trusted from the response.
  return canonicalizeStoredToken(candidate, "token-endpoint");
}
