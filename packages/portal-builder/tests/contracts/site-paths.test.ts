// Ambiguous paths are refused before anything is collapsed, and collisions do not depend on
// which spelling was registered first. `posix.normalize("/catalog/../admin/")` is `"/admin/"`,
// so a `..` check that runs after normalization finds nothing and accepts the escape.

import { describe, expect, it } from "vitest";
import {
  assertSafeSitePath,
  collisionKey,
  normalizeSitePath,
  PathViolation,
} from "../../src/config/paths.js";
import { applyPathOverride, RouteCollision, RouteRegistry } from "../../src/routes/derive.js";

describe("site path validation", () => {
  it.each([
    ["a raw dot-dot segment", "/catalog/../admin/"],
    ["a raw single-dot segment", "/catalog/./admin/"],
    ["a percent-encoded dot-dot segment", "/catalog/%2e%2e/admin/"],
    ["a percent-encoded separator", "/catalog%2Fadmin/"],
    ["an encoded backslash", "/catalog%5Cadmin/"],
    ["a literal backslash", "/catalog\\admin/"],
    ["an invalid percent escape", "/catalog/%zz/"],
    ["a control character", "/catalog/\u0001x/"],
    ["a query string", "/catalog/?x=1"],
    ["a fragment", "/catalog/#x"],
    ["a relative path", "catalog/"],
  ])("refuses %s", (_name, path) => {
    expect(() => assertSafeSitePath(path)).toThrow(PathViolation);
    expect(() => normalizeSitePath(path)).toThrow(PathViolation);
  });

  it("refuses a path that is not Unicode NFC", () => {
    // "e" plus a combining acute, rather than the composed character.
    expect(() => assertSafeSitePath("/café/")).toThrow(PathViolation);
  });

  it("accepts an ordinary path and adds the trailing slash", () => {
    expect(normalizeSitePath("/docs/guide")).toBe("/docs/guide/");
    expect(normalizeSitePath("/docs//guide//")).toBe("/docs/guide/");
    expect(normalizeSitePath("/")).toBe("/");
  });

  it("accepts a percent-encoded character that is not a separator or dot", () => {
    expect(normalizeSitePath("/docs/a%20b/")).toBe("/docs/a%20b/");
  });
});

describe("frontmatter path overrides", () => {
  it("keeps an override under its mount", () => {
    expect(applyPathOverride("/docs/", "/docs/elsewhere/")).toBe("/docs/elsewhere/");
  });

  it.each([
    ["a sibling mount", "/other/"],
    ["a dot-dot escape", "/docs/../admin/"],
    ["an encoded dot-dot escape", "/docs/%2e%2e/admin/"],
    ["a relative value", "docs/x/"],
  ])("refuses %s", (_name, override) => {
    expect(applyPathOverride("/docs/", override)).toBeUndefined();
  });
});

describe("route collisions are symmetric", () => {
  const pairs: [string, string, string][] = [
    ["exact duplicates", "/docs/guide/", "/docs/guide/"],
    ["case-only differences", "/docs/Guide/", "/docs/guide/"],
    ["percent-encoding differences", "/docs/a%20b/", "/docs/a b/"],
  ];

  for (const [name, first, second] of pairs) {
    it(`refuses ${name} in either insertion order`, () => {
      const forward = new RouteRegistry();
      forward.add(first, "a");
      expect(() => forward.add(second, "b")).toThrow(RouteCollision);

      const backward = new RouteRegistry();
      backward.add(second, "b");
      expect(() => backward.add(first, "a")).toThrow(RouteCollision);
    });
  }

  it("derives one key for both spellings of the same path", () => {
    expect(collisionKey("/docs/a%20b/")).toBe(collisionKey("/docs/a b/"));
    expect(collisionKey("/docs/Guide/")).toBe(collisionKey("/docs/guide/"));
    expect(collisionKey("/docs/guide/")).not.toBe(collisionKey("/docs/other/"));
  });

  it("still accepts genuinely different routes", () => {
    const registry = new RouteRegistry();
    registry.add("/docs/guide/", "a");
    registry.add("/docs/reference/", "b");
    expect(registry.paths).toEqual(["/docs/guide/", "/docs/reference/"]);
    expect(registry.has("/docs/Guide/")).toBe(true);
    expect(registry.owner("/docs/guide/")).toBe("a");
  });
});
