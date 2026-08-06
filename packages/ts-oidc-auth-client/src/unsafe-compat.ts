/**
 * Deliberately-unsafe compatibility entry point.
 *
 * Imported as `@freva-org/ts-oidc-auth-client/unsafe-compat` so that choosing
 * it is a visible line in the integrator's source and in code review, not a
 * name sitting in the main barrel next to the safe ones.
 *
 * ## Why CookieStorage lives here
 *
 * On a same-site deployment, cookie storage is also transport: per RFC 6265
 * §5.4 the user agent attaches a matching cookie to EVERY request to the host,
 * whatever this library does with `Authorization` headers. With the default
 * `Path=/`, a refresh-capable broker JWT therefore reaches every route on the
 * origin and every proxy, middleware and CDN in front of it - and their access
 * logs. It is additionally readable by any same-origin script, because a
 * cookie written from JavaScript cannot be HttpOnly.
 *
 * The one legitimate use is interoperating with freva-web's existing
 * `getTokenFromCookie` during migration phases 0–2. Everything else should use
 * `MemoryStorage` or `ServerManagedStorage` from the main entry point.
 */
export { CookieStorage, type CookieStorageOptions } from "./storage/cookie.js";
