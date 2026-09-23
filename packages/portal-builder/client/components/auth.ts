/**
 * Auth island.
 *
 * The client is configured from derived values only: the redirect URI is `site.canonicalUrl` plus
 * the callback path, and the bearer-resource allowlist is the credential-accepting services plus
 * the origins the consumer listed explicitly. Neither is independently configurable, which is what
 * stops a base-path change from silently breaking the login and stops a token being attached
 * merely because a URL appeared somewhere in site content.
 */

import { PyOidcAuthClient } from "@freva-org/ts-oidc-auth-client";
import { PortalSessionStorage } from "./auth-storage.js";
import type { AuthBridge, AuthRuntime } from "../runtime.js";

let bridge: AuthBridge | undefined;
let client: PyOidcAuthClient | undefined;

export function createAuth(runtime: AuthRuntime): AuthBridge {
  if (bridge) return bridge;
  let current: string | null = null;

  client = new PyOidcAuthClient({
    authBaseUrl: runtime.authBaseUrl,
    redirectUri: runtime.redirectUri,
    storage: new PortalSessionStorage(),
    security: {
      allowedResourceOrigins: runtime.allowedResourceOrigins,
      allowedRedirectUris: [runtime.redirectUri],
    },
    onEvent: (event) => {
      if (event.type === "session-cleared") {
        current = null;
        reflectSignedIn(false);
      }
    },
  });

  bridge = {
    token: () => current,
    login: () => {
      void client?.login({ next: window.location.pathname + window.location.search });
    },
    logout: () => {
      void client?.logout();
    },
  };

  void client
    .getToken({ refresh: "auto" })
    .then((token) => {
      current = token?.accessToken ?? null;
      reflectSignedIn(Boolean(current));
    })
    .catch(() => {
      current = null;
      reflectSignedIn(false);
    });

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
