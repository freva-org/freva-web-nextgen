# py-oidc-auth TypeScript client - consolidated specification (v1)

Status: final after four external review rounds (rounds 3–4 reviewed the v0.1/v0.2
implementations; v1.0.0-rc.2 incorporates all outcomes incl. the final-pass scrub fix). This document supersedes the earlier
design-review prompts; implementers work from this file only.

## 1. Purpose and scope

A standalone, pure-TypeScript, zero-runtime-dependency, framework-agnostic browser client for
servers built on `py-oidc-auth` (e.g. freva-rest). It owns the **broker token lifecycle**:
login redirect, callback exchange, local expiry tracking, single-flight refresh with rotation
awareness, request decoration, logout, userinfo, and startup diagnostics. Where the credential
_rests_ between requests is delegated to a pluggable `TokenStorage`.

Out of scope for v1 (decided, ranked): device flow (v1.x, never CookieStorage - 30-day JWTs),
RFC 8693 token-exchange API (after server `refreshable` semantics), SPA-held PKCE (needs
server `code_challenge` passthrough), DPoP, memory-mode cross-tab token sharing,
`SameSite=None` cross-origin httpOnly refresh, cookie `Domain` escape hatches.

## 2. Server contract (verified against py-oidc-auth source)

Base: `{authBaseUrl}` e.g. `/api/freva-nextgen/auth/v2`.

| Route                                      | Notes                                                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /login?redirect_uri=...`              | 302 to IDP authorize. Server generates PKCE; `state = "<rand>\|<redirect_uri>\|<code_verifier>"`.                                                                           |
| `GET /callback?code&state`                 | Server completes PKCE + confidential-client exchange; returns token JSON.                                                                                                   |
| `POST /token`                              | Form-encoded. Field name is **`refresh-token`** (hyphen). Broker refresh accepts **expired** JWTs (only `jti` needed) and **rotates**: old session deleted before new mint. |
| `GET /logout?post_logout_redirect_uri=...` | 30x to IDP end-session when advertised.                                                                                                                                     |
| `GET /userinfo`                            | Bearer.                                                                                                                                                                     |
| `GET /.well-known/jwks.json`               | Broker public key; presence implies broker mode.                                                                                                                            |
| `POST /revoke`                             | **Future** server PR; client calls best-effort, tolerates 404/405.                                                                                                          |

Token response (`py_oidc_auth.schema.Token`): `access_token`, `token_type`, `expires`
(epoch s), `refresh_token`, `refresh_expires` (epoch s), `scope`. In broker mode
`access_token === refresh_token` (one JWT, claims: `sub`, `preferred_username`, `email`,
`roles`, `jti`, `iss`, `aud`, `iat`, `exp`). Normalizer also accepts `expires_in` /
`refresh_expires_in` seconds, and a future `refreshable: false` field.

**Security consequence (load-bearing):** because refresh accepts expired JWTs, the stored JWT
is a refresh credential for as long as the server session + IDP refresh token live - not a
1-hour access token. Every storage decision below follows from this.

## 3. Architecture principle: topology-blind library

The library never knows or guesses the deployment topology. All storage modes are always
constructible and active, and `storage` is a **required** constructor parameter with no
default (an explicit deployment decision). Since rc.3 one mode - `CookieStorage` - is
exported from a separate `/unsafe-compat` entry point rather than the main barrel; it is
not pruned, feature-detected or disabled anywhere, it simply cannot be reached by an
import that does not say what it is (§11). Picking a mode whose environmental counterpart is
absent is a configuration error the library must surface legibly - via `diagnose()` and
structured `refresh-failed` / `security-warning` events - never a pruned menu.

### Readiness matrix (docs, not code)

| Topology                     | Cookie         | Memory | ServerManaged `bearer-from-endpoint`                                | ServerManaged `bff`                  |
| ---------------------------- | -------------- | ------ | ------------------------------------------------------------------- | ------------------------------------ |
| Same-site SPA, no backend    | ready          | ready  | ready once split-token server PR ships (freva-rest is the endpoint) | needs proxy tier                     |
| Cross-origin SPA, no backend | ready          | ready  | needs SameSite=None + credentialed CORS (ignored 12 mo)             | needs proxy tier                     |
| freva-web (Django)           | ready (compat) | ready  | ready today (Django endpoint / `healthUrl`)                         | possible; wrong for data-heavy paths |

Recommended ranking in docs: ServerManaged/BFF > Memory > Cookie (compatibility, elevated XSS
risk). MemoryStorage relocates persistence to the IDP's own httpOnly SSO cookie - reopen is a
top-level redirect bounce (visible flash, no password while IDP session lives), per tab.

## 4. TokenStorage interface (final, post-review-2)

```ts
interface TokenStorage {
  load(): MaybePromise<StoredToken | null>;
  save(t: StoredToken): MaybePromise<void>;
  clear(reason?: ClearReason): MaybePromise<void>;
  subscribe?(l: (t: StoredToken | null) => void): () => void;
  readonly kind?: "memory" | "cookie" | "server-managed" | "custom";
  readonly persistent?: boolean;
}
```

`exposesRefreshCredentialToJS` was **cut** (review round 2): unverifiable for custom storage.
Replaced by config-driven warnings: built-in CookieStorage triggers a `security-warning` event
unconditionally (suppress via `security.warnOnBrowserReadableRefresh = false`); custom
storage gets a generic warning.

Built-ins:

- **MemoryStorage** - per-tab closure variable; `persistent: false`. No token broadcasting.
- **CookieStorage** - value is the **raw JWT** (interoperable with freva-web's
  `getTokenFromCookie`). Host-only (no `Domain`, by construction), `Path=/`,
  `SameSite=Strict` default, `Secure` iff https, `Max-Age` aligned to JWT `exp`
  (`maxAgeFromTokenExp`, default true - bounds the persisted credential to the access
  lifetime; a closed browser past `exp` re-enters via SSO). `compatibilityMode:
"freva-web-single-token"` defaults the name to `freva_auth_token`. Broker-mode oriented;
  passthrough deployments get a size/semantics warning. Only the raw JWT survives a
  round-trip: token-response metadata that is not a JWT claim (e.g. `refreshable:
false`) is not preserved. `save()` validates the value against the RFC 6265
  cookie-octet set and throws rather than silently corrupting an opaque token.
  `probe()` performs a write/read/delete round-trip with the ACTUAL configured
  attributes, and is what `diagnose()` calls.
- **ServerManagedStorage** - two explicit transports (fixes the round-2 inconsistency):
  `{ transport: "bearer-from-endpoint", tokenEndpoint? | tokenProvider?, healthUrl? }` caches
  a short-lived access token in memory, fetched with `credentials: "include"`; the data path
  stays browser->API with Bearer. `{ transport: "bff", healthUrl? }` - `auth.fetch` attaches
  **no** Bearer, adds `credentials: "include"`, performs no client-side refresh.

The API call always carries an explicit `Authorization` header (except `bff`),
which keeps a CSRF-resistant explicit-Bearer surface. CORS nuance: `Authorization`
triggers preflight on cross-origin data calls (which the API must allow); only the
_auth_ endpoints - form-encoded `POST /token`, `GET /callback` - stay
preflight-free as simple requests.

**Correction (rc.3).** Earlier revisions of this section claimed "storage is
_storage_, never transport: cookies never ride to the API". That is **false on a
same-site deployment** and was the reasoning error behind CookieStorage's
placement. Per RFC 6265 §5.4 the user agent attaches a matching cookie to every
request to the host regardless of what this library does with headers. With the
default `Path=/`, a same-origin API call carries the refresh-capable JWT in a
`Cookie` header as well as the `Authorization` header, and so does every other
route on the origin, plus any proxy, middleware or CDN in front of it - into
their access logs. The claim only ever held when the API was cross-origin.
Consequence: CookieStorage moved to the `/unsafe-compat` entry point (see §11).

## 5. Lifecycle algorithms

**Login**: `loginUrl()` -> `{base}/login?redirect_uri=...` (+ `prompt`, `scope`,
`offline_access` when given; unknown params are ignored by FastAPI). `login({ next })` stashes
the return path in `sessionStorage` (non-secret) before `location.assign`.
Return paths are validated to same-origin relative form (no absolute URLs,
`//host`, or `/\` values) at write AND at read - a tampered slot yields null,
never a redirect target.

**Callback**: `isCallbackUrl()` ⇔ (`code` & `state`) **or** `error` present - error
redirects are callback URLs too, so the canonical `if (isCallbackUrl())
handleCallback()` pattern routes them into a structured `AuthError` carrying
`error_description`. `handleCallback()` extracts the params and **scrubs the address
bar immediately** - before any network or storage step can fail - removing only
`code`, `state`, `session_state`, `iss`, `error`, `error_description` via
`history.replaceState` while preserving route, other params and hash. Scrubbing
applies whenever the handled URL IS the current location - implicit or explicitly
passed (router integrations commonly hand over `location.href`); foreign URLs stay
non-scrubbing. Rationale:
`state` carries the PKCE verifier on current servers, so a callback URL left in
history after a failed exchange is the worse outcome (the authorization code is
single-use at the IDP anyway - refresh-to-retry was largely illusory). Only then
does it perform `GET {base}/callback?code&state` as an XHR (no app backend
required - this is the pure-SPA path), normalize and save. Never log callback URLs.

**userinfo()**: defaults to `{base}/userinfo` with Bearer; in bff transport this
default is guaranteed-broken (bff attaches no Bearer), so `config.userinfoEndpoint`
is required there and points at the backend's session-userinfo route.

**Refresh** (the hard part; rotation makes losers 401):

1. Per-page single-flight: one in-flight promise shared by all callers.
2. Cross-tab lock: `navigator.locks` when available, else an in-page mutex (the
   BroadcastChannel/version-key layer covers the rest).
3. Under the lock, **re-load from storage first**: if another tab already rotated and the
   stored token differs and is not expiring -> return it, no network. `refreshable:
false` is honored on the re-loaded token as well (best-effort under CookieStorage,
   which round-trips only the raw JWT and cannot preserve token-response metadata).
4. `POST {base}/token` with `refresh-token=<stored JWT>` (timeout via AbortController,
   `refreshTimeoutMs`).
5. Classification (only the first kind clears storage):
   `401 -> terminal_invalid_session` (clear, emit `session-expired`, broadcast `logout` iff
   storage is persistent/shared - memory-mode tabs own independent sessions);
   `429/5xx -> transient_server`; network/abort -> `transient_network`;
   `400 -> cors_or_config`; else `unknown`. Never retry a terminal failure - the old `jti` is
   gone forever.
6. Success: normalize, `storage.save`, broadcast `token-updated` (sessionVersion + exp,
   **never the token**), emit `token-refreshed`.

Proactive trigger: `exp − now ≤ refreshBufferSeconds` (default 120) with
`clockSkewSeconds` (default 30) folded into expiry checks. On _transient_ failure with a
not-yet-expired token, proceed with the current token instead of failing the request.

**fetch wrapper**: load -> (refresh if expiring) -> attach Bearer (respect caller-set
`Authorization`) -> send. Retry on 401 **at most once** and only if the token is
expired/near-expiry locally **or** `WWW-Authenticate` contains `error="invalid_token"`;
permission/audience 401s pass through untouched. Server `WWW-Authenticate` emission is a
ship-when-convenient server PR; the expiry-gated heuristic is the accepted v1 behavior. Do
not depend on `detail` strings.

**Logout**: clear (reason `logout`), broadcast `logout`, optional best-effort
`POST {base}/revoke`, then top-level redirect to `{base}/logout?...` unless `localOnly`.

## 6. Cross-tab protocol

Channel name: `poa:<fnv1a(origin | authBaseUrl | channelNamespace | storage.kind/cookieName)>`

- namespacing prevents cross-talk between two apps (or admin vs public UI,
  `channelNamespace`) on one origin. Layers: BroadcastChannel -> `localStorage` **version key**
  fallback (`{type, sessionVersion, exp, at, nonce}` - metadata only). The fallback is
  exclusive, not additive: localStorage is written only when BroadcastChannel is
  unavailable, so peers never receive the same logout/token-updated twice
  (mixed-capability tabs cannot exist within one browser). **A JWT in localStorage
  is a bug by definition, in every mode.** Messages v1: `token-updated`, `logout`. `sessionVersion` is a 64-bit, dot-free
  fingerprint (two FNV-1a passes) - not a secret, but wide enough that the "did
  another tab rotate?" comparison does not produce false-same-token cases. Receivers:
  persistent storage reloads and emits `token-refreshed {source: "tab"}`; memory ignores
  `token-updated`; everyone honors `logout` locally without re-broadcasting.

## 7. diagnose()

One structured report at startup instead of mysterious 401s an hour in:
`{ storageKind, checks: [{name, ok, detail, hint?}], ok }`, also emitted as a
`diagnose` event. Checks: config sanity; broker JWKS reachability
(`GET {base}/.well-known/jwks.json` - also detects CORS/base-URL mistakes; non-OK ≠
fatal, hint "passthrough mode?"); storage probe (cookie: write/read/delete
round-trip **with the actual configured attributes** via `CookieStorage.probe()`,
so `Secure` on an http origin or a non-covering `Path` fails loudly; memory:
trivial; server-managed: ping `tokenEndpoint`/`healthUrl`, where a 401 counts as
_reachable_; a `tokenProvider`-backed setup is reported ok with a not-probeable
note). Non-fatal by design - topology-blind means report, don't refuse.

## 8. Server-side roadmap (py-oidc-auth PRs; client must not require 2–4)

1. **Refresh grace window** - mandatory before direct browser refresh whenever more
   than one context can hold the same refresh credential **and** the deployment
   cannot rely on `navigator.locks` to serialize them. That covers freva-web
   Phase 1 (two refresh authorities: Django middleware + the library) and pure-SPA
   CookieStorage multi-tab use in browsers without Web Locks (the in-page mutex
   fallback cannot serialize across tabs; BroadcastChannel publishes but cannot
   prevent a concurrent rotation, so the losing tab takes a terminal 401).
   MemoryStorage deployments are per-tab single-authority and do not gate on it.
   Semantics: keyed by old `jti`; return the **identical** cached outcome (including
   failures - never mint twice); TTL 5–10 s; small read limit; log repeated hits; no
   IP/UA binding.
2. **`refreshable: false` claim**, checked **before** session deletion - also fixes the
   latent destructive path where refreshing an exchange-minted JWT (empty stored refresh
   token) deletes the session then fails. Ship alongside #1 (same code area); not a client
   gate while v1 has no exchange API.
3. **`POST /revoke`** - signature-verified, `exp`-ignored, delete by `jti`; optional IDP
   revocation. Logout completeness, not correctness.
4. **`code_challenge` passthrough on `/login`** - enables SPA-held PKCE (v2); today the
   verifier rides inside `state` through the IDP redirect, mitigated by the confidential
   client secret.
5. Split access/refresh httpOnly mode - the same-site endgame; larger than this library.

## 9. freva-web migration gates (unchanged from round 2)

Phase 0 (now): library in CookieStorage compat mode; **Django stays sole refresh authority**;
fix offline popup `postMessage` to exact origin + nonce. Phase 1 (lib refreshes directly)
**only after** grace window is live, with Django middleware reduced/disabled for SPA paths.
Phase 2: retire `getTokenFromCookie` call sites via `auth.fetch`. Phase 3/4: split-token
httpOnly mode when server PR 5 lands.

## 10. v1 acceptance checklist

Required `storage`; explicit resource-origin allowlist; GET `/callback` + URL scrub
preserving route; login-transaction binding; per-page single-flight;
refresh-error classification with terminal-only clearing; expiry-gated single 401 retry;
Memory + Cookie + ServerManaged(both transports); no token in localStorage ever; cross-tab
logout + token-updated for persistent storage; `diagnose()`; events as typed union; zero
runtime deps; SSR-safe imports (feature-detect `window`/`document`/`BroadcastChannel`/
`navigator.locks`); tests for every behavior named in §5–§7.

## 11. rc.3 security tranche (post external review)

Two independent reviews (one recorded in this repo's history, one external) were
consolidated into a single pass. This section records what changed, and - more
importantly - which earlier "locked decisions" were overridden and why.

### Decisions overridden

1. **"Every storage mode is always exported" (was §3).** Overridden.
   `CookieStorage` now ships from `@freva-org/ts-oidc-auth-client/unsafe-compat`.
   The original decision rested on the §4 claim corrected above; once it is
   accepted that the cookie rides every same-origin request, CookieStorage is a
   compatibility escape hatch rather than a peer of the other modes. It remains
   fully supported and fully tested - only the import path signals what it is.
2. **"`auth.fetch` decorates whatever URL it is given."** Overridden. There is now
   a resource-origin allowlist (default: page origin + `authBaseUrl` origin) and
   `auth.fetch` throws `OriginNotAllowedError` for anything else. In broker mode
   the Bearer _is_ the refresh credential, so an unbounded fetch turns one
   URL-injection bug into full session compromise.
3. **Events carried the full `StoredToken` (plus `raw`).** Overridden. Events now
   carry a redacted `TokenSummary`; `StoredToken.raw` is gone. Anything that logs
   events verbatim - Sentry breadcrumbs, redux devtools - used to log the
   credential.

### What is NOT fixed here, and cannot be

The external review's lead finding - "the access token is also the refresh
credential" - is **correct and is not a client bug**. It is py-oidc-auth's broker
design, recorded in §2 as this document's load-bearing fact, and the fix is server
roadmap item 5 (split access/refresh). Removing the `refreshToken ?? accessToken`
fallback, as that review suggested, would simply break refresh, because the server
returns one JWT in both fields. What the client now does instead: detects
`access_token === refresh_token`, sets `StoredToken.accessTokenIsRefreshCredential`,
emits a `security-warning` with code `refresh-capable-bearer`, and reports it as a
`diagnose()` check. The split-token path is already wired for when the server PR
lands. **This remains a deployment-level blocker for a 1.0 production release, and
no amount of client-side work closes it.**

Likewise, binding the login transaction to the browser is only half-solvable
client-side: the server owns `state` (it carries the PKCE verifier), so the client
cannot bind to it. What the client can prove is that _this browsing context started
a login_, which is what the new transaction nonce does. Server roadmap item 4
(`code_challenge` passthrough) is still required for real PKCE.

### Changes

| Area               | Change                                                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resource origins   | `security.allowedResourceOrigins`; `auth.fetch`/`decorateRequest` throw `OriginNotAllowedError` off-allowlist. Plaintext http targets refused unless `security.allowInsecureTransport`.                                                                                            |
| `decorateRequest`  | Signature is now `(input, init?, options?)` - the policy cannot be applied to a request whose destination the library never sees.                                                                                                                                                  |
| Rotation race      | A terminal 401 re-reads storage and clears **only** if `sessionVersion` still matches the rejected credential; otherwise it adopts the peer's live token. Previously the loser of a concurrent rotation erased the winner's session.                                               |
| Failed persistence | `storage.save()` throwing after a successful rotation no longer discards the new credential silently. It is held in a per-page memory mirror, a `storage-write-failed` event fires (and `console.warn` if nothing is listening), `isStorageDegraded()` and `diagnose()` report it. |
| Single-flight      | A forced refresh never joins a non-forced one in flight; it chains. The 401-retry path forces precisely because the server rejected a token that looks locally fine.                                                                                                               |
| CookieStorage      | Moved to `/unsafe-compat`. 4096-byte size guard (browsers drop oversized cookies silently). `__Host-`/`__Secure-` prefix contracts enforced. Refuses non-loopback plaintext origins unless `allowInsecureTransport`. Cookie name/path validated.                                   |
| bff                | A CSRF strategy is mandatory (`csrf: { headerName, token }`) or must be explicitly waived with `acknowledgeNoCsrf`. The header rides every credentialed call.                                                                                                                      |
| Logout             | Optional `logoutEndpoint` (credentialed `POST`, CSRF header) runs **before** the IDP bounce; a failure is reported instead of redirecting as if it worked. `revoke` now defaults to true.                                                                                          |
| Token retrieval    | `ServerManagedStorage` uses `cache: "no-store"`, `redirect: "error"`, an abort timeout, and optional `POST`. `diagnose()` never calls a token-minting endpoint - configure `healthUrl` for a side-effect-free probe.                                                               |
| Login CSRF         | `login()` records a one-time transaction nonce; `handleCallback()` requires and consumes it (`security.requireLoginTransaction`, default true, TTL 600 s).                                                                                                                         |
| Events             | Redacted `TokenSummary`; `security-warning` replaced by `security-warning` with a machine-readable `code`; `StoredToken.raw` removed.                                                                                                                                              |
| Cross-tab          | Inbound messages are schema-validated and freshness-bounded (±5 min); malformed or replayed messages are ignored.                                                                                                                                                                  |
| Config             | Fails closed on non-http(s) or plaintext URLs, embedded credentials, stray query/fragment, and non-finite or negative timings.                                                                                                                                                     |
| diagnose           | Per-check `severity`; only `error` fails the report, so a passthrough server missing broker JWKS no longer reddens every report.                                                                                                                                                   |
| Housekeeping       | Package renamed to `@freva-org/ts-oidc-auth-client`; `RefreshFailureKind.clock_skew` (never produced) removed; `AuthError` subclasses now set `name`; dev-dependency advisory cleared.                                                                                             |

### Still open (tranche 2)

Deliberately not in this pass, so the security diff stays reviewable:
`refreshExpiresAt` is normalized but never consulted; IDP callback errors are still
message-strings rather than a structured error with `error`/`error_description`
(which `prompt=none` needs); there is no `autoRefresh: false` switch to enforce the
freva-web Phase 0 gate of "Django is the sole refresh authority"; `TokenStorage.subscribe`
is still dead surface; `logout()` broadcasts to per-tab MemoryStorage sessions while the
terminal-401 path deliberately does not (the two are inconsistent - pick one); and the
`Max-Age = exp` choice still logs a sleeping laptop out even though the JWT remains a
valid refresh credential.

## 12. rc.4 corrective round (second adversarial review)

rc.3's own fixes introduced or left open nine fail-open behaviours. All were
independently reproduced before being changed, and each has a regression test in
`tests/residual.test.ts` named after the behaviour that must not return.

| #   | Finding                                                                                                                                               | Fix                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `storage-write-failed.reason` copied the storage exception message into events and `console.warn`; a custom storage error embedding the JWT leaked it | Fixed `reasonCode` only; the exception object is never inspected                                                                                                                                                                                           |
| A2  | A throwing or empty CSRF provider was caught and replaced with `{}`, so the request still went out credentialed and unprotected                       | `CsrfUnavailableError` aborts before `fetch`; zero requests sent                                                                                                                                                                                           |
| A3  | Destination policy applied only to `auth.fetch`; an off-origin `logoutEndpoint` received the CSRF secret and session cookie                           | Origin + transport validated for `tokenEndpoint`, `healthUrl`, `logoutEndpoint`, `/callback`, `/token`, `/revoke`. NOTE: rc.4 claimed `redirect: "error"` on all credentialed calls; it was NOT applied to `auth.fetch` itself. Corrected in rc.5 (§13.4). |
| A4  | `"/\\attacker.example/auth"` passed the syntactic relative-URL test and resolved to `https://attacker.example`                                        | All checks run on the RESOLVED URL; backslash, protocol-relative and fragment forms rejected                                                                                                                                                               |
| A5  | `login({redirectUri})`, `loginUrl()` and `handleCallback(url)` accepted arbitrary destinations                                                        | Exact-match `allowedRedirectUris` / `allowedPostLogoutRedirectUris`; `handleCallback` must land on a configured callback; `isCallbackUrl` no longer matches app URLs carrying `?error=`                                                                    |
| A6  | Every `/revoke` response including 500/401 was treated as success                                                                                     | Response validated; `RevocationError`; 404/405 reported as `unsupported` and surfaced by `diagnose()`; timeout + `no-store` + `redirect: error`                                                                                                            |
| A7  | `bearer-from-endpoint` accepted a refresh-capable token, and never warned on the plain `getToken()` path                                              | `StorageContractError` unless `allowRefreshCapableToken`; lifetime threshold; warning fires on every read path                                                                                                                                             |
| A8  | Cookie `path` accepted `"/; Domain=example.test"` (attribute injection); split-token responses silently dropped the refresh token                     | Injection characters rejected; split pairs refused                                                                                                                                                                                                         |
| A9  | A chained forced refresh always rotated again, invalidating the first caller's token; `randomId()` fell back to `Math.random()`                       | Adopts a just-rotated result; requires `crypto.getRandomValues`                                                                                                                                                                                            |

**Correction to an rc.3 claim.** The login transaction marker was described as a
login-CSRF defense. It proves only that _some_ login began in this browsing
context - it is NOT state binding, because the server owns `state`. The wording
is corrected in `SecurityOptions.requireLoginTransaction`.

**Cross-tab serialization.** `BroadcastChannel` and the `localStorage` fallback
publish, they do not serialize. Only `navigator.locks` - or server-side
idempotency - actually prevents two tabs rotating at once.

## 13. rc.5 security-correctness pass

Six blockers found in rc.4 by independent review. Each was reproduced first,
then fixed fail-closed, then kept as a regression test in
`tests/logout-revocation-and-redirects.test.ts`.

1. **`logoutUrl()` bypassed the post-logout allowlist.** The public helper did
   no validation while `logout()` did. It now runs identical checks; no public
   helper is a way around `allowedPostLogoutRedirectUris`.
2. **BFF/server-managed could report a successful logout without contacting the
   backend**, leaving its cookie session live. A validated `logoutEndpoint` is
   now required in server-managed mode. `security.acknowledgeNoBackendLogout`
   is the only escape hatch, and it keeps `diagnose().ok === false`.
3. **Callback matching ignored configured query values**, so a redirect URI of
   `?tenant=a` was satisfied by `?tenant=EVIL`. Matching is now query-aware:
   every static parameter must match as a multiset of decoded values, and any
   additional parameter must be a recognized OIDC response parameter
   (`code`, `state`, `session_state`, `iss`, `error`, `error_description`,
   `error_uri`). Duplicate keys, encoding tricks and unexpected parameters are
   all rejected.
4. **Credentialed requests followed redirects.** `auth.fetch` set no redirect
   policy at all, contradicting rc.4's own §12 claim. Every request carrying a
   Bearer, cookies or a CSRF header is now pinned to `redirect: "error"`, and a
   caller asking for any other mode on a credentialed request is refused.
   Verified in real Chromium: a baseline follow-redirect fetch delivered
   `X-CSRFToken` to a cross-origin destination (`Authorization` was stripped by
   the browser, the custom header was not); `auth.fetch` sent nothing there.
5. **Unsupported revocation (404/405/501) reported a clean logout.** Any
   non-success revocation now fails the logout: no navigation, no completion
   event. `security.acknowledgeUnsupportedRevocation` downgrades it to a
   warning for migration and keeps `diagnose().ok === false`.
6. **`CookieStorage` manufactured refresh capability.** It accepted an
   access-only token and re-loaded it as a refresh credential. It now requires
   `acknowledgeBrokerSingleTokenContract`, and rejects access-only, split, and
   `refreshable: false` tokens.

**Event ordering.** `logout` is emitted, and the IDP bounce performed, only
after storage clearing, backend logout and revocation have all succeeded.
Previously the completion event fired first, telling the application the
session was gone while a live server-side credential remained.

**Compatibility acknowledgements.** Every escape hatch
(`acknowledgeNoBackendLogout`, `acknowledgeUnsupportedRevocation`,
`acknowledgeBrokerSingleTokenContract`, `acknowledgeNoCsrf`,
`allowRefreshCapableToken`, `allowInsecureTransport`) is explicitly named,
emits a redacted `security-warning`, and makes `diagnose()` non-OK. An
acknowledgement records that someone accepted a risk; it never marks the
deployment healthy.

**Corrected claims.** Cross-tab refresh is _published_ by BroadcastChannel /
localStorage, not serialized - only `navigator.locks` or server-side
idempotency serializes. CookieStorage is legacy compatibility storage, never
"ready". The login transaction marker proves this browser tab initiated a
login; it is not server-side state binding.

## 14. rc.6 security-contract pass

Eight residual findings from independent rc.5 review. Each was reproduced,
fixed fail-closed, then inverted into a permanent regression test in
`tests/security-opt-outs-and-revocation-coverage.test.ts`.

1. **`diagnose()` minted a token.** `diagnoseStorage()` avoided the token
   endpoint, but `diagnose()` then called `loadToken()`, which contacted it
   anyway. Diagnosis is now strictly passive: it reads only the degraded
   mirror, `ServerManagedStorage.peek()` (cache only, no I/O), and passive
   acknowledgement metadata. It never calls `storage.load()` - which for a
   custom storage could do anything at all.
2. **Cross-tab logout completion was premature.** The initiator broadcast
   `logout` before revocation finished, so a peer announced success even when
   the initiator went on to throw. There are now two messages: a metadata-only
   `session-cleared` (drop the credential now, emitted as a `session-cleared`
   event) and `logout` (genuinely complete), sent only after storage clearing,
   backend logout and revocation have all succeeded.
3. **`logout({revoke: false})` bypassed the policy.** The per-call option is
   removed from the public API. Skipping revocation now requires
   `security.acknowledgeNoRevocation`.
4. **The acknowledgement guarantee was false for three of six.** All are now
   collected in one place, announced unconditionally at construction, and each
   contributes a failed `error`-severity `diagnose()` check:
   `allowInsecureTransport`, `acknowledgeNoBackendLogout`,
   `acknowledgeUnsupportedRevocation`, `acknowledgeNoRevocation`,
   `acknowledgeBrokerSingleTokenContract`, `acknowledgeNoCsrf`,
   `allowRefreshCapableToken`. `warnOnBrowserReadableRefresh: false` mutes the
   storage-kind warning only - it cannot mute an acknowledgement.
5. **Access-only tokens were treated as refresh credentials.** The
   `refreshToken ?? accessToken` fallback is gone. Refresh requires a real
   `refreshToken`, or a token carrying `legacySingleTokenContract`, which only
   acknowledged CookieStorage sets.
6. **Split-token logout revoked only the access token.** Both credentials are
   now revoked with an RFC 7009 `token_type_hint`, refresh first; a failure on
   either fails the logout. Single-token broker mode still sends one request,
   hinted `refresh_token` for grant cleanup.
7. **Authorization-response parsing was permissive.** Duplicate `code`,
   `state`, `iss`, `error`, `error_description` or `error_uri` are rejected
   (RFC 6749 §3.1), as are mixed success/error responses. `iss` is validated by
   exact string comparison against `security.expectedIssuer` (RFC 9207 §2.4),
   and a response carrying `iss` with no expected issuer configured is rejected
   rather than ignored. Error responses require a login transaction too, and
   every recognized response parameter including `error_uri` is scrubbed.
8. **Browser evidence is reproducible.** `browser-tests/` resolves `dist`
   relative to itself, uses Playwright's own browser resolution, runs
   chromium/firefox/webkit (skipping cleanly when a browser is absent), and is
   wired to `npm run test:browser` and `prepublishOnly`. Playwright remains
   development-only and is not a package dependency.

## 15. rc.7 security completion

Ten residual findings from independent rc.6 review, each reproduced, fixed
fail-closed, and inverted into `tests/issuer-policy-and-opt-out-isolation.test.ts`.

1. **Cross-tab reasons became event content.** rc.6 introduced a free-form
   `session-cleared.reason` that was copied straight into an `AuthEvent` - a
   redaction regression against §12. Reasons are now a closed union
   (`SessionEndReason`), validated on arrival; unknown, oversized, non-string
   or absent values are dropped, and the event carries `reasonCode`.
2. **Routing and validation are now separate.** `isCallbackUrl()` returns true
   for any structurally registered callback carrying OIDC response parameters,
   _including_ duplicates, mixed success/error and a bad issuer - classifying
   those as "not a callback" made the router skip `handleCallback()`, leaving
   `code` and `state` in the URL. `handleCallback()` snapshots the response,
   scrubs every OIDC parameter, and only then validates. Unregistered routes
   are never scrubbed.
3. **Issuer policy is strict.** `security.expectedIssuer` is validated at
   construction (absolute https, no credentials/query/fragment). When set,
   exactly one `iss` is required and compared exactly; a legacy provider needs
   `security.acknowledgeMissingIssuer`.
4. **Token-controlled refresh authorization removed.** `legacySingleTokenContract`
   is gone from `StoredToken`: token data is untrusted input, and any storage
   could set it to have its access token used as a refresh credential.
   CookieStorage's acknowledged mode already loads one JWT into both fields.
5. **No token acquisition before policy checks.** Server-managed logout reads
   `peek()` only, never minting to log out; `fetch()` and `decorateRequest()`
   validate destination and transport before loading or refreshing anything.
6. **Every opt-out is surfaced.** `requireLoginTransaction: false` now requires
   `acknowledgeNoLoginTransaction`; CookieStorage exposes its insecure-transport
   acknowledgement as passive metadata; and `secure: false` on a refresh cookie
   outside loopback requires `acknowledgeInsecureCookie`. Acknowledgement tests
   are isolated - each asserts an exact warning code and exact failed check
   against a client with no other acknowledgement.
7. **Release gate repaired.** Playwright is a locked devDependency,
   `npm run browsers:install` installs all three engines, and
   `prepublishOnly` runs `test:browser:strict`, where a missing required
   browser is a failure rather than a skip.
8. **Minting hardened.** `POST` is the default; `GET` requires
   `acknowledgeUnsafeTokenEndpointMethod`; a cookie-authenticated token
   endpoint requires a CSRF strategy or `acknowledgeNoCsrf`.

Acknowledgement codes added: `insecure-cookie-transport`, `no-login-transaction`,
`missing-issuer`, `unsafe-token-endpoint-method`, `token-endpoint-without-csrf`.

## 16. rc.8 security tranche

Nineteen residual findings from independent rc.7 review; nine reproduced
directly and all corrections are held by regressions in
`tests/destination-binding-and-telemetry.test.ts`.

1. **Destination binding (critical).** Validation ran against one URL while the
   ORIGINAL input was sent later. A caller-owned `URL` mutated during token
   loading redirected the credential - reproduced: validated `api.test`, sent
   to `evil.example`. Separately, relative inputs were validated against
   `location.href` while Fetch resolves them against the document's API base
   URL, so a `<base>` element could move a validated request, login, callback
   exchange, token mint or health call.
   Fix: `snapshotDestination()` takes an immutable absolute href synchronously,
   before the first `await`; that exact href is what gets sent. Relative inputs
   resolve against `document.baseURI` (what the browser will use); configured
   endpoints canonicalize to absolute at construction against the ORIGIN, never
   a mutable document base. `allowedResourceOrigins` is frozen.
   `decorateRequest()` is replaced by `buildRequest()`, which returns a
   destination-bound `Request` - the old form handed back a credentialed
   `RequestInit` reusable against any URL.
2. **Return paths are canonicalized.** `"/<TAB>/evil.example/x"` passed the old
   string check and resolved cross-origin. Now: no controls, whitespace or
   backslashes; resolved once against the app origin; exact same-origin
   required; length-bounded; only canonical `pathname + search + hash` stored
   or returned; sessionStorage revalidated identically.
3. **Storage contracts fail closed.** `persist()` rethrows
   `StorageContractError` instead of retaining a rejected credential in memory;
   memory degradation is now only for a genuine write failure after rotation.
   CookieStorage's access-only, split-token, missing-contract and
   non-refreshable rejections are typed as contract failures, and the broker
   acknowledgement is required at CONSTRUCTION so no storage can exist whose
   every operation throws while `diagnose()` reports it present.
   `login()`, `loginUrl()` and `handleCallback()` now throw in every
   server-managed topology.
   **REQUIRED EXTERNAL CONTRACT:** a server-managed deployment must complete
   the OIDC flow on the backend and establish its own session; this client
   cannot make a browser-visible code exchange safe there.
4. **Telemetry contract restored.** `login-completed` carries `hasReturnPath`
   instead of the path; `TokenSummary` drops provider-controlled `scope`;
   `tokenType` is canonicalized to `Bearer` and anything else is rejected;
   `sessionVersion` is recomputed from the access token rather than trusted
   from storage; callback failures are a structured `CallbackError` with fixed
   codes and a fixed message, never the provider's `error_description`.
5. **Configuration is snapshotted and runtime-validated.** `ServerManagedOptions`
   is deep-copied and frozen - mutating the caller's object no longer changes
   the endpoint, method, CSRF or fetch implementation. Booleans must literally
   be booleans (`"false"` is rejected), transports and methods are closed
   enums, numbers are finite and bounded, CSRF header names are validated, and
   every interpolated cookie attribute is checked.
6. **Callback routing is complete.** Any response-shaped URL on an owned route
   is routed to the handler - code-only, state-only, duplicated, mixed, or
   carrying unknown extra keys - then snapshotted, scrubbed and validated.
   Unsupported front-channel response modes (`id_token`, `access_token`,
   `response`) are recognised, scrubbed and rejected. An unrelated path or a
   swapped required static parameter is still not ours and is never rewritten.
7. **Cross-tab confused deputy removed.** An inbound `token-updated` never
   calls a token provider or endpoint: server-managed storage invalidates its
   cache with no I/O, and local persistent storage emits only when the locally
   computed fingerprint exactly matches the announcement. All asynchronous
   storage failures are caught.
8. **Logout is locally immediate and bounded.** Local state is cleared and
   `session-cleared` published BEFORE any backend wait; authenticated requests
   are withheld while a logout is in progress; backend logout and health calls
   carry abort timeouts. Completion and navigation still happen only after
   backend logout and revocation succeed.

## 17. rc.9 security tranche

Eight of nine rc.8 residuals reproduced directly; all corrections are held by
`tests/config-coercion-and-request-integrity.test.ts` and enforced by a mutation gate.

1. **Runtime validation of every security-relevant value** (`src/validate.ts`).
   TypeScript types are erased, so `allowInsecureTransport: "false"` was a
   truthy string that ENABLED plaintext transport, and
   `acknowledgeNoRevocation: "false"` skipped revocation. Booleans must be real
   booleans; enums, numbers (with bounds), arrays, functions, storage shape and
   per-call option bags are all checked at runtime.
2. **The whole config is snapshotted.** `userinfoEndpoint`, `redirectUri` and
   `postLogoutRedirectUri` canonicalize to absolute at construction; the
   caller-owned config object is never read again. Mutating it afterwards
   changes nothing, and a relative endpoint cannot be moved by `<base href>`.
3. **Logout is an atomic state machine.** The blocked state is entered
   SYNCHRONOUSLY before the first storage read; concurrent calls coalesce onto
   one operation; `fetch`, `buildRequest`, `getToken`, `requireToken`,
   `refresh` and `handleCallback` are all blocked while it runs; peers block
   synchronously on `session-cleared` before their asynchronous clear; and a
   failed local `storage.clear()` now yields a fixed redacted failure with no
   `logout` event and no navigation - server-side invalidation is still
   attempted.
4. **`diagnose()` is genuinely non-mutating.** The health probe is gone from
   passive diagnosis (it was credentialed, carried no CSRF header and had no
   timeout). `probeConnectivity()` is the explicit opt-in, with destination
   validation, CSRF, timeout, `no-store` and `redirect: "error"`.
5. **Fetch `RequestInfo` semantics are preserved.** An owned `Request` is built
   synchronously from `(input, init)` - method, headers, body, signal,
   credentials, cache, mode and integrity all survive - then re-anchored to the
   validated absolute URL. Replayable bodies are pre-cloned for the single 401
   retry; a one-shot stream is never replayed, and the 401 is surfaced instead.
6. **Fragment responses are handled.** Implicit/hybrid responses carrying
   `access_token`/`id_token`/`code`/`state`/`error` in the fragment are routed,
   scrubbed from the address bar and history, and then rejected. Unrelated SPA
   hashes are preserved untouched.
7. **One central token validator** (`canonicalizeStoredToken`) guards the token
   endpoint, `tokenProvider` output and every storage read: non-empty access
   token, canonical Bearer scheme only (a provider can no longer cause a
   `Basic` Authorization header), finite expiries, consistent refresh metadata,
   and `sessionVersion` always recomputed.
8. **No control bytes in source or distribution.** A literal control-character
   class made `src/url.ts` and `dist/url.js` binary to git and to review tools.
   Rewritten with escaped notation; `npm run check:bytes` scans source,
   generated JS, declarations, JSON and docs on every release.

**Mutation gate** (`npm run check:mutations`): removing runtime boolean
validation, logout blocking, destination re-anchoring or fragment scrubbing
must make the corresponding test fail. All four mutations are killed.

## 18. rc.10 security closure

Eleven of thirteen rc.9 residuals reproduced directly; all held by
`tests/post-logout-arrivals.test.ts`.

1. **Logout is a real state machine** (`src/session.ts`). The single
   `loggingOut` boolean was shared between a local logout and an inbound peer
   `session-cleared`, so whichever finished first reopened the gate for the
   other. `SessionGate` gives each holder an independently owned block token
   plus a monotonic generation. Local logout, inbound `session-cleared` and a
   terminal `logout` arriving on its own all block SYNCHRONOUSLY; a peer block
   is released only on terminal completion, never when its own `clear()`
   resolves. `probeConnectivity()`, `getToken`, `refresh`, `fetch`,
   `buildRequest` and `handleCallback` are all gated, and each captures the
   generation and re-checks it before persisting, caching, returning or
   sending. `ServerManagedStorage.clear()` bumps an epoch so an in-flight pull
   cannot repopulate the cache afterwards. `token-updated` is ignored while
   blocked. `login()` resets the gate - the deliberate recovery path, safe
   because starting a login uses no credential.
2. **Security metadata survives canonicalization.** An explicit
   `accessTokenIsRefreshCredential: true` was converted to `undefined` when no
   `refreshToken` field was present, so bearer-from-endpoint accepted a
   credential its own provider had marked refresh-capable. `true` is now
   preserved, `false` cannot override equality detection, a non-boolean is
   rejected, and the token-endpoint path runs through the same validator rather
   than a parallel one.
3. **Fragment parsing is total and scrub-first.**
   `#access_token=SECRET&%ZZ` threw `URIError` out of `isCallbackUrl()`, so the
   router skipped the callback and the token stayed in the URL and history.
   Decoding now falls back to raw text; the routing predicate never throws.
4. **BFF preserves Request semantics.** Credentials and CSRF are overlaid onto
   the already-bound owned `Request` instead of rebuilding headers from
   `init.headers`, which discarded everything a `Request` input carried. The
   configured CSRF value is authoritative over a colliding caller header.
5. **All safe invalidation is attempted.** A failed refresh-token revocation no
   longer prevents the access-token attempt; the first failure is reported
   without emitting a completed logout or navigating.
6. **Login options are runtime-validated and redirects canonicalized.**
   `loginUrl()` and `login()` validate every `LoginOptions` field before any
   transaction, return path, navigation or request; the canonical absolute
   redirect that was validated is what gets sent. `loginUrl()` is documented as
   a pure builder that does NOT establish the login transaction -
   `beginLogin()` is the new operation for manual navigation.
7. **Gates.** `check:mutations` joins `prepublishOnly`; the byte scan covers
   `scripts/` and every reviewed config file; the retained
   `private readonly config` parameter property is gone.

## 19. rc.11 lifecycle model

The rc.10 defects shared one cause: session validity was checked around
network responses, but not at every asynchronous continuation. rc.11 replaces
the ad-hoc checks with one model.

1. **Operation-scoped session lease.** A `SessionLease` is captured ONCE at a
   public entry (`fetch`, `buildRequest`, `getToken`, `refresh`,
   `handleCallback`, `probeConnectivity`) and threaded through refresh,
   callback, persistence, BFF requests and token pulls. Nested methods never
   capture a fresh generation - that only ever proved a value against itself.
   Every await, on success, failure, fallback and cleanup branches alike,
   revalidates the ORIGINAL lease before returning, storing, caching, emitting
   or sending.
2. **Login cannot cancel a logout.** Local logout blocks are tracked
   separately; `login()` and `beginLogin()` refuse while one is held, and
   `reset()` never clears a locally owned block.
3. **Storage mutations are serialized.** One mutex covers persistence and
   logout clearing. If persistence owns it, logout waits and then clears the
   token that was written; if logout owns it, the later save finds an invalid
   lease and never reaches storage. The lease is revalidated before AND after
   the awaited `save()`, and a storage error cannot restore a degraded token
   after logout.
4. **Delayed dependencies revalidate** - CSRF providers, token providers,
   storage methods, health requests and response parsers all have the lease
   rechecked before the next request or credential operation.
5. **Refresh completion rules.** The stale-token fallback applies only while
   the original lease is valid; a session-invalidated error is never converted
   into it; a refresh from an older session cannot return a token to a newer
   one.
6. **Single-flight ownership is identity-checked** - a completed old pull only
   clears `inflight` when it still points at that same promise.
7. **Cross-tab correlation.** `session-cleared` and its terminal `logout`
   carry a bounded opaque `operationId`; a stale terminal message from an
   earlier operation is ignored, and a peer clear that rejects stays blocked
   and emits a fixed redacted failure.
8. **Independent invalidations.** A CSRF, origin or backend-logout failure is
   recorded rather than thrown, so revocation is still attempted for every
   applicable credential; failures aggregate without exposing response data.
9. **One token validator.** Every token response - endpoint, provider, storage
   read - goes through `canonicalizeStoredToken`; malformed capability
   metadata is rejected rather than coerced, and `sessionVersion` is always
   recomputed.
10. **Login option contract.** `next` is refused by the pure builder
    `loginUrl()` and accepted only by the transaction-establishing `login()`
    and `beginLogin()`.
11. **One request path.** The older `withAuthHeader` / `withBffCredentials`
    helpers are gone; `bindRequest` + `authOverlay` / `bffRequest` is the only
    construction path.

## 20. rc.12 lifecycle continuations

rc.11 introduced the lease but did not thread it through every nested
continuation. An independent review reproduced ten paths where the ORIGINAL
lease was lost: an operation belonging to a dead session could still return,
send or persist a credential - sometimes the _next_ session's credential.
rc.12 closes them at the level of the model rather than by adding checks.

1. **The original lease survives every nested path.** `serverManagedRefresh()`
   now receives it (it previously had none at all). `refreshInflight` entries
   record the generation they belong to, and a caller from another generation
   never joins one - request coalescing is only legitimate inside one session.
   The refresh path revalidates after the initial storage load, on entering the
   cross-tab lock, before each credential-returning early exit (peer rotation,
   already-fresh token), immediately before the `/token` request, after every
   response including non-success, and after the storage reads in the 401
   recovery branch.
2. **Request retries stay in the operation that started them.** `fetch()` no
   longer calls the public `refresh()`, which captured a _new_ lease and let a
   pre-logout request be retried with the credentials of a later login. An
   internal `forcedRefresh(lease)` carries the original. The lease is
   revalidated after the first response, before the retry and after the retry
   response, and an authenticated response that arrives after logout - bearer
   or cookie - is rejected rather than handed to the application.
3. **Server-managed refresh is covered end to end** - after the CSRF provider
   and before the health request, after the health response, after storage
   clearing, after the token provider/endpoint, and immediately before caching,
   emitting and returning.
4. **An incomplete logout is persistently fail-closed.** rc.11 released the
   local block in `finally` regardless of outcome, so "the credential may still
   be present" became a fully usable session a microtask later. A failed logout
   now takes a separately owned RETAINED block (`logout-failed-blocked`):
   authenticated requests and token reads stay refused, `login()` does not
   clear it, another `logout()` may be attempted, and only a logout that
   completes releases it. Pre-flight validation errors - a disallowed
   `postLogoutRedirectUri`, a missing `logoutEndpoint` - invalidate nothing and
   do not enter the state.
5. **Storage and revocation ordering.** Credential-producing operations
   register their candidate token the moment the server mints it, before any
   lease check. Logout waits for earlier storage mutations and then snapshots
   AND clears inside one queued step, so nothing can be written in between. The
   invalidation set is the union of that snapshot, the degraded in-memory
   mirror and every in-flight candidate; every distinct value is revoked, with
   identical values deduplicated and the stronger `token_type_hint` preferred.
   A credential minted for a session that ended while the response was in
   flight is revoked by the operation that minted it.
6. **Peer lifecycle recovery.** A peer clear that rejects now RETAINS its
   block, so `beginLogin()`/`login()` cannot expose the token the clear failed
   to remove. Establishing a new session retires the peer operation ids it
   supersedes; a retired terminal message no longer clears storage, terminates
   the gate or releases a block, and an in-flight peer handler that is retired
   mid-operation releases only its own block. Peer clearing is routed through
   the same storage-mutation queue as persistence and logout.
7. **Ten regressions, reproduced first.** Every case above was written as a
   failing test against untouched rc.11 before any fix; all ten reproduced.
   They are now permanent regressions in `tests/lease-propagation.test.ts`.
8. **Mutation gate: call sites, not the helper.** rc.11's single global
   `assertLease()` mutation proved only that _some_ lease check mattered
   somewhere. It is replaced by ten call-site mutations plus a peer-side
   counterpart, each pinned to the one test that ends the session at exactly
   that boundary. Redundant checks that shadowed a control were removed so the
   controls are individually observable; where a boundary genuinely needs two
   lines, the mutation removes both and says so.

## 21. rc.13 recovery state

rc.12's continuation fixes hold, but every fail-closed outcome was a one-shot
event rather than a state. An independent review reproduced nine adjacent
paths: a credential whose revocation failed was forgotten, so the retry had
nothing to retry; a block taken by one holder could not be resolved by
another; a `/token` response that declared the session terminally invalid
ended it everywhere except in the lifecycle model; and a callback refused for
lifecycle reasons was refused with `code` and `state` still in the address
bar. rc.13 makes recovery a single coordinated system.

1. **Pending-invalidation registry** (`src/recovery.ts`). Credentials are held
   in two populations: in-flight candidates (minted, not yet confirmed stored)
   and pending ones (revocation attempted, not confirmed). Both are included in
   every subsequent logout. An entry leaves only when its revocation succeeds
   or an explicit acknowledgement applies. Credentials are keyed by the
   access/refresh PAIR, never by access token alone - in split-token
   deployments two operations can share an access token while carrying
   different refresh credentials. Registration returns an opaque handle and the
   caller releases that exact handle. Nothing is ever evicted to satisfy a size
   limit: when the registry is full the next credential-producing operation is
   refused _before_ it asks the server for another credential.
2. **Per-target revocation outcomes.** `revokeWithOutcomes()` returns one
   result per RFC 7009 target rather than the first error. A credential is
   forgotten only when every value it carries was confirmed invalid; half
   revoked is not revoked.
3. **Orphan revocation failures are handled.** `revokeAll()` RETURNS its error
   rather than throwing, so rc.12's bare try/catch saw nothing: a failed orphan
   revocation silently discarded the only reference to a live credential. The
   result is now inspected; the credential is retained, the client enters a
   retained fail-closed state, a fixed redacted warning is emitted, and a later
   logout retries it.
4. **One terminal transition** (`endSessionLocally`). A `/token` response that
   declares the session terminally invalid - and a refresh that finds the
   credential gone while holding the lock - now block synchronously, invalidate
   the generation (so every earlier lease is void), clear through the mutation
   queue, announce with correlated cross-tab messages, emit only after the
   local state is safe, and release the block only if the clear succeeded. A
   clear that fails promotes to a retained fail-closed state.
5. **Resolvable recovery.** A local logout that COMPLETES has resolved the
   condition every fail-closed block exists for, so it releases them all -
   logout-failure, peer-clear-failure, terminal-clear-failure - retires the
   peer operation it resolved, and retries every outstanding invalidation.
   rc.12 released only its own block, leaving a client that a peer had blocked
   permanently unusable however many successful logouts it performed.
6. **Login admission.** Any _pending_ lifecycle operation - a local logout, a
   peer clear, a terminal transition - refuses `login()`/`beginLogin()`: until
   it settles, nothing has established whether the old credential is gone. A
   _retained_ block is a settled verdict and does not refuse the login, but
   also is not cleared by it, so the credential stays unreadable across it.
   Peer continuations verify their captured epoch on BOTH the success and the
   failure path before emitting, retaining, terminating or releasing, and peer
   clearing runs through the same mutation queue as persistence and logout.
   Operation retirement is bounded by the cross-tab MESSAGE LIFETIME rather
   than by a fixed count, so a burst of forged messages cannot evict the one id
   that still matters.
7. **Callbacks are scrubbed before lifecycle rejection.** On a configured
   callback route the order is: parse and snapshot the protocol parameters,
   scrub query and fragment, and only then apply topology, blocked-session,
   issuer, transaction and response validation. Unregistered routes are still
   never rewritten.
8. **Event listeners are re-entrant boundaries.** An application listener can
   synchronously call `logout()`. The original lease is revalidated after the
   `token-refreshed` emission, after `login-completed`, after the
   server-managed refresh event, and in the public `refresh()` completion
   handler. A `login-started` listener that starts a session-ending operation
   now cancels the navigation and removes the login transaction that was
   written for it.
9. **Refreshes are not serialized across generations.** A refresh from another
   generation is neither joined nor waited on, and the in-page lock chain is
   keyed by generation so a stranded refresh from a dead session cannot gate
   the new session's first refresh. The cross-tab lock NAME is deliberately not
   scoped: that lock exists so two tabs do not rotate at once, and generations
   are per-tab counters. The stranded operation still discards or invalidates
   its own result through its original lease.
10. **`diagnose().ok === false`** while any retained logout, clear-failure or
    pending-revocation state exists, with a `recovery-state` check naming the
    reasons. That check reads flags only and performs no I/O.

## 22. rc.14 recovery bookkeeping

rc.13's recovery state machine was right; three of the primitives it rested on
were not, and the gate that verified all of it had a false-green path. rc.14
fixes the accounting and the evidence.

1. **Reservations occupy capacity.** `CredentialRegistry.reserve()` compared
   the sizes and returned a handle it recorded nowhere, so with
   `maxTracked = 1` two reservations both succeeded and N concurrent minting
   operations all passed the check together. A reservation now takes a slot
   before the minting request is sent. The slot returns on every path that
   does not produce a credential - network failure, non-success status,
   parse/contract rejection - and is held by the credential itself once one
   arrives. A logout that drains an outstanding reservation cancels it: the
   slot is freed and the handle is remembered, so a response arriving
   afterwards is classified as an orphan and revoked rather than completed.
   Nothing is ever evicted to satisfy the limit.
2. **Server-managed mints are inside the lifecycle.** A `tokenProvider` or
   token endpoint mints a credential exactly as `POST /token` does.
   `ServerManagedStorage` correctly refuses to cache a pull that resolved after
   its epoch changed - but rc.13 then dropped it, so the only reference to a
   live credential vanished and the logout that raced it completed with zero
   revocation attempts. The storage now reports discarded mints to the client,
   which registers, revokes, and (on failure) retains them for the next logout.
   The late token is never cached, emitted, returned or sent.
3. **A terminal transition invalidates the whole known credential.** `/token`
   rejecting the refresh credential does not prove the access token is dead -
   in split-token deployments they are separate values with separate
   lifetimes. Both terminal paths now pass the credential they know about into
   `endSessionLocally()`: the `current` token for a terminal 401, the `start`
   token when the credential vanished under the refresh lock. Every distinct
   target is attempted; failures stay retained and keep the client fail-closed.
   The transition's cleanup is in a `try/finally`, so an unexpected fault
   cannot strand an unowned local block or the pending-operation counter.
4. **Peer operations are tracked independently**, keyed by
   `(tabId, operationId)` - not by id alone, since ids come from another
   context. Each has its own block; duplicates are idempotent; a new session
   retires every settled operation rather than only the last one observed.
   rc.13 held one id and one block, so two overlapping `session-cleared`
   messages overwrote each other and the first one's terminal message cleared
   the session that replaced them.
5. **Lifecycle messages are bound to the session they end.** `operationId` is
   now MANDATORY on both `session-cleared` and `logout` - an uncorrelated
   message names no operation, so nothing can decide whether it is stale, a
   duplicate, or about this tab at all. Messages also carry metadata-only
   session binding: the `sessionVersion` fingerprint of the credential being
   ended (never the credential) plus a `startedAt` operation epoch for
   tokenless BFF state. A terminal message for an operation this tab has no
   record of is honoured only when it demonstrably targets the session this tab
   is in. A `session-cleared` - which only blocks and clears - is still
   honoured when it carries no fingerprint, because refusing a fail-closed
   instruction for lack of metadata is the unsafe default.
6. **Login is refused in every fail-closed state.** `login()` and
   `beginLogin()` throw while `gate.blocked()`, retained blocks included. The
   rc.13 behaviour started an authorization flow whose callback
   `assertNotLoggingOut()` was guaranteed to reject - the user went to the IDP
   and back to be told no. Nothing is written and no navigation happens. A
   successful `logout()` is the recovery mechanism: it retries every
   outstanding invalidation and releases the state when they succeed.
7. **The mutation gate cannot report a false green.** Running rc.13's gate with
   `npx` absent from `PATH` printed "killed" for all 30 mutations and exited 0,
   because it read a non-zero exit as "the test failed". Verdicts now come from
   what Vitest reported: a kill requires a run that started, executed the
   intended test, and reported a FAILING test. Spawn errors, signals, null exit
   status, command-not-found, config/import failures, missing test files and
   filters that matched nothing are all GATE ERRORS. `scripts/mutation-runner.mjs`
   holds the classifier and `scripts/mutation-runner.selftest.mjs` tests it,
   including a real spawn of a non-existent command.
8. **Clear failures are reported as clear failures.** A peer or terminal clear
   that fails now emits `session-clear-failed {scope, reasonCode, blocked}`.
   rc.13 reused `storage-write-failed` with `phase: "refresh"`, whose meaning
   is "a freshly rotated token could not be persisted and the session runs from
   a memory mirror" - the opposite of what had happened. The storage's own
   exception text is still never forwarded.
9. **Documentation corrected.** See §9 notes in this file and the README: the
   reservation limit is enforced before minting (it now genuinely is); server-
   managed mints are included in credential registration (they now are); an
   operation id alone does NOT make a stale terminal message harmless (session
   binding does); retained-state login is not a recovery path (it is refused);
   and `diagnose()` performs no credential-storage or token-minting I/O but
   does make one unauthenticated `GET /.well-known/jwks.json`.

## 23. rc.15 session binding

rc.14 introduced metadata-only session binding and then derived it from
`currentSessionVersion`, a field written from four places and read from three,
whose value did not always describe the session the client was actually in. An
independent review reproduced four consequences. rc.15 makes the binding follow
the session.

1. **One adoption point.** `adoptObservedSession()` is the ONLY writer of
   `currentSessionVersion`, and it takes a CANONICALIZED token -
   `canonicalizeStoredToken()` recomputes the fingerprint from the access
   token, so neither a storage plugin nor a peer can choose what this tab
   believes its session to be.
2. **Logout binds to the credential it destroyed.** The binding is derived
   inside the queued storage step, from the ACTIVE token: the degraded
   in-memory mirror when one is live, otherwise the canonical snapshot the
   queued step reads. Never from a retained or candidate credential - those
   belong to operations that are over - and never from `currentSessionVersion`
   before storage has been read. rc.14 captured it beforehand, so a tab that
   had never called `getToken()` sent BOTH lifecycle messages unbound; a peer
   that knew the session had to refuse them and stayed authenticated.
3. **A verified peer rotation is adopted.** `token-updated` canonicalizes the
   storage value, requires the recomputed fingerprint to match the announced
   one, revalidates the lifecycle lease, and only then adopts the new
   fingerprint and emits. rc.14 verified and emitted but kept the old
   fingerprint, so the peer's next legitimate lifecycle message for that
   session looked like a mismatch and was rejected.
4. **`token-updated` is bound to its generation.** The lease is captured before
   the asynchronous `storage.load()` and revalidated after it, and again before
   adopting or emitting. rc.14 had no lease on this path at all: a read
   resolving after a logout and a replacement login announced the old session's
   token into the new one - and, with adoption added, would have corrupted the
   new session's binding.
5. **One session-targeting predicate**, `messageTargetsThisSession()`, applied
   to untracked `session-cleared` and untracked `logout` alike: matching
   fingerprint accepts; explicit mismatch rejects; no fingerprint while a token
   fingerprint is known rejects; tokenless state accepts only when
   `startedAt >= sessionEstablishedAt`. Tracked and retired operation semantics
   are unchanged. rc.14 let a versionless `session-cleared` through on the
   grounds that clearing is fail-closed - but a message from an operation that
   demonstrably began before the current session existed is not about it, and
   honouring it destroys a credential the user has just obtained.
6. **One time unit.** `startedAt` and `sessionEstablishedAt` are MILLISECONDS
   since the Unix epoch (`Date.now()`), the same unit as the `at` field and the
   cross-tab freshness bound. rc.14 stamped `startedAt` from the injectable
   seconds clock while the transport stamped `at` in milliseconds, so any
   comparison between them was three orders of magnitude out. `AuthConfig.now`
   remains the seconds clock for token expiry; `wallClockMs()` is the documented
   clock for the lifecycle-message domain, and peer-operation retirement is
   pruned in the same unit.

### Test change

Two shipped tests (`storage-serialization-and-single-flight` "a transient refresh failure after a PEER
clear…", `lease-propagation` "a peer clear during a refresh") posted a VERSIONLESS `session-cleared` to a
client that had already observed its token. Their assertions - about the
refresh failure branch, not about binding - are unchanged; the fixtures now
send what a real rc.15 peer sends, a message bound to the session being ended.
Under §23.5 an unbound message is no longer evidence about an observed session,
so leaving the fixtures as they were would have tested the rejected behaviour.

## 24. rc.16 lifecycle identity by topology

rc.15's session binding was correct for one topology and wrong for the rest.
`sessionVersion` fingerprints an ACCESS TOKEN; rc.15 required an exact match
before honouring any untracked lifecycle message, which silently assumed that
every deployment shares one credential across tabs. Two independent probes
showed what that costs: two `ServerManagedStorage` bearer tabs of the SAME
backend session rejected each other's logout, and two `MemoryStorage` tabs
rejected the documented global logout - in both cases leaving a tab
authenticated after the user had signed out.

1. **`lifecycleIdentity`**, decided once from the storage's declared shape
   (`kind`, `transport`, `persistent`) and exposed as a readonly property:
   `shared-credential`, `managed-bearer`, `per-tab`, `ambient`. Never inferred
   from runtime behaviour.
2. **Targeting per topology.** `shared-credential` keeps rc.15's exact
   fingerprint rule unchanged - that is the one topology where a fingerprint
   really is the session identity. `managed-bearer` and `per-tab` cannot use it
   at all (two tabs of one session hold different tokens by design), so the
   only remaining trustworthy fact is time: a message is honoured unless its
   operation demonstrably began before this tab's session was established.
   `ambient` (BFF) has no browser credential and no trustworthy establishment
   signal, so it is conservatively fail-closed and the limitation is documented
   rather than papered over.
3. **What the decision refuses to use**: a peer-supplied fingerprint as a new
   verified identity; any unsigned JWT claim (`sid` or otherwise); "accept
   every mismatch" as a blanket rule, which would have cost the
   newer-callback-session protection; and request activity as evidence that a
   BFF session was established - an ordinary successful response may belong to
   the very session a logout is already ending.
4. **The peer clear reaches the managed cache.** A peer lifecycle message now
   calls `invalidateCache()` before `clear()`. `ServerManagedStorage.clear()`
   already does this itself; the explicit call means a custom
   server-managed-like storage cannot satisfy the contract while quietly
   keeping a cached bearer for a session that is over.
5. **`adoptObservedSession()` is genuinely the single writer** of
   `currentSessionVersion` AND `sessionEstablishedAt`. rc.15 documented that
   claim while five sites still assigned the field directly, which is how the
   paths came to disagree. It also now owns the establishment epoch: a session
   begins when this tab first observes a credential (or a callback completes),
   and a ROTATION inside a session deliberately does not move it.
6. **`sessionEstablishedAt` has a real establishment path in every mode that
   has a credential.** rc.15 set it only from browser callback handling, which
   `assertBrowserCodeFlowAllowed()` forbids in every server-managed mode - so
   the fallback documented as protecting tokenless sessions was, there,
   comparing against a value nothing ever wrote. For `ambient` there is still
   no such path, and §24.2 says so instead of claiming one.

### MemoryStorage contract

Explicitly retained and now documented in the README: `logout()` is global
across tabs on the same channel. Signing out is a user intent about the user,
not about one tab's copy of a credential. The per-tab token model is unchanged
in every other respect - `token-updated` is still ignored, and a terminal
refresh rejection is still local to the tab that saw it.

## 25. rc.17 establishment and declaration

rc.16's topology model was right; the two facts it rested on were not.

1. **Observation is not establishment.** rc.16 stamped `sessionEstablishedAt`
   the first time a tab observed a credential, then used that epoch to decide
   "my session is newer than your logout". A tab that starts listening late,
   misses `session-cleared`, and pulls a bearer from a backend session that is
   already being torn down thereby stamps an epoch AFTER the logout began - and
   ignores the terminal message, keeping the token cached. The pull succeeded
   _because_ the session it belongs to is the one being ended. The same applies
   to a preloaded per-tab credential: loading it is not the moment it came into
   existence.

   The epoch now advances only from an explicit, locally verifiable
   transition - a `handleCallback()` that completes here, which is the only one
   this client has. `load()`, `peek()`, subscription delivery, a token pull, a
   refresh and first observation all leave it alone. Where no trusted epoch
   exists (`0`), lifecycle messages are honoured conservatively, so the
   terminal `logout` remains an effective fallback for a tab that missed
   `session-cleared`. Where the epoch IS trusted, an operation that began
   before it still cannot destroy the session established since - the rc.16
   protection is unchanged.

2. **Persistence is not sharing.** `TokenStorage.persistent` documents whether
   a credential survives a tab close/reopen; rc.16 read it as "every tab reads
   this credential" and classified every persistent custom storage as
   `shared-credential`, where a fingerprint mismatch REJECTS a peer's logout.
   `sessionStorage`, a tab-keyed IndexedDB record and a partitioned worker
   cache are all persistent AND per-tab, and none of them could say so.

   `TokenStorage.lifecycleIdentity` is now an explicit, runtime-validated
   declaration over the closed `LifecycleIdentity` union:
   - built-in storages declare their exact identity (`MemoryStorage`
     -> `per-tab`, `CookieStorage` -> `shared-credential`, `ServerManagedStorage`
     -> `managed-bearer` or `ambient` from its transport);
   - a custom storage MUST declare one when cross-tab coordination is enabled;
     construction fails rather than guessing;
   - a value outside the union is a construction error;
   - a value that contradicts a built-in storage is a construction error - a
     declaration cannot change how a storage actually shares credentials;
   - the declaration is snapshotted at construction, so mutating it afterwards
     cannot change policy;
   - `persistent` and `lifecycleIdentity` stay orthogonal in the types and in
     the documentation, and neither is ever inferred from the other.

### Test change

Sixty-three custom-storage fixtures across thirteen test files gained an
explicit `lifecycleIdentity` declaration. Every one models a single shared cell
that the client and the test both read, so each declares `shared-credential`
(`per-tab` where the fixture sets `persistent: false`) - the classification
rc.16 gave them by inference. No assertion was changed.

## 26. rc.18 the declaration is universal

rc.17 required a topology declaration from custom storage and then waived it
for anything that LOOKED built-in: `builtinLifecycleIdentity()` read the public
`kind` (and `transport`) string and, on recognising one, returned an identity
before the requirement was reached.

`TokenStorage` is a STRUCTURAL interface. Any object can set `kind: "cookie"`.
So the requirement was waivable by writing one extra property, and all four
built-in-looking shapes - `memory`, `cookie`, `server-managed`/bearer,
`server-managed`/bff - constructed with no declaration at all. The exploitable
case: two tab-partitioned storages claiming `kind: "cookie"` were classified
`shared-credential`, where a fingerprint mismatch REJECTS a peer's logout, so
one tab's credential survived the other tab's sign-out.

1. **Every storage declares.** When cross-tab coordination is enabled, a valid
   `lifecycleIdentity` is required from every `TokenStorage` object without
   exception. The built-in CLASSES carry the field themselves, so they continue
   to work with no caller configuration - that is what makes the requirement
   cost nothing, not a shortcut in the classifier.
2. **`kind`/`transport` validate, they do not waive.** They are a claim, not a
   proof, and are consulted only AFTER a declaration exists, to reject one that
   contradicts the claim. `builtinLifecycleIdentity()` is renamed
   `claimedLifecycleIdentity()` so the code says which it is.
3. **Unchanged fail-closed behaviour**: a value outside the closed union, a
   contradiction, and a post-construction mutation are all still errors, and
   the declaration is still snapshotted at construction. With
   `crossTab: false` an omitted declaration is still allowed (reporting
   `per-tab`) while an explicitly invalid one still throws. Topology is still
   never inferred from `persistent`.
4. **Stale comment corrected.** The `sessionEstablishedAt` doc comment still
   described first observation as establishing the epoch; the implementation
   stopped doing that in rc.17. Only a completed `handleCallback()` sets it,
   and `0` - the normal state for `managed-bearer`, `ambient` and any tab whose
   credential simply existed when it started - means "no trusted epoch", which
   is why lifecycle messages are then honoured conservatively.

### Test change

One fixture in `lifecycle-topology` impersonates `kind: "server-managed"` with
cross-tab enabled and now declares `lifecycleIdentity: "managed-bearer"`, which
is what it always was. Its assertions are unchanged. No other shipped test
needed touching - the 63 custom-storage fixtures declared in rc.17 already
satisfy the universal rule.
