import { describe, it, expect, afterEach } from "vitest";
import { DEFAULT_COOKIE_NAME, defaultGetAuthHeaders, normalizeUrl } from "../src/internal/http";

function setCookie(value: string): void {
  // happy-dom exposes a writable document.cookie.
  document.cookie = value;
}

function clearCookies(): void {
  for (const c of document.cookie.split(";")) {
    const name = c.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

afterEach(() => {
  clearCookies();
});

describe("defaultGetAuthHeaders", () => {
  it("exposes the expected cookie name", () => {
    expect(DEFAULT_COOKIE_NAME).toBe("freva_auth_token=");
  });

  it("returns a Bearer header when the auth cookie is present", () => {
    setCookie("freva_auth_token=abc123");
    expect(defaultGetAuthHeaders()).toEqual({ Authorization: "Bearer abc123" });
  });

  it("strips surrounding quotes from the cookie value", () => {
    setCookie('freva_auth_token="quoted-token"');
    expect(defaultGetAuthHeaders()).toEqual({ Authorization: "Bearer quoted-token" });
  });

  it("returns an empty object when the cookie is absent", () => {
    setCookie("some_other=1");
    expect(defaultGetAuthHeaders()).toEqual({});
  });

  it("returns an empty object when the cookie value is empty", () => {
    setCookie("freva_auth_token=");
    expect(defaultGetAuthHeaders()).toEqual({});
  });
});

describe("normalizeUrl", () => {
  it("returns plain URLs unchanged", () => {
    expect(normalizeUrl("https://example.com/store.zarr")).toBe("https://example.com/store.zarr");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeUrl("  https://example.com/x  ")).toBe("https://example.com/x");
  });

  it("decodes a single-encoded URL", () => {
    expect(normalizeUrl("https%3A//example.com/store.zarr")).toBe("https://example.com/store.zarr");
  });

  it("decodes a double-encoded URL", () => {
    expect(normalizeUrl("https%253A%252F%252Fexample.com%252Fstore.zarr")).toBe(
      "https://example.com/store.zarr",
    );
  });

  it("passes non-string input straight through", () => {
    // @ts-expect-error exercising the runtime guard
    expect(normalizeUrl(undefined)).toBeUndefined();
  });
});
