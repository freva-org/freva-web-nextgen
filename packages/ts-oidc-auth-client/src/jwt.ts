/**
 * JWT helpers. Decoding here is NON-AUTHORITATIVE: claims are used only for
 * scheduling (exp) and display. Authorization decisions belong to the server,
 * which verifies the RS256 signature against its own JWKS.
 */

export interface JwtClaims {
  exp?: number;
  iat?: number;
  jti?: string;
  sub?: string;
  [k: string]: unknown;
}

function base64UrlDecode(segment: string): string {
  const pad = segment.length % 4 === 2 ? "==" : segment.length % 4 === 3 ? "=" : "";
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Returns the decoded payload or null. Never throws. */
export function decodeJwtPayload(token: string): JwtClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2 || !parts[1]) return null;
    const json = JSON.parse(base64UrlDecode(parts[1]));
    return typeof json === "object" && json !== null ? (json as JwtClaims) : null;
  } catch {
    return null;
  }
}

/** Epoch-seconds `exp` claim, or null. */
export function jwtExp(token: string): number | null {
  const claims = decodeJwtPayload(token);
  return typeof claims?.exp === "number" ? claims.exp : null;
}

/** Tiny non-cryptographic fingerprint for cross-tab sync. Not a secret. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Expired (with skew folded in): the token should not be sent as a Bearer. */
export function isExpired(expiresAt: number, now: number, skewSeconds: number): boolean {
  return expiresAt <= now + skewSeconds;
}

/** Inside the proactive-refresh window (includes already-expired). */
export function isExpiring(expiresAt: number, now: number, bufferSeconds: number): boolean {
  return expiresAt - now <= bufferSeconds;
}

/**
 * 64-bit fingerprint (two independent FNV-1a passes) for sessionVersion.
 * Not a secret and not a security boundary - it drives the "did another tab
 * rotate?" comparison, where a 32-bit space collides often enough to make two
 * different tokens look identical in a long-lived app. Dot-free on purpose so
 * it can never look JWT-shaped to the cross-tab guard.
 */
export function fingerprint(input: string): string {
  return fnv1a(input) + fnv1a(`poa|${input}`);
}
