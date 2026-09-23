/**
 * Where the credential rests.
 *
 * The auth client deliberately has no default: choosing this is a deployment decision.
 * `MemoryStorage` is the most hardened option and the wrong one here, because the callback route
 * IS a top-level navigation - a token saved in memory is gone the moment the callback redirects
 * back to the page the visitor came from.
 *
 * So: `sessionStorage`, per tab, cleared when the tab closes. In broker mode the bearer is also
 * the refresh credential, so the client's browser-readable-refresh warning is expected and is the
 * trade being made; a deployment that cannot accept it should run a server-managed (bff)
 * transport instead, which this storage does not pretend to be.
 */

import type { ClearReason, StoredToken, TokenStorage } from "@freva-org/ts-oidc-auth-client";

const KEY = "portal:auth:token";

export class PortalSessionStorage implements TokenStorage {
  readonly kind = "custom" as const;
  readonly persistent = true;
  readonly lifecycleIdentity = "per-tab" as const;

  private readonly listeners = new Set<(token: StoredToken | null) => void>();

  load(): StoredToken | null {
    try {
      const raw = window.sessionStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as StoredToken) : null;
    } catch {
      return null;
    }
  }

  save(token: StoredToken): void {
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify(token));
    } catch {
      // A browser that refuses storage degrades to a re-authentication.
    }
    this.notify(token);
  }

  clear(_reason?: ClearReason): void {
    try {
      window.sessionStorage.removeItem(KEY);
    } catch {
      // Nothing to do: the value is already unreachable.
    }
    this.notify(null);
  }

  subscribe(listener: (token: StoredToken | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(token: StoredToken | null): void {
    for (const listener of this.listeners) {
      try {
        listener(token);
      } catch {
        // One bad listener must not break the others.
      }
    }
  }
}
