/**
 * The generated auth callback route's script.
 *
 * ORDER is the security property. The very first thing this does is scrub the callback parameters
 * out of the address bar with `history.replaceState`; only then does anything render, and only
 * then does ordinary application code start. The document that loads this carries
 * `<meta name="referrer" content="no-referrer">` before any subresource, loads nothing
 * third-party, and the host is required by `host-policy.json` to send `no-store`,
 * `Referrer-Policy: no-referrer` and to redact the query string from its access log.
 *
 * A direct visit with no transaction in progress is a safe message and a link home, never a stack
 * trace and never a retry loop.
 */

import { PyOidcAuthClient } from "@freva-org/ts-oidc-auth-client";
import { PortalSessionStorage } from "./auth-storage.js";
import type { AuthRuntime } from "../runtime.js";

function scrub(): string {
  const href = window.location.href;
  const url = new URL(href);
  if (url.search || url.hash) {
    url.search = "";
    url.hash = "";
    window.history.replaceState(null, "", url.toString());
  }
  return href;
}

function say(state: "working" | "done" | "error", message?: string): void {
  const root = document.querySelector<HTMLElement>("[data-portal-callback]");
  if (!root) return;
  root.dataset.portalCallbackState = state;
  const target = root.querySelector<HTMLElement>("[data-portal-callback-message]");
  if (target && message) target.textContent = message;
}

export async function runAuthCallback(runtime: AuthRuntime): Promise<void> {
  // First client action, before any render.
  const originalHref = scrub();

  const client = new PyOidcAuthClient({
    authBaseUrl: runtime.authBaseUrl,
    redirectUri: runtime.redirectUri,
    storage: new PortalSessionStorage(),
    security: {
      allowedResourceOrigins: runtime.allowedResourceOrigins,
      allowedRedirectUris: [runtime.redirectUri],
    },
  });

  try {
    await client.handleCallback(originalHref);
  } catch (error) {
    say(
      "error",
      error instanceof Error && error.name === "LoginTransactionError"
        ? "This page completes a sign-in. Start from the portal and try again."
        : "Sign-in could not be completed. Start from the portal and try again.",
    );
    return;
  }

  // The stored return path is validated as same-origin by the auth client before it is handed
  // back; anything else falls back to the site root.
  let next = runtime.basePath;
  try {
    const stored = client.consumeReturnPath();
    if (typeof stored === "string" && stored.startsWith("/")) next = stored;
  } catch {
    next = runtime.basePath;
  }
  say("done", "Signed in. Returning to the portal.");
  window.location.replace(next);
}
