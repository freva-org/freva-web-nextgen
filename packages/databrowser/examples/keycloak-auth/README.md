# Databrowser + Keycloak (auth example)

The smallest complete Data-Browser sign-in: a real Keycloak login through freva-rest's `auth/v2`
broker. Signed in, every request carries a bearer refreshed before it expires; sign-out also ends
the Keycloak session.

```
browser ── http://localhost:5173 ──┬── /, /auth/callback, /main.js, /pkg/*   (serve.mjs)
                                   └── /api/freva-nextgen/*  ──proxy──> freva-rest :7777
freva-rest ── OIDC discovery / code exchange ──> Keycloak :8080 (realm "freva")
```

The integration is [`main.js`](./main.js); its core:

```js
const auth = new PyOidcAuthClient({
  authBaseUrl: `${location.origin}/api/freva-nextgen/auth/v2`,
  redirectUri: `${location.origin}/auth/callback`,
  postLogoutRedirectUri: `${location.origin}/`,
  storage: new MemoryStorage(),
  security: {
    expectedIssuer: "http://localhost:8080/realms/freva", // Keycloak sends RFC 9207 `iss`
    acknowledgeUnsupportedRevocation: true, // freva-rest has no POST /revoke yet
  },
});
if (auth.isCallbackUrl()) {
  await auth.handleCallback();
  history.replaceState(null, "", auth.consumeReturnPath() ?? "/");
}
mountDataBrowser(document.getElementById("app"), {
  apiBase: "/api/freva-nextgen/databrowser",
  authEnabled: true, // this deployment offers sign-in; browsing works without it
  getAuthToken: async () => (await auth.getToken())?.accessToken ?? null, // null = anonymous
  enableHeavyOps: true, // Inspect / Aggregate through freva-rest's data-loader
  signIn: () => auth.login({ next: location.pathname + location.search }),
});
```

## Run it

1. **Backend services** - from a [freva-nextgen](https://github.com/freva-org/freva-nextgen)
   checkout (Keycloak with the `freva` realm, Solr, MongoDB, Redis):

   ```bash
   git submodule update --init dev-env/config
   docker compose -f dev-env/docker-compose.yaml up -d
   ```

   `keycloak-bootstrap` creates a user named `$USER` with password `secret`.

2. **freva-rest** - same checkout, with the databrowser and data-loader (`zarr-stream`) services.
   `--proxy` is this example's origin. Inspecting a non-zarr file also needs the data-loader worker
   (freva-nextgen's `run_server.py` starts it with freva-rest):

   ```bash
   make install        # or: pip install -e ./freva-rest
   python -m freva_rest.cli --dev -p 7777 --services databrowser zarr-stream \
     --config dev-env/api_config.toml \
     --oidc-discovery-url http://localhost:8080/realms/freva/.well-known/openid-configuration \
     --oidc-client-id freva --proxy http://localhost:5173
   ```

3. **This example** - from the root of this repository:

   ```bash
   npm ci && npm run build
   node packages/databrowser/examples/keycloak-auth/serve.mjs   # PORT=5173 FREVA_REST=http://localhost:7777
   ```

   Open http://localhost:5173, click **Sign in**, log in as `$USER` / `secret`.

## What to look for

- Anonymous: public search works; the `user` flavour is not offered.
- Signed in: every databrowser request carries `Authorization: Bearer …`, and the flavour menu
  offers `user`.
- After ~1 hour (the broker JWT lifetime) a `POST /auth/v2/token` precedes the next request, which
  carries the rotated token - no re-login, no 401.
- **Inspect** a non-zarr file: signed out, the inspector offers **Sign in**; signed in, it converts
  (`/zarr/convert` -> `/zarr-utils/status`), reads the store and shows a token-free
  `/data-portal/share/…` link for GridLook. **Aggregate** does the same for several files.
- **Sign out** goes through freva-rest's `/auth/v2/logout` to Keycloak's end-session page and
  back; **Sign in** then shows the Keycloak form again.

## Notes

- `MemoryStorage`: a reload starts anonymous, and **Sign in** is a silent SSO round-trip while the
  Keycloak session lives. For a session that survives reloads, see the `sessionStorage` adapter
  in `packages/portal-builder/client/components/auth-storage.ts`.
- `/revoke` answers 404 (py-oidc-auth has no token revocation); `acknowledgeUnsupportedRevocation`
  accepts that, and the broker session ends with the token or the Keycloak session.
- Production needs an https issuer and origin; plain http is accepted only on loopback hosts.
