export { PyOidcAuthClient } from "./client.js";
export { MemoryStorage } from "./storage/memory.js";
export {
  ServerManagedStorage,
  type ServerManagedOptions,
  type CsrfOptions,
} from "./storage/serverManaged.js";
// CookieStorage is NOT exported here: a JS-written cookie cannot be HttpOnly,
// and RFC 6265 attaches it to every matching same-origin request. It is a
// compatibility escape hatch, not a peer of the other storage modes.
// Import it from "@freva-org/ts-oidc-auth-client/unsafe-compat".
export {
  AuthError,
  NotAuthenticatedError,
  SessionExpiredError,
  InvalidTokenResponseError,
  CallbackError,
  CsrfUnavailableError,
  LoginTransactionError,
  RefreshError,
  RevocationError,
  StorageContractError,
  type CallbackFailureCode,
  classifyRefreshStatus,
  normalizeTokenResponse,
  summarizeToken,
} from "./token.js";
export {
  OriginNotAllowedError,
  RedirectNotAllowedError,
  isLoopbackHost,
  isSecureTransport,
  canonicalReturnPath,
} from "./url.js";
export { decodeJwtPayload, jwtExp, fnv1a, fingerprint, isExpired, isExpiring } from "./jwt.js";
export { deriveChannelName, parseCrossTabMessage, withCrossTabLock } from "./crosstab.js";
export type {
  AuthConfig,
  AuthEvent,
  ClearReason,
  CrossTabMessage,
  DiagnoseCheck,
  DiagnoseReport,
  DiagnoseSeverity,
  FetchAuthOptions,
  GetTokenOptions,
  LifecycleIdentity,
  LoginOptions,
  MaybePromise,
  RefreshFailureKind,
  SecurityOptions,
  SecurityWarningCode,
  StoredToken,
  TokenStorage,
  TokenSummary,
} from "./types.js";
