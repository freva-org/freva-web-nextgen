# @freva-org/ts-oidc-auth-client

Standalone, zero-dependency TypeScript browser client for
[py-oidc-auth](https://github.com/freva-org/py-oidc-auth) `auth/v2` servers -
the auth stack behind **freva-rest**. One broker token lifecycle (login ->
callback exchange -> proactive refresh with rotation -> logout), with **where
the credential rests** left as a pluggable, explicit choice.

```
npm install @freva-org/ts-oidc-auth-client   # once published
```

From the packaged source tarball instead, see "Trying it from a local
checkout" below - you build it and import from a relative path.

Works with any framework or none: plain `fetch` + `URL` + DOM, ES2020 output,
no runtime dependencies.

## The one fact that drives every design choice

In broker mode the server returns **one JWT that is both the access token and
the refresh credential** (`POST /token` accepts it even after `exp`; only the
`jti` has to match a live server-side session). Whatever storage holds that
JWT therefore holds a long-lived credential, not a one-hour pass. That is why:

- `storage` is a **required** constructor parameter. There is no default; the
  library refuses to make a security decision on your behalf.
- The library is **topology-blind**: every storage mode is always exported and
  constructible everywhere. Picking a mode whose environmental counterpart is
  missing is a _configuration_ error, surfaced by `diagnose()` and structured
  events - never a pruned menu.
- Tokens never touch `localStorage`. Cross-tab sync carries metadata only.

## Trying it from a local checkout

The package name `@freva-org/ts-oidc-auth-client` resolves only once the
package is published or linked. From an unpacked source tarball, build it
first and import from a relative path:

```bash
npm install        # dev toolchain (zero runtime deps)
npm run build      # creates dist/ - required before any dist/ import
npm test -- --run  # 389 tests; the real verification that it works here
```

Two things to know before you run any example:

- **The quickstart below is browser code.** It uses `location`, `history`,
  and `auth.isCallbackUrl()`, so it does nothing useful under bare `node` or
  `tsx` - there is no page URL to read and no DOM. To exercise it you need a
  browser (see "End-to-end against a server" further down), not a Node script.
- **`dist/index.js` is a library, not a runnable file.** `node dist/index.js`
  has nothing to execute; it only exports classes for your app to import.

If you just want to confirm the build is sound from Node, the URL-building and
detection paths work without a browser. Import from source (tsx maps the `.js`
specifier to the `.ts` file, so no build step is needed) or from `dist/` after
building:

```ts
// scratch.ts  - run with:  npx tsx scratch.ts
import { PyOidcAuthClient, MemoryStorage } from "./src/index.js";

const auth = new PyOidcAuthClient({
  authBaseUrl: "https://www.freva.example/api/freva-nextgen/auth/v2",
  redirectUri: "https://app.example/auth/callback",
  storage: new MemoryStorage(),
  crossTab: false, // no BroadcastChannel under Node
  navigate: (url) => console.log("would navigate ->", url),
  onEvent: (e) => console.log("event:", e.type),
});

console.log(auth.loginUrl({ offlineAccess: true }));
console.log(auth.isCallbackUrl("https://app.example/cb?code=a&state=b")); // true
```

## Quickstart (pure SPA, per-tab session)

```ts
import { PyOidcAuthClient, MemoryStorage } from "@freva-org/ts-oidc-auth-client";

const auth = new PyOidcAuthClient({
  authBaseUrl: "https://www.freva.example/api/freva-nextgen/auth/v2",
  redirectUri: `${location.origin}/auth/callback`,
  storage: new MemoryStorage(),
  security: {
    // Origins allowed to receive the Authorization header. The page origin and
    // the authBaseUrl origin are always allowed; name any others explicitly.
    // In broker mode the Bearer IS the refresh credential, so auth.fetch()
    // throws OriginNotAllowedError rather than decorate an arbitrary URL.
    allowedResourceOrigins: ["https://www.freva.example"],
  },
});

// Anywhere in the app:
if (auth.isCallbackUrl()) {
  await auth.handleCallback(); // exchanges code+state via XHR,
  const next = auth.consumeReturnPath(); // scrubs only the OIDC params
  if (next) history.replaceState(null, "", next);
} else if (!(await auth.getToken())) {
  auth.login({ next: location.pathname + location.search });
  // next is validated to a same-origin relative path (open-redirect guard)
}

// Authenticated calls - refresh, Bearer header and a single gated
// 401 retry are handled for you:
const res = await auth.fetch("/api/freva-nextgen/databrowser/data-search?...");
```

No app backend participates: the callback exchange is a plain `GET
{base}/callback` XHR; PKCE and the confidential client secret stay on the
auth server.

## Storage modes

### `MemoryStorage`

Token lives in a closure variable. Safest browser-readable option; each tab
holds its **own** token, and a reopened tab re-enters through a silent SSO
redirect (visible flash, no re-login while the IDP session lives).

`logout()` is nevertheless **global across tabs on the same channel**: signing
out is a user intent about the _user_, not about one tab's copy of a
credential, and a logout that silently left other tabs signed in would be the
worse surprise. Because each tab's token differs, the decision cannot be made
by comparing fingerprints - see "Cross-tab lifecycle by topology" below.

### `CookieStorage` - compatibility only, separate entry point

```ts
import { CookieStorage } from "@freva-org/ts-oidc-auth-client/unsafe-compat";

new CookieStorage({
  compatibilityMode: "freva-web-single-token", // -> freva_auth_token
  acknowledgeBrokerSingleTokenContract: true, // REQUIRED at construction
});
```

It stores one raw JWT, so `load()` necessarily reports that value as _both_
the access token and the refresh credential. That is only true under the
py-oidc-auth broker contract, where the server deliberately issues one JWT in
both roles - so the acknowledgement is mandatory, and `save()` rejects
access-only, split, or `refreshable: false` tokens rather than inventing a
refresh credential the server never granted.

Raw broker JWT as a host-only cookie (`SameSite=Strict` default, `Max-Age`
aligned to the JWT `exp`). It survives reloads and is shared across tabs.

**It is not "storage only".** An earlier version of this README said the cookie
never reaches the API because requests carry an explicit `Authorization` header.
That is wrong on a same-site deployment: per RFC 6265 §5.4 the browser attaches a
matching cookie to _every_ request to the host whatever this library does, so with
the default `Path=/` the refresh-capable JWT reaches every route on the origin and
every proxy, middleware and CDN in front of it - and their access logs. It is also
readable by any same-origin script, because a cookie written from JavaScript
cannot be HttpOnly. That is why it now lives behind `/unsafe-compat`: it exists to
interoperate with freva-web's `getTokenFromCookie` during migration phases 0–2,
not as a peer of the other modes.

The client says so once at construction via a `security-warning` event (code
`browser-readable-refresh-credential`) - emitted during construction, so pass
`onEvent` in the config to observe it; an `auth.on(...)` listener attached
afterwards misses it. CookieStorage round-trips only the raw JWT: it is
broker/auth-code oriented and cannot preserve token-response metadata such as a
future `refreshable: false`. It refuses tokens that would exceed the 4096-byte
cookie limit (browsers drop those silently) and refuses to run on a non-loopback
plaintext origin.

### `ServerManagedStorage` - transport `"bearer-from-endpoint"`

A backend (Django today; freva-rest itself once the split-token PR lands; any
edge function) keeps the refresh capability in an httpOnly context and exposes
an endpoint minting **short-lived** access tokens. The client pulls one with
`credentials: "include"`, caches it in memory (~4 endpoint hits/hour), and
your data path stays `browser -> API` with a Bearer header.

```ts
new ServerManagedStorage({
  transport: "bearer-from-endpoint",
  tokenEndpoint: "/api/auth/access-token",
  tokenEndpointMethod: "POST", // minting is not a cacheable GET
  healthUrl: "/api/token-health/", // what diagnose() probes; never the token endpoint
  logoutEndpoint: "/api/auth/logout",
  csrf: { headerName: "X-CSRFToken", token: () => readCsrfCookie() },
});
```

### `ServerManagedStorage` - transport `"bff"`

Every API call is proxied by your backend, which attaches the token
server-side. **A CSRF strategy is mandatory here** - every proxied call goes out
with `credentials: "include"`, which is exactly the shape CSRF exploits, and
SameSite alone does not cover same-site subdomains. Pass
`csrf: { headerName, token }`, or `acknowledgeNoCsrf: true` if your backend
already enforces CSRF by another mechanism. `auth.fetch` sends `credentials: "include"` and **no**
Authorization header; `getToken()` resolves `null`; `refresh()` throws; `userinfo()` requires
`config.userinfoEndpoint` (the server's own `/userinfo` expects a Bearer the bff
transport never attaches). Note
the proxy doubles every request - usually the wrong trade for freva's
data-heavy paths.

### Custom

Implement the four-method `TokenStorage` interface (`load/save/clear`,
optional `subscribe`, `kind`, `persistent`) for environments we did not
imagine - Electron, browser extensions, a JupyterLab plugin.

## Readiness matrix

Every cell ships in the same package; cells differ only in prerequisites,
which `diagnose()` reports legibly. **CookieStorage is never "ready"**: it is
legacy single-token compatibility storage behind `/unsafe-compat`, it requires
an explicit acknowledgement to construct, and it deliberately makes
`diagnose().ok === false` wherever it is used.

| Deployment                   | Cookie             | Memory | ServerManaged (bearer)                                           | ServerManaged (bff) |
| ---------------------------- | ------------------ | ------ | ---------------------------------------------------------------- | ------------------- |
| Same-site SPA, no backend    | legacy compat only | ready  | ready once the split-token server PR ships (config-only upgrade) | needs a proxy tier  |
| Cross-origin SPA, no backend | legacy compat only | ready  | needs `SameSite=None` + credentialed CORS server work            | needs a proxy tier  |
| freva-web (Django present)   | legacy compat only | ready  | ready today (Django is the endpoint)                             | possible, costly    |

## Refresh semantics (the part worth trusting)

- **Proactive**: `getToken()` refreshes inside a 120 s buffer (configurable)
  and is single-flighted per page. Under the lock the token is re-loaded
  first, so a peer tab's rotation short-circuits without a network call.
- **Cross-tab serialization comes from `navigator.locks` alone.**
  `BroadcastChannel` and the metadata-only `localStorage` fallback _publish_
  that a rotation happened - they cannot prevent two tabs rotating at once.
  Where Web Locks is unavailable, only a server-side idempotency/grace window
  closes that race; until then the losing tab takes a terminal 401.
- **Rotation-aware**: py-oidc-auth deletes the old session _before_ minting
  the new one, so a refresh credential dies the moment it is used.
- **Only 401 is terminal.** It is the server's sole signal for a dead/rotated
  session: storage is cleared, `session-expired` fires, persistent-storage
  peers get a logout broadcast. 429/5xx (`transient_server`) and network
  errors (`transient_network`) never clear storage - a still-valid token keeps
  being served while the server misbehaves. 400 reports `cors_or_config`.
- **`auth.fetch` retries a 401 at most once**, and only when the token is
  locally expired/near-expiry or the response carries
  `WWW-Authenticate: … error="invalid_token"`. Permission/audience 401s pass
  through untouched. As with any fetch retry wrapper, a request whose body is
  a one-shot stream cannot be replayed - pass replayable bodies (string,
  `URLSearchParams`, `Blob`, `FormData`) or set `retryOn401: false` for
  streaming uploads.

## Startup diagnostics

```ts
const report = await auth.diagnose();
// { storageKind, ok, checks: [{ name, ok, detail, hint? }, …] }
```

One structured console line at startup instead of mysterious 401s an hour
later: is the broker JWKS reachable, does the cookie round-trip, does the
server-managed endpoint answer (a 401 there counts as _reachable_ - the
backend session is merely absent).

## Events

`login-started`, `login-completed`, `token-refreshed` (`source: "self" | "tab"`),
`session-expired`, `logout`, `refresh-failed` (with a `RefreshFailureKind`),
`storage-write-failed`, `security-warning` (with a machine-readable `code`),
`diagnose` - subscribe with `auth.on(handler)` or the `onEvent` config field.

**Events carry no credential.** `login-completed` and `token-refreshed` hand you a
redacted `TokenSummary` (`sessionVersion`, `expiresAt`, `scope`, `tokenType`, …),
never the token string, so piping events straight into Sentry breadcrumbs or redux
devtools does not log a refresh credential. Call `getToken()` when you actually
need the value.

## Scope and roadmap

v1 deliberately excludes the device flow, RFC 8693 exchange, SPA-held PKCE
and DPoP. The companion server-side roadmap (refresh grace window,
`refreshable: false`, `POST /revoke`, `code_challenge` passthrough) and the
staged freva-web migration plan live in [`docs/SPEC.md`](./docs/SPEC.md),
which is the authoritative design document.

## End-to-end against a server

The honest test is a browser against a live py-oidc-auth/freva-rest, because
cookies, the IDP redirect round-trip, and `navigator.locks` are exactly what a
Node script cannot exercise. Two ways to wire the local package into a throwaway
app:

```bash
# In a scratch Vite app (npm create vite@latest scratch -- --template react-ts):
npm install /absolute/path/to/ts-oidc-auth-client   # file: dependency
# or, to edit-and-rebuild the library in place:
cd /path/to/ts-oidc-auth-client && npm link
cd /path/to/scratch && npm link @freva-org/ts-oidc-auth-client
```

Then drop the quickstart into a component, set `authBaseUrl` to a reachable
server and `redirectUri` to your dev URL (e.g. `http://localhost:5173/auth/callback`),
and **register that exact redirect URI with the server's OIDC client config**
or the login round-trip will be rejected. Call `await auth.diagnose()` on
startup - it reports JWKS reachability and CORS/base-URL mistakes in one object,
which is the class of failure that otherwise surfaces as a mysterious 401 later.

## Development

```
npm run typecheck   # src and tests
npm test            # vitest, happy-dom
npm run build       # ESM + d.ts into dist/
```

BSD-3-Clause.

## Security options, warnings and diagnostics

Every setting below either tightens the default or explicitly accepts a known
gap. **Every acknowledgement emits a `security-warning` and makes
`diagnose().ok === false`** - it records that someone accepted a risk, it never
marks the deployment healthy.

| `security.*`                       | Effect                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowedResourceOrigins`           | Extra origins allowed to receive the credential. Page origin + `authBaseUrl` origin are always allowed; everything else throws `OriginNotAllowedError`. |
| `allowedRedirectUris`              | Exact-match allowlist for `login`/`loginUrl`/`handleCallback`. Defaults to the configured `redirectUri`.                                                |
| `allowedPostLogoutRedirectUris`    | Exact-match allowlist for `logout`/`logoutUrl`.                                                                                                         |
| `expectedIssuer`                   | RFC 9207 `iss` validation, exact string comparison. Without it, a response carrying `iss` is rejected.                                                  |
| `requireLoginTransaction`          | Default true. Proves _this tab_ began a login - **not** server-side state binding. Turning it off requires `acknowledgeNoLoginTransaction`.             |
| `loginTransactionTtlSeconds`       | Default 600.                                                                                                                                            |
| `warnOnBrowserReadableRefresh`     | Mutes the storage-kind warning only. Cannot mute an acknowledgement.                                                                                    |
| **acknowledgements**               |                                                                                                                                                         |
| `allowInsecureTransport`           | Permit plaintext http credentials.                                                                                                                      |
| `acknowledgeNoBackendLogout`       | Server-managed logout without a backend endpoint.                                                                                                       |
| `acknowledgeUnsupportedRevocation` | Accept a server with no `POST /revoke`.                                                                                                                 |
| `acknowledgeNoRevocation`          | Never attempt revocation at all.                                                                                                                        |
| `acknowledgeNoLoginTransaction`    | Required to disable the login-CSRF check.                                                                                                               |
| `acknowledgeMissingIssuer`         | Accept a provider that omits RFC 9207 `iss`.                                                                                                            |

Storage-level acknowledgements: `CookieStorage.acknowledgeBrokerSingleTokenContract`,
`CookieStorage.allowInsecureTransport`, `CookieStorage.acknowledgeInsecureCookie`,
`ServerManagedStorage.acknowledgeNoCsrf`,
`ServerManagedStorage.allowRefreshCapableToken` and
`ServerManagedStorage.acknowledgeUnsafeTokenEndpointMethod`.

`isCallbackUrl()` is **routing**, not validation: it returns true for a
registered callback route carrying OIDC response parameters even when the
response is invalid (duplicate parameters, mixed success/error, wrong issuer),
so `handleCallback()` gets the chance to scrub the credential out of the URL
and report the failure. It returns false only for a route that is not yours.

**Warning codes** (`security-warning.code`): `refresh-capable-bearer`,
`browser-readable-refresh-credential`, `unverifiable-custom-storage`,
`bff-without-csrf`, `long-lived-managed-token`, `no-backend-logout`,
`unsupported-revocation`, `no-revocation`, `legacy-cookie-storage`,
`insecure-transport`, `refresh-capable-managed-token`.

**Errors**: `AuthError`, `NotAuthenticatedError`, `SessionExpiredError`,
`InvalidTokenResponseError`, `LoginTransactionError`, `RefreshError`,
`RevocationError`, `CsrfUnavailableError`, `StorageContractError`,
`OriginNotAllowedError`, `RedirectNotAllowedError`.

`login()`, `loginUrl()` and `handleCallback()` are **unavailable in every
server-managed topology**: the browser-side code flow would hand a token to
JavaScript, which is what those topologies exist to prevent. Complete the login
on your backend and let it establish its session.

**Events**: `login-started`, `login-completed`, `token-refreshed`,
`session-expired`, `session-cleared`, `logout`, `refresh-failed`,
`storage-write-failed`, `session-clear-failed`, `revocation-failed`,
`security-warning`, `diagnose`.

`login-completed` carries `hasReturnPath`, not the path itself - call
`consumeReturnPath()` for the value. `TokenSummary` carries no provider-supplied
strings at all.

`session-cleared` means a peer tab dropped the credential while a logout is
still in flight - re-render as signed out, but do not report a completed
logout. `logout` arrives only once backend logout and revocation have
succeeded.

`storage-write-failed` means a freshly rotated token could not be persisted and
the session is running from a per-page memory mirror.
`session-clear-failed` is a different incident: a session END could not remove
the stored credential, so an OLD credential may still be present and this tab
is fail-closed until a `logout()` completes. Neither event ever carries the
storage's own exception text.

`diagnose()` performs **no credential-storage and no token-minting I/O**: it
never calls a token endpoint, a token provider, `healthUrl`, or
`storage.load()`, and never mints, rotates, clears or revokes anything. It is
not I/O-free - it makes one **unauthenticated** `GET /.well-known/jwks.json` to
report broker reachability, which carries no credential and changes no state.
For an explicit _credentialed_ check use `probeConnectivity()`, which carries
the configured CSRF header, a timeout, `no-store` and `redirect: "error"`.

## Recovery states

When an invalidation cannot be confirmed, the client becomes **fail-closed**:
token reads and authenticated requests are refused, `diagnose().ok` is `false`
with a `recovery-state` check, and a `security-warning` names the state
(`logout-failed-blocked`, `peer-clear-failed-blocked`,
`terminal-clear-failed-blocked`, `pending-revocation-blocked`).

**`logout()` is the only recovery mechanism.** It retries every outstanding
invalidation - including credentials whose revocation failed earlier and
credentials minted for a session that had already ended - and releases the
state when they succeed. `login()` and `beginLogin()` are **refused** while any
of these states is held: a login started there produces a callback that is
guaranteed to be rejected, so it fails immediately instead of after a round
trip to the IDP.

Cross-tab lifecycle messages carry a mandatory `operationId` **and** a
metadata-only session binding: the `sessionVersion` fingerprint of the
credential being ended, plus a `startedAt` operation epoch for tokenless BFF
state. The id alone identifies an operation, not the session it was meant to
end, so it is not by itself enough to make a delayed message harmless. Both
`session-cleared` and `logout` are subject to the same targeting decision when
they belong to an operation this tab is not already tracking.

`startedAt` - like `at` - is **milliseconds** since the Unix epoch
(`Date.now()`). `AuthConfig.now` is a separate, injectable **seconds** clock and
is used only for token expiry.

### Cross-tab lifecycle by topology

`sessionVersion` fingerprints an **access token**. Whether that identifies a
**session** depends on the storage, so `auth.lifecycleIdentity` is decided once
from the storage's declared shape and drives every cross-tab decision:

| `lifecycleIdentity` | Storage                                                    | How an untracked lifecycle message is targeted                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared-credential` | `CookieStorage`, or a custom storage that **declares** it  | Exact recomputed fingerprint must match. A mismatch is rejected; a message naming no session is rejected once this tab knows its own.                                                                             |
| `managed-bearer`    | `ServerManagedStorage({transport:"bearer-from-endpoint"})` | One backend session mints a different bearer per tab, so a fingerprint mismatch proves nothing and never rejects. Accepted unless the operation demonstrably **began before this tab's session was established**. |
| `per-tab`           | `MemoryStorage`, or a custom storage that **declares** it  | Same rule as `managed-bearer`: each tab's token differs by design.                                                                                                                                                |
| `ambient`           | `ServerManagedStorage({transport:"bff"})`                  | No browser credential exists. Conservatively fail-closed: every same-channel lifecycle message is honoured.                                                                                                       |

**Declaring the topology.** Every `TokenStorage` must carry `lifecycleIdentity`
whenever cross-tab coordination is enabled; construction fails otherwise. The
built-in classes declare it for you, so `MemoryStorage`, `CookieStorage` and
`ServerManagedStorage` need no caller configuration - but the requirement is
**universal**, and a `kind` string never waives it. `TokenStorage` is a
structural interface: any object can write `kind: "cookie"`, so treating that
claim as proof of a class made the requirement optional for anyone who typed
one extra property.

`kind`/`transport` are used only to check that a declaration is CONSISTENT with
what the storage claims to be, after a declaration exists. A value outside the
union, or one that contradicts the claim, is a construction error. The value is
snapshotted at construction, so mutating it later cannot change policy.

With `crossTab: false` no lifecycle message can arrive, so an omitted
declaration is allowed and reports `per-tab`; an explicitly invalid one still
throws.

`persistent` and `lifecycleIdentity` are **orthogonal**. `persistent` is about
TIME (does the credential outlive this page?); `lifecycleIdentity` is about
SPACE (do other tabs read the same credential?). `sessionStorage`, an IndexedDB
record keyed by tab and a partitioned worker cache are all persistent AND
per-tab. Nothing infers one from the other.

```ts
new PyOidcAuthClient({
  storage: {
    kind: "custom",
    persistent: true, // survives tab close/reopen
    lifecycleIdentity: "per-tab", // ...but each tab has its own copy
    load,
    save,
    clear,
  },
  // ...
});
```

**"This tab's session was established"** means exactly one thing: a
`handleCallback()` that completed here. It is NOT set by `load()`, `peek()`, a
subscription delivery, a token pull, a refresh, or the first time a credential
is observed - none of those is evidence that a session began. A tab that starts
listening late, misses `session-cleared`, and then obtains a bearer from a
backend session that is already being torn down would otherwise declare itself
"newer" than the logout and ignore the terminal message.

Where no trusted establishment epoch exists - every `managed-bearer` and
`ambient` tab, and any tab whose credential simply existed when it started -
lifecycle messages are honoured conservatively. In particular the terminal
`logout` remains an effective fallback for a tab that missed the first
message.

**Known limitation (BFF).** In `ambient` mode this client has no trustworthy
signal for when an ambient backend session _began_, so it cannot distinguish a
delayed logout for an old session from one for a session established since.
Treating an ordinary successful proxied request as "a new session started"
would be wrong - that response may belong to the very session a logout is
already ending. The behaviour is therefore fail-closed: a stale message can
leave a BFF tab refusing credentialed work until the backend session is
re-established. Correlating this precisely needs a backend-supplied session
identifier, which is outside this client's scope.

What the targeting decision deliberately does **not** use: a peer-supplied
fingerprint as a new identity (it is unverified), any unsigned JWT claim such
as `sid` (this client never trusts token contents it has not had verified
server-side), or request activity as evidence of session establishment.

Credential-producing operations - `POST /token`, the callback exchange, and
server-managed token providers/endpoints - reserve a tracking slot **before**
the minting request is sent. When the tracker is full the next such operation
is refused rather than a live credential being forgotten to make room.

`loginUrl()` is a pure builder and does **not** establish the login
transaction `handleCallback()` requires - use `login()` for the full flow, or
`beginLogin()` if you navigate yourself.

Every security-relevant option is **runtime-validated**: a real boolean is
required, so a stray `"false"` throws rather than silently enabling the thing
it names.

## Browser tests

The engine matrix depends on the platform, because this project omits WebKit
from local macOS runs - it has observed Playwright/macOS compatibility failures
launching it there, and an engine that will not start produces no signal. That
is a choice about this project's local workflow, not a general claim about
Playwright on macOS.

|                       | `browsers:install` and `test:browser` | `test:browser:strict`                 |
| --------------------- | ------------------------------------- | ------------------------------------- |
| **macOS development** | Chromium + Firefox                    | refuses to run (exit 3)               |
| **Linux / Docker**    | Chromium + Firefox + WebKit           | Chromium + Firefox + WebKit, no skips |

```
npm run build                # the browser suites import ./dist
npm run browsers:install     # per the table above; only ever ADDS to the
                             #   shared ~/.cache/ms-playwright
npm run test:browser         # redirect, callback, document-base (relaxed)
npm run check:bytes          # no NUL/control bytes in shipped or reviewed files
npm run check:mutations      # removing a control must fail its test
npm run test:browser:strict  # release gate: all three engines, no skips
```

`test:browser:strict` is release evidence and is never narrowed - not by
platform, not by `BROWSERS`. On macOS it fails immediately rather than report a
two-engine pass. Run the full gate on Linux CI, or locally with the Playwright
Docker image:

```bash
docker run --rm -it --init --ipc=host \
    -v "$PWD":/w -v /w/node_modules -v /w/dist -w /w \
    mcr.microsoft.com/playwright:v1.62.1-noble \
    bash -lc 'npm ci && npm run build && npm run test:browser:strict'
```

`--init` reaps the processes browsers leave behind and `--ipc=host` gives
Chromium a large enough `/dev/shm`; the anonymous volumes on `node_modules` and
`dist` keep the container's Linux-native dependencies and root-owned build
output out of your checkout.

### Contributor toolchain

**Node 22 or 24.** Node 23 is not supported by the pinned Vitest version, so
`npm test` will not run there. `.nvmrc` pins 24 for contributors. This is a
constraint on developing the package - the published library itself has no
Node requirement and targets browsers.
