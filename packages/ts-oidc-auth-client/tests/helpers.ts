import { fingerprint } from "../src/jwt.js";
import type { StoredToken } from "../src/types.js";

export function b64url(obj: unknown): string {
  // Mirror the server: JSON -> UTF-8 bytes -> base64url. A bare btoa() would
  // encode U+00DF as one latin-1 byte and throw outright on emoji/CJK.
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Unsigned-but-shaped JWT; the client never verifies signatures locally. */
export function makeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256", kid: "k1" })}.${b64url(claims)}.c2lnbmF0dXJl`;
}

export function tokenResponse(
  jwt: string,
  expires: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    access_token: jwt,
    token_type: "Bearer",
    expires,
    refresh_token: jwt,
    refresh_expires: expires + 30 * 24 * 3600,
    scope: "openid profile email",
    ...extra,
  };
}

/** A well-behaved bearer-from-endpoint response: access token only. */
export function accessOnlyResponse(jwt: string, expires: number): Record<string, unknown> {
  return {
    access_token: jwt,
    token_type: "Bearer",
    expires,
    scope: "openid profile email",
  };
}

export function jsonRes(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function stored(jwt: string, expiresAt: number): StoredToken {
  return {
    accessToken: jwt,
    refreshToken: jwt,
    tokenType: "Bearer",
    expiresAt,
    // The client recomputes sessionVersion from the access token at every
    // trust boundary, so fixtures must carry the real fingerprint too.
    sessionVersion: fingerprint(jwt),
  };
}

/**
 * Normalize a fetch call into a url + init-like view.
 *
 * The client passes an owned `Request` to fetchImpl - that is what preserves
 * method, headers, body and signal - so test doubles must read from the
 * Request rather than from a separate `init` argument.
 */
export function fetchView(
  input: RequestInfo | URL,
  init?: RequestInit,
): { url: string; init: RequestInit } {
  if (typeof input === "object" && input instanceof Request) {
    return {
      url: input.url,
      init: {
        method: input.method,
        headers: input.headers,
        redirect: input.redirect,
        credentials: input.credentials,
        cache: input.cache,
        ...(init ?? {}),
      },
    };
  }
  const url = typeof input === "string" ? input : (input as URL).href;
  return { url, init: init ?? {} };
}

/** Deterministic in-process BroadcastChannel for cross-tab tests. */
export class FakeBroadcastChannel {
  static registry = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(public readonly name: string) {
    const set = FakeBroadcastChannel.registry.get(name) ?? new Set();
    set.add(this);
    FakeBroadcastChannel.registry.set(name, set);
  }

  postMessage(data: unknown): void {
    for (const peer of FakeBroadcastChannel.registry.get(this.name) ?? []) {
      if (peer !== this) {
        peer.onmessage?.({ data } as MessageEvent);
      }
    }
  }

  close(): void {
    FakeBroadcastChannel.registry.get(this.name)?.delete(this);
  }

  static reset(): void {
    FakeBroadcastChannel.registry.clear();
  }
}

export function installFakeBroadcastChannel(): () => void {
  const prev = (globalThis as Record<string, unknown>).BroadcastChannel;
  (globalThis as Record<string, unknown>).BroadcastChannel = FakeBroadcastChannel;
  return () => {
    (globalThis as Record<string, unknown>).BroadcastChannel = prev;
    FakeBroadcastChannel.reset();
  };
}
