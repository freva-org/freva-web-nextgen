import { describe, expect, it } from "vitest";
import { decodeJwtPayload, fingerprint, fnv1a, isExpired, isExpiring, jwtExp } from "../src/jwt.js";
import {
  InvalidTokenResponseError,
  classifyRefreshStatus,
  normalizeTokenResponse,
} from "../src/token.js";
import { makeJwt } from "./helpers.js";

const NOW = 1_750_000_000;

describe("jwt utilities", () => {
  it("decodes a payload round-trip including unicode", () => {
    const jwt = makeJwt({ sub: "janedoe", note: "u\u00df", exp: NOW + 60 });
    const claims = decodeJwtPayload(jwt);
    expect(claims?.sub).toBe("janedoe");
    expect(claims?.note).toBe("u\u00df");
    expect(jwtExp(jwt)).toBe(NOW + 60);
  });

  it("returns null on malformed input instead of throwing", () => {
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
    expect(decodeJwtPayload("a.!!!.c")).toBeNull();
    expect(decodeJwtPayload("")).toBeNull();
    expect(jwtExp(makeJwt({ sub: "x" }))).toBeNull(); // no exp claim
  });

  it("fingerprint is a stable, dot-free, 64-bit session version", () => {
    expect(fingerprint("token-a")).toBe(fingerprint("token-a"));
    expect(fingerprint("token-a")).not.toBe(fingerprint("token-b"));
    expect(fingerprint("token-a")).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint("token-a").startsWith(fnv1a("token-a"))).toBe(true);
    expect(fingerprint("token-a")).not.toContain(".");
  });

  it("fnv1a is stable and short", () => {
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
    expect(fnv1a("hello")).not.toBe(fnv1a("hellp"));
    expect(fnv1a("hello")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("expiry helpers fold skew and buffer correctly", () => {
    // exp 100s away: not expired (skew 30), but inside a 120s buffer.
    expect(isExpired(NOW + 100, NOW, 30)).toBe(false);
    expect(isExpiring(NOW + 100, NOW, 120)).toBe(true);
    // exp 20s away: expired under 30s skew.
    expect(isExpired(NOW + 20, NOW, 30)).toBe(true);
    // far future: neither.
    expect(isExpired(NOW + 3600, NOW, 30)).toBe(false);
    expect(isExpiring(NOW + 3600, NOW, 120)).toBe(false);
  });
});

describe("normalizeTokenResponse", () => {
  const jwt = makeJwt({ sub: "janedoe", exp: NOW + 999 });

  it("uses canonical epoch fields from py_oidc_auth.schema.Token", () => {
    const t = normalizeTokenResponse(
      {
        access_token: jwt,
        token_type: "Bearer",
        expires: NOW + 3600,
        refresh_token: jwt,
        refresh_expires: NOW + 7200,
        scope: "openid",
      },
      NOW,
    );
    expect(t.expiresAt).toBe(NOW + 3600);
    expect(t.refreshExpiresAt).toBe(NOW + 7200);
    expect(t.refreshToken).toBe(jwt);
    expect(t.scope).toBe("openid");
    expect(t.sessionVersion).toMatch(/^[0-9a-f]{16}$/);
  });

  it("accepts *_in second offsets", () => {
    const t = normalizeTokenResponse(
      { access_token: jwt, expires_in: 300, refresh_expires_in: 600 },
      NOW,
    );
    expect(t.expiresAt).toBe(NOW + 300);
    expect(t.refreshExpiresAt).toBe(NOW + 600);
    expect(t.tokenType).toBe("Bearer");
  });

  it("falls back to the JWT exp claim, then now+180", () => {
    const fromClaim = normalizeTokenResponse({ access_token: jwt }, NOW);
    expect(fromClaim.expiresAt).toBe(NOW + 999);
    const opaque = normalizeTokenResponse({ access_token: "opaque" }, NOW);
    expect(opaque.expiresAt).toBe(NOW + 180);
  });

  it("carries refreshable=false through; absent means undefined", () => {
    expect(normalizeTokenResponse({ access_token: jwt, refreshable: false }, NOW).refreshable).toBe(
      false,
    );
    expect(normalizeTokenResponse({ access_token: jwt }, NOW).refreshable).toBeUndefined();
  });

  it("throws on a missing access_token", () => {
    expect(() => normalizeTokenResponse({}, NOW)).toThrow(InvalidTokenResponseError);
  });
});

describe("classifyRefreshStatus", () => {
  it("only 401 is terminal; 5xx/429 transient; 400 config", () => {
    expect(classifyRefreshStatus(401)).toBe("terminal_invalid_session");
    expect(classifyRefreshStatus(503)).toBe("transient_server");
    expect(classifyRefreshStatus(429)).toBe("transient_server");
    expect(classifyRefreshStatus(400)).toBe("cors_or_config");
    expect(classifyRefreshStatus(418)).toBe("unknown");
  });
});
