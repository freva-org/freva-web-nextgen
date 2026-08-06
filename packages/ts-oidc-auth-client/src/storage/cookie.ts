import { fingerprint, jwtExp, nowSeconds } from "../jwt.js";
import { AuthError, StorageContractError } from "../token.js";
import { isLoopbackHost, strictBoolean, strictEnum } from "../url.js";
import type { ClearReason, StoredToken, TokenStorage } from "../types.js";

/** RFC 6265 cookie-octet: no CTLs, whitespace, dquote, comma, semicolon, backslash. */
const COOKIE_SAFE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/**
 * RFC 6265 §6.1 obliges user agents to support at least 4096 bytes per cookie
 * (name + value + attributes). Browsers enforce it by SILENTLY DROPPING the
 * write — the exact failure this class exists to make loud.
 */
const COOKIE_MAX_BYTES = 4096;

function byteLength(value: string): number {
  return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(value).length : value.length;
}

export interface CookieStorageOptions {
  /** Cookie name. Default "py_oidc_auth_token"; compat mode defaults to "freva_auth_token". */
  name?: string;
  path?: string; // default "/"
  /** Default: location.protocol === "https:". */
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None"; // default "Strict"
  /**
   * Align cookie Max-Age with the JWT exp (default true). Bounds the
   * persisted credential to the access lifetime: a browser reopened past exp
   * re-enters through the IDP SSO redirect instead of holding a stale-but-
   * refresh-capable JWT on disk.
   */
  maxAgeFromTokenExp?: boolean;
  /** Fixed Max-Age in seconds; used when maxAgeFromTokenExp is false. */
  maxAgeSeconds?: number;
  /**
   * "freva-web-single-token": interoperate with the existing freva-web
   * cookie — raw JWT value under "freva_auth_token", readable by the legacy
   * getTokenFromCookie().
   */
  compatibilityMode?: "freva-web-single-token";
  /**
   * REQUIRED. CookieStorage round-trips a single raw JWT, so on `load()` it
   * necessarily reports that value as BOTH the access token and the refresh
   * credential. That is only true under the py-oidc-auth broker contract,
   * where the server deliberately issues one JWT in both roles.
   *
   * Without this acknowledgement, `save()` and `load()` refuse: silently
   * manufacturing refresh capability for an access-only token would hand the
   * lifecycle a credential the server never granted.
   */
  acknowledgeBrokerSingleTokenContract?: boolean;
  /**
   * Permit `secure: false` on a non-loopback origin. The cookie holds a
   * refresh credential, so without `Secure` it is transmitted in cleartext on
   * any plain-http request to the host.
   */
  acknowledgeInsecureCookie?: boolean;
  /**
   * Permit construction on a plaintext, non-loopback http origin. Off by
   * default: without it the cookie (a refresh credential) rides every
   * same-origin request in cleartext.
   */
  allowInsecureTransport?: boolean;
}

/**
 * Stores the RAW broker JWT as the cookie value (JWT base64url charset is
 * cookie-safe). Host-only by construction: no `Domain` attribute exists in
 * the options at all.
 *
 * ## This is not "storage only"
 *
 * Sending an explicit `Authorization` header does not keep the cookie off the
 * wire, which is why this class lives behind the `/unsafe-compat` entry point.
 * Per RFC 6265 §5.4 the user agent attaches a cookie to EVERY request whose
 * host and path match, regardless of what this library does. With the default
 * `Path=/` on a same-site deployment, the refresh-capable JWT therefore
 * reaches every route on the origin, plus any middleware, proxy, or CDN in
 * front of it — and lands in their access logs. It is also readable by any
 * same-origin script, since a cookie created from JavaScript cannot be
 * HttpOnly. Being sent ambiently, it is also the shape CSRF exploits.
 *
 * It exists for one reason: interoperating with freva-web's existing
 * `getTokenFromCookie`. Prefer MemoryStorage or ServerManagedStorage
 * everywhere else.
 */
export class CookieStorage implements TokenStorage {
  readonly kind = "cookie" as const;
  readonly persistent = true;
  /** Declared, not inferred: see TokenStorage.lifecycleIdentity. */
  readonly lifecycleIdentity = "shared-credential" as const;

  readonly name: string;
  /** Passive metadata for diagnose() — reading these performs no I/O. */
  readonly acknowledgedBrokerSingleToken: boolean;
  readonly acknowledgedInsecureTransport: boolean;
  readonly acknowledgedInsecureCookie: boolean;
  private readonly path: string;
  private readonly secure: boolean;
  private readonly sameSite: "Strict" | "Lax" | "None";
  private readonly maxAgeFromTokenExp: boolean;
  private readonly maxAgeSeconds?: number;
  private readonly brokerContractAcknowledged: boolean;

  constructor(options: CookieStorageOptions = {}) {
    if (typeof options !== "object" || options === null) {
      throw new AuthError("CookieStorage: options must be an object.");
    }
    const o = options as Record<string, unknown>;
    // Runtime types, not TypeScript types: a plain-JS caller passing "false"
    // must never be read as an acknowledgement.
    const ackBroker = strictBoolean(
      o.acknowledgeBrokerSingleTokenContract,
      "CookieStorage.acknowledgeBrokerSingleTokenContract",
    );
    strictBoolean(o.allowInsecureTransport, "CookieStorage.allowInsecureTransport");
    strictBoolean(o.acknowledgeInsecureCookie, "CookieStorage.acknowledgeInsecureCookie");
    strictBoolean(o.maxAgeFromTokenExp, "CookieStorage.maxAgeFromTokenExp", true);
    if (o.secure !== undefined) strictBoolean(o.secure, "CookieStorage.secure");
    if (o.sameSite !== undefined) {
      strictEnum(o.sameSite, ["Strict", "Lax", "None"] as const, "CookieStorage.sameSite");
    }
    if (o.compatibilityMode !== undefined) {
      strictEnum(
        o.compatibilityMode,
        ["freva-web-single-token"] as const,
        "CookieStorage.compatibilityMode",
      );
    }
    if (o.maxAgeSeconds !== undefined) {
      if (
        typeof o.maxAgeSeconds !== "number" ||
        !Number.isFinite(o.maxAgeSeconds) ||
        o.maxAgeSeconds < 0 ||
        o.maxAgeSeconds > 34560000
      ) {
        throw new AuthError(
          "CookieStorage.maxAgeSeconds must be a finite number in [0, 400 days].",
        );
      }
    }
    if (o.name !== undefined && typeof o.name !== "string") {
      throw new AuthError("CookieStorage.name must be a string.");
    }
    if (o.path !== undefined && typeof o.path !== "string") {
      throw new AuthError("CookieStorage.path must be a string.");
    }
    // The README documents this as required; enforce it here rather than
    // letting a storage exist whose every operation throws while diagnose()
    // reports it as present.
    if (!ackBroker) {
      throw new AuthError(
        "CookieStorage requires { acknowledgeBrokerSingleTokenContract: true }. " +
          "It keeps a single raw JWT, so it is only correct where the server " +
          "issues one JWT as both access token and refresh credential.",
      );
    }
    this.name =
      options.name ??
      (options.compatibilityMode === "freva-web-single-token"
        ? "freva_auth_token"
        : "py_oidc_auth_token");
    this.path = options.path ?? "/";
    this.secure =
      options.secure ?? (typeof location !== "undefined" && location.protocol === "https:");
    this.sameSite = options.sameSite ?? "Strict";
    this.maxAgeFromTokenExp = options.maxAgeFromTokenExp ?? true;
    this.maxAgeSeconds = options.maxAgeSeconds;
    this.brokerContractAcknowledged = options.acknowledgeBrokerSingleTokenContract ?? false;
    this.acknowledgedBrokerSingleToken = this.brokerContractAcknowledged;
    this.acknowledgedInsecureTransport = !!options.allowInsecureTransport;
    this.acknowledgedInsecureCookie = !!options.acknowledgeInsecureCookie;

    if (!/^[\w!#$%&'*+.^`|~-]+$/.test(this.name)) {
      throw new AuthError(
        `CookieStorage: ${JSON.stringify(this.name)} is not a valid cookie name.`,
      );
    }
    // `Path` is interpolated straight into the Set-Cookie string, so any
    // attribute-delimiting character is an injection primitive: a path of
    // `"/; Domain=example.test"` would widen a host-only cookie to a whole
    // registrable domain.
    if (
      !this.path.startsWith("/") ||
      !/^[\x20-\x7E]*$/.test(this.path) ||
      /[;,\\"\s]/.test(this.path)
    ) {
      throw new AuthError(
        `CookieStorage: path must start with "/" and contain no control ` +
          `characters, whitespace, ";", ",", "\\" or quotes — those would ` +
          `inject additional cookie attributes. Got ${JSON.stringify(this.path)}.`,
      );
    }
    if (this.sameSite === "None" && !this.secure) {
      throw new AuthError("SameSite=None requires Secure.");
    }
    // Cookie-prefix contracts (RFC 6265bis §4.1.3). Honouring them is what
    // makes the prefix meaningful against cookie tossing from a sibling host.
    if (this.name.startsWith("__Host-")) {
      if (!this.secure || this.path !== "/") {
        throw new AuthError(
          '__Host- cookies require Secure and Path="/" (and no Domain, which ' +
            "this class never sets).",
        );
      }
    } else if (this.name.startsWith("__Secure-") && !this.secure) {
      throw new AuthError("__Secure- cookies require Secure.");
    }

    if (
      !this.secure &&
      !options.acknowledgeInsecureCookie &&
      typeof location !== "undefined" &&
      !isLoopbackHost(location.hostname)
    ) {
      throw new AuthError(
        "CookieStorage refuses to write a refresh-capable cookie without the " +
          "Secure attribute outside loopback: it would then be sent in " +
          "cleartext on any plain-http request to this host. Set secure: true, " +
          "or acknowledgeInsecureCookie: true to accept that exposure.",
      );
    }
    if (
      !options.allowInsecureTransport &&
      typeof location !== "undefined" &&
      location.protocol === "http:" &&
      !isLoopbackHost(location.hostname)
    ) {
      throw new AuthError(
        `CookieStorage refuses to run on the plaintext origin ${location.origin}. ` +
          "The cookie holds a refresh credential and RFC 6265 attaches it to " +
          "every matching request, so http exposes the whole session on the " +
          "wire. Use https, a loopback host, or pass " +
          "{ allowInsecureTransport: true } if you are deliberately testing " +
          "this misconfiguration.",
      );
    }
  }

  /**
   * Note: only the raw JWT survives a cookie round-trip. Token-response
   * metadata that is not a JWT claim (e.g. a future `refreshable: false`)
   * is NOT preserved across load() — CookieStorage is broker/auth-code
   * oriented by design.
   */
  load(): StoredToken | null {
    this.assertBrokerContract("load");
    const raw = this.readCookie();
    if (!raw) return null;
    const exp = jwtExp(raw);
    return {
      accessToken: raw,
      // Broker contract: one JWT, two roles.
      refreshToken: raw,
      tokenType: "Bearer",
      // 0 = unknown/expired: still usable as a refresh credential.
      expiresAt: exp ?? 0,
      accessTokenIsRefreshCredential: true,
      sessionVersion: fingerprint(raw),
    };
  }

  save(token: StoredToken): void {
    this.assertBrokerContract("save");
    // An access-only or explicitly non-refreshable token must never be stored
    // here: load() would hand it back as a refresh credential the server never
    // issued, and the lifecycle would then POST it to /token.
    if (token.refreshable === false) {
      throw new StorageContractError(
        "CookieStorage refuses a token marked refreshable=false: load() " +
          "cannot preserve that flag and would present it as refreshable.",
      );
    }
    if (token.refreshToken === undefined) {
      throw new StorageContractError(
        "CookieStorage refuses an access-only token: it stores one raw JWT " +
          "and load() would report it as the refresh credential too, " +
          "manufacturing capability the server did not grant. Use " +
          "MemoryStorage or ServerManagedStorage for split/access-only tokens.",
      );
    }
    if (typeof document === "undefined") return;
    // Only the raw access token survives a cookie round-trip. If the server
    // has moved to split tokens, silently persisting the access token and
    // re-loading it as `refreshToken` would claim refresh capability this
    // cookie does not hold — and would drop the real refresh token entirely.
    if (token.refreshToken !== undefined && token.refreshToken !== token.accessToken) {
      throw new StorageContractError(
        "CookieStorage cannot store a split access/refresh token pair: it " +
          "round-trips a single raw JWT, so the refresh token would be " +
          "discarded and the access token wrongly treated as refreshable. " +
          "Use ServerManagedStorage or MemoryStorage for split-token servers.",
      );
    }
    if (!COOKIE_SAFE.test(token.accessToken)) {
      // Better a loud failure than a silently truncated credential: raw
      // cookie writes cannot carry arbitrary opaque tokens.
      throw new AuthError(
        "CookieStorage stores the raw token as the cookie value, but this " +
          "token contains cookie-unsafe characters. Use MemoryStorage or " +
          "ServerManagedStorage for opaque/passthrough tokens.",
      );
    }
    let maxAge: number | undefined;
    if (this.maxAgeFromTokenExp && token.expiresAt > 0) {
      maxAge = Math.max(0, Math.floor(token.expiresAt - nowSeconds()));
    } else if (this.maxAgeSeconds !== undefined) {
      maxAge = this.maxAgeSeconds;
    }
    this.writeNamed(this.name, token.accessToken, maxAge);
  }

  clear(_reason?: ClearReason): void {
    if (typeof document === "undefined") return;
    this.writeNamed(this.name, "", 0);
  }

  /**
   * Write/read/delete round-trip using the SAME effective attributes as
   * save()/clear() (path, SameSite, Secure) — so diagnose() catches the real
   * misconfigurations, e.g. `Secure` on an http origin or a path that does
   * not cover the current page.
   */
  probe(): boolean {
    if (typeof document === "undefined") return false;
    const name = `__poa_probe_${Math.random().toString(36).slice(2)}`;
    this.writeNamed(name, "1", 60);
    const ok = document.cookie.split(";").some((c) => c.trim() === `${name}=1`);
    this.writeNamed(name, "", 0);
    return ok;
  }

  private assertBrokerContract(op: string): void {
    if (this.brokerContractAcknowledged) return;
    throw new StorageContractError(
      `CookieStorage.${op}() requires ` +
        "{ acknowledgeBrokerSingleTokenContract: true }. This storage keeps a " +
        "single raw JWT, so it can only be correct where the server issues one " +
        "JWT as both access token and refresh credential (py-oidc-auth broker " +
        "mode). It is legacy compatibility storage, not a general-purpose mode.",
    );
  }

  private readCookie(): string | null {
    if (typeof document === "undefined") return null;
    const prefix = `${this.name}=`;
    for (const part of document.cookie.split(";")) {
      const c = part.trim();
      if (c.startsWith(prefix)) {
        let value = c.slice(prefix.length).trim();
        // freva-web's reader strips accidental quoting; mirror that.
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        return value || null;
      }
    }
    return null;
  }

  private writeNamed(name: string, value: string, maxAge?: number): void {
    const attrs = [`${name}=${value}`, `Path=${this.path}`, `SameSite=${this.sameSite}`];
    if (maxAge !== undefined) attrs.push(`Max-Age=${maxAge}`);
    if (this.secure) attrs.push("Secure");
    const serialized = attrs.join("; ");
    // Only guard real writes: the delete path is short by construction, and
    // an oversized delete would be a guard bug, not a caller error.
    if (value.length > 0 && byteLength(serialized) > COOKIE_MAX_BYTES) {
      throw new AuthError(
        `CookieStorage: this token does not fit in a cookie (` +
          `${byteLength(serialized)} bytes including attributes, limit ` +
          `${COOKIE_MAX_BYTES}). Browsers drop an oversized cookie SILENTLY, ` +
          `which would strand the session on the next rotation. Broker JWTs ` +
          `grow with the number of roles — use MemoryStorage or ` +
          `ServerManagedStorage for this deployment.`,
      );
    }
    document.cookie = serialized;
  }
}
