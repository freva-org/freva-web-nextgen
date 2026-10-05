/**
 * The portal's sign-in callback route: the shared callback (`../auth-relay.ts`) with this
 * deployment's same-tab sign-in.
 *
 * ORDER is the security property. The very first thing the page does is scrub the response out of
 * the address bar; only then does anything render. The document that loads this carries
 * `<meta name="referrer" content="no-referrer">` before any subresource, loads nothing
 * third-party, and the host is required by `host-policy.json` to send `no-store`,
 * `Referrer-Policy: no-referrer` and to redact the query string from its access log.
 *
 * The redirect URI is this origin plus the base path plus the callback path, worked out here at
 * run time: no host name is built into the page, so the same artifact signs in on a development
 * port, a staging host and production alike.
 */

import { PyOidcAuthClient } from "@freva-org/ts-oidc-auth-client";
import { browserEnv, callbackUrl, runCallback } from "../auth-relay.js";
import { PortalSessionStorage } from "./auth-storage.js";
import type { AuthRuntime } from "../runtime.js";

export async function runAuthCallback(runtime: AuthRuntime): Promise<void> {
  const env = browserEnv(document.querySelector<HTMLElement>("[data-auth-callback]"));
  const redirectUri = callbackUrl(env.origin, runtime.basePath, runtime.callbackPath);
  await runCallback(env, {
    basePath: runtime.basePath,
    home: { href: runtime.basePath, label: "Back to the portal" },
    sameTab: async (href) => {
      const client = new PyOidcAuthClient({
        authBaseUrl: runtime.authBaseUrl,
        redirectUri,
        storage: new PortalSessionStorage(),
        security: {
          allowedResourceOrigins: runtime.allowedResourceOrigins,
          allowedRedirectUris: [redirectUri],
          ...(runtime.expectedIssuer ? { expectedIssuer: runtime.expectedIssuer } : {}),
        },
      });
      // Validates state, PKCE and the issuer against this tab's own transaction, and takes it:
      // a second exchange of the same code has nothing to match.
      await client.handleCallback(href);
      // The return path, validated same-origin by the client; checked against the base path by
      // the caller.
      try {
        return client.consumeReturnPath();
      } catch {
        return null;
      }
    },
  });
}
