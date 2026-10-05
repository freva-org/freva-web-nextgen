/**
 * Auth island.
 *
 * The client is configured from derived values only: the redirect URI is this origin plus the
 * base path plus the callback path (worked out here, so no host name is built into the page), and
 * the bearer-resource allowlist is the credential-accepting services plus the origins the
 * consumer listed explicitly. Neither is independently configurable, which is what stops a
 * base-path change from silently breaking the login and stops a token being attached merely
 * because a URL appeared somewhere in site content.
 *
 * Sign-out returns through the same callback page: the tab records where it was, the provider
 * ends its session and sends the tab back to the callback, which returns it there.
 */

import { PyOidcAuthClient } from "@freva-org/ts-oidc-auth-client";
import { callbackUrl, recordLogoutReturn } from "../auth-relay.js";
import { PortalSessionStorage } from "./auth-storage.js";
import type { AuthBridge, AuthRuntime } from "../runtime.js";

let bridge: AuthBridge | undefined;
let client: PyOidcAuthClient | undefined;

export function createAuth(runtime: AuthRuntime): AuthBridge {
  if (bridge) return bridge;

  const redirectUri = callbackUrl(window.location.origin, runtime.basePath, runtime.callbackPath);
  client = new PyOidcAuthClient({
    authBaseUrl: runtime.authBaseUrl,
    redirectUri,
    storage: new PortalSessionStorage(),
    security: {
      allowedResourceOrigins: runtime.allowedResourceOrigins,
      allowedRedirectUris: [redirectUri],
      allowedPostLogoutRedirectUris: [redirectUri],
      // Keycloak stamps RFC 9207 `iss` on every authorization response; without the expected
      // issuer the client rejects that response as `issuer-unexpected`.
      ...(runtime.expectedIssuer ? { expectedIssuer: runtime.expectedIssuer } : {}),
    },
    onEvent: (event) => {
      if (event.type === "session-cleared" || event.type === "session-expired") {
        reflectSignedIn(false);
      }
    },
  });

  bridge = {
    // Asked per request, never cached here: getToken() refreshes the broker token before it
    // expires, where a copy taken at page load would go stale after an hour.
    token: async () => {
      try {
        return (await client?.getToken())?.accessToken ?? null;
      } catch {
        return null;
      }
    },
    login: () => {
      void client?.login({ next: window.location.pathname + window.location.search });
    },
    logout: () => {
      recordLogoutReturn(
        window.sessionStorage,
        window.location.pathname + window.location.search,
        Date.now(),
      );
      void client?.logout({ postLogoutRedirectUri: redirectUri });
    },
  };

  void bridge.token().then((token) => reflectSignedIn(Boolean(token)));

  wireAccountControl(bridge);
  return bridge;
}

function wireAccountControl(auth: AuthBridge): void {
  const control = document.querySelector<HTMLElement>("[data-portal-account]");
  if (!control) return;
  control.hidden = false;
  control.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const action = target?.closest<HTMLElement>("[data-portal-auth-action]");
    if (!action) return;
    event.preventDefault();
    if (action.dataset.portalAuthAction === "logout") auth.logout();
    else auth.login();
  });
}

function reflectSignedIn(signedIn: boolean): void {
  const control = document.querySelector<HTMLElement>("[data-portal-account]");
  if (control) control.dataset.portalSignedIn = signedIn ? "true" : "false";
}

export function authClient(): PyOidcAuthClient | undefined {
  return client;
}
