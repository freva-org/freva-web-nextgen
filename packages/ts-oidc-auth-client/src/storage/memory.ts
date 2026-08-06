import type { ClearReason, StoredToken, TokenStorage } from "../types.js";

/**
 * Hardened option: the token exists only as a value in this instance. Nothing
 * appears in any DevTools storage pane, and it dies with the tab. Recovery
 * after a reopen is a top-level redirect through the IDP, silent while its SSO
 * session lives. Tabs are independent sessions by design: this mode shares no
 * token across tabs.
 */
export class MemoryStorage implements TokenStorage {
  readonly kind = "memory" as const;
  readonly persistent = false;
  /** Declared, not inferred: see TokenStorage.lifecycleIdentity. */
  readonly lifecycleIdentity = "per-tab" as const;

  private current: StoredToken | null = null;
  private listeners = new Set<(t: StoredToken | null) => void>();

  load(): StoredToken | null {
    return this.current;
  }

  save(token: StoredToken): void {
    this.current = token;
    this.notify();
  }

  clear(_reason?: ClearReason): void {
    this.current = null;
    this.notify();
  }

  subscribe(listener: (t: StoredToken | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l(this.current);
      } catch {
        /* listener errors must not break auth */
      }
    }
  }
}
