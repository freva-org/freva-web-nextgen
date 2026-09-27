// ts-oidc-auth-client owns login and refresh; the databrowser only asks it for a bearer.

import { MemoryStorage, PyOidcAuthClient } from "@freva-org/ts-oidc-auth-client";
import { mountDataBrowser } from "@freva-org/databrowser";

const API = `${location.origin}/api/freva-nextgen`;
// The Keycloak realm freva-rest uses (freva-nextgen/dev-env), sent as `iss` (RFC 9207).
const ISSUER = "http://localhost:8080/realms/freva";

const who = document.getElementById("who");
const loginBtn = document.getElementById("login");
const logoutBtn = document.getElementById("logout");
function showSignedIn(name) {
  who.textContent = `signed in as ${name}`;
  loginBtn.hidden = true;
  logoutBtn.hidden = false;
}
function showSignedOut(text) {
  who.textContent = text;
  loginBtn.hidden = false;
  logoutBtn.hidden = true;
}

const auth = new PyOidcAuthClient({
  authBaseUrl: `${API}/auth/v2`,
  redirectUri: `${location.origin}/auth/callback`,
  // Sign-out ends the Keycloak session too: freva-rest's /logout redirects there and back.
  postLogoutRedirectUri: `${location.origin}/`,
  storage: new MemoryStorage(),
  security: {
    expectedIssuer: ISSUER,
    // freva-rest (py-oidc-auth <= 2606) has no POST /revoke; without this, logout() rejects with
    // RevocationError.
    acknowledgeUnsupportedRevocation: true,
  },
  onEvent: (e) => {
    console.debug("[auth]", e.type);
    // Refresh failed for good (IDP session gone) or another tab signed out.
    if (e.type === "session-expired" || e.type === "session-cleared" || e.type === "logout") {
      showSignedOut("session ended - sign in again");
    }
  },
});

// 1. Coming back from Keycloak? Finish the code exchange before anything renders.
if (auth.isCallbackUrl()) {
  try {
    await auth.handleCallback();
  } catch (err) {
    console.error("sign-in failed", err);
  }
  history.replaceState(null, "", auth.consumeReturnPath() ?? "/");
}

// 2. Signed in? (MemoryStorage: a reload starts anonymous; "Sign in" is then a silent SSO hop.)
const signedIn = (await auth.getToken()) !== null;
if (signedIn) {
  const info = await auth.userinfo().catch(() => ({}));
  showSignedIn(info.preferred_username ?? info.username ?? "?");
} else {
  showSignedOut("anonymous");
}
loginBtn.onclick = () => auth.login({ next: location.pathname + location.search });
// Clears the token, then navigates to freva-rest's /logout -> Keycloak -> back to "/".
logoutBtn.onclick = () => auth.logout().catch((e) => console.warn("logout", e));

// 3. The databrowser: `authEnabled` says this deployment has sign-in; the token says who is.
const handle = mountDataBrowser(document.getElementById("app"), {
  apiBase: `${API}/databrowser`,
  authEnabled: true,
  // Inspect / Aggregate of non-zarr files via freva-rest's data-loader (`zarr-stream`).
  enableHeavyOps: true,
  signIn: () => auth.login({ next: location.pathname + location.search }),
  // Awaited before every request: getToken() refreshes the token before expiry, null = signed out.
  getAuthToken: async () => (await auth.getToken())?.accessToken ?? null,
});
window.__demo = { auth, handle };
