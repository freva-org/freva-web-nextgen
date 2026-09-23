// One raw-path safety contract, applied everywhere, before anything parses. The table below is
// the contract's whole surface: a literal form, a once-encoded form, a mixed-case encoded form
// and a double-encoded form of each character that carries path structure. Every consumer of a
// path in the system is driven with that same table, so "safe" cannot mean one thing for a
// canonical URL and another for a manifest entry.
//
// The double-encoded row is why: `/docs/%252e%252e/admin/` decodes once to `/docs/%2e%2e/admin/`
// and twice to `/docs/../admin/`, so a validator that decodes a single time sees neither a dot
// segment nor an encoded one and accepts it.

import { describe, expect, it } from "vitest";
import {
  decodeSafePath,
  isSafeRawPath,
  parserPreservedPath,
  rawCollisionKey,
  rawPathReason,
  splitAuthoredUrl,
} from "../../src/config/raw-path.js";
import { assertSafeSitePath, collisionKey, normalizeSitePath } from "../../src/config/paths.js";
import {
  normalizeAuthBase,
  normalizeDatabrowserBase,
  normalizeStacCatalogUrl,
  parseCanonicalUrl,
} from "../../src/model/urls.js";
import { checkRole } from "../../src/verify/identity.js";
import { resolveReference } from "../../src/model/subsite-inventory.js";
import { RouteRegistry } from "../../src/routes/derive.js";

/** Precomposed and decomposed spellings of the same word, written by code point. */
const NFC_CAFE = "caf\u00e9";
const NFD_CAFE = "cafe\u0301";
/** A control character, written by code point so this file contains none. */
const CONTROL = "\u0001";

/** Every spelling of a path-structural character that a path may not contain. */
const AMBIGUOUS: { name: string; segment: string }[] = [
  { name: "literal dot-dot", segment: ".." },
  { name: "literal dot", segment: "." },
  { name: "once-encoded dot-dot", segment: "%2e%2e" },
  { name: "mixed-case encoded dot-dot", segment: "%2E%2e" },
  { name: "uppercase encoded dot-dot", segment: "%2E%2E" },
  { name: "double-encoded dot-dot", segment: "%252e%252e" },
  { name: "once-encoded separator", segment: "a%2fb" },
  { name: "uppercase encoded separator", segment: "a%2Fb" },
  { name: "double-encoded separator", segment: "a%252fb" },
  { name: "encoded backslash", segment: "a%5cb" },
  { name: "double-encoded backslash", segment: "a%255cb" },
  { name: "literal backslash", segment: "a\\b" },
  { name: "encoded percent", segment: "a%25b" },
  { name: "incomplete escape", segment: "a%2" },
  { name: "non-hex escape", segment: "a%zz" },
];

/** Paths that are fine, so the contract is not merely "refuse everything". */
const SAFE = [
  "/",
  "/docs/",
  "/docs/guide/",
  "/a-b_c/",
  "/docs/index.html",
  "/docs/caf%C3%A9/",
  "/docs/a+b/",
  "/docs/(parens)/",
];

describe("the raw-path contract", () => {
  it.each(SAFE)("accepts %s", (path) => {
    expect(rawPathReason(path)).toBeUndefined();
  });

  it.each(AMBIGUOUS)("refuses a $name", ({ segment }) => {
    expect(rawPathReason(`/docs/${segment}/admin/`)).toBeDefined();
  });

  it("refuses the double-encoded case that a single decode misses", () => {
    const path = "/docs/%252e%252e/admin/";
    // The demonstration, not just the verdict: one decode is not enough.
    expect(decodeURIComponent(path)).toBe("/docs/%2e%2e/admin/");
    expect(decodeURIComponent(decodeURIComponent(path))).toBe("/docs/../admin/");
    expect(rawPathReason(path)).toBeDefined();
  });

  it("refuses a control character and a non-NFC spelling", () => {
    expect(rawPathReason(`/docs/a${CONTROL}b/`)).toBeDefined();
    expect(rawPathReason(`/docs/${NFD_CAFE}/`)).toBeDefined();
    expect(rawPathReason(`/docs/${NFC_CAFE}/`)).toBeUndefined();
  });

  it("does not normalize an unsafe value into a safe-looking one", () => {
    expect(() => normalizeSitePath("/docs/../admin/")).toThrow();
    expect(() => normalizeSitePath("/docs/%2e%2e/admin/")).toThrow();
    expect(() => assertSafeSitePath("/docs/%252e%252e/admin/")).toThrow();
  });

  it("settles after one decoding round for every accepted path", () => {
    for (const path of SAFE) {
      const once = decodeSafePath(path);
      expect(decodeSafePath(once)).toBe(once);
    }
  });
});

describe("canonical URLs", () => {
  it("accepts an ordinary base path", () => {
    const parsed = parseCanonicalUrl("https://portal.example.org/site/");
    expect(parsed.ok).toBe(true);
    expect(parsed.basePath).toBe("/site/");
  });

  it.each([
    ["a literal dot-dot", "https://portal.example.org/site/../admin/"],
    ["an encoded dot-dot", "https://portal.example.org/site/%2e%2e/admin/"],
    ["a mixed-case encoded dot-dot", "https://portal.example.org/site/%2E%2e/admin/"],
    ["a double-encoded dot-dot", "https://portal.example.org/site/%252e%252e/admin/"],
    ["an encoded separator", "https://portal.example.org/a%2fb/"],
    ["an encoded backslash", "https://portal.example.org/a%5cb/"],
    ["a literal backslash", "https://portal.example.org/a\\b/"],
  ])("refuses %s before the parser can remove it", (_name, url) => {
    const parsed = parseCanonicalUrl(url);
    expect(parsed.ok).toBe(false);
    // The parser really would have erased it; that is why the order matters.
    expect(parsed.basePath).toBe("/");
  });

  it("demonstrates what the parser does to the same inputs", () => {
    expect(new URL("https://portal.example.org/site/../admin/").pathname).toBe("/admin/");
    expect(new URL("https://portal.example.org/site/%2e%2e/admin/").pathname).toBe("/admin/");
  });

  it("refuses a pathname the parser would resolve differently", () => {
    // A defence that does not depend on the rules above catching every form.
    expect(parserPreservedPath("/site/../admin/", "/admin/")).toBe(false);
    expect(parserPreservedPath("/site//a/", "/site/a/")).toBe(true);
  });
});

describe("service URLs", () => {
  const kinds: [string, (raw: string) => { ok: boolean }][] = [
    ["databrowser", (raw) => normalizeDatabrowserBase(raw)],
    ["auth", (raw) => normalizeAuthBase(raw)],
    ["stac", (raw) => normalizeStacCatalogUrl(raw)],
  ];

  it.each(kinds)("accepts an ordinary root-relative path for the %s kind", (_kind, check) => {
    expect(check("/api/freva-nextgen/service").ok).toBe(true);
  });

  it.each(kinds)("accepts an ordinary absolute URL for the %s kind", (_kind, check) => {
    expect(check("https://api.example.org/v1").ok).toBe(true);
  });

  for (const [kind, check] of kinds) {
    it.each(AMBIGUOUS)(`refuses a $name in a root-relative ${kind} URL`, ({ segment }) => {
      expect(check(`/api/${segment}/admin`).ok).toBe(false);
    });

    it.each(AMBIGUOUS)(`refuses a $name in an absolute ${kind} URL`, ({ segment }) => {
      expect(check(`https://api.example.org/v1/${segment}/admin`).ok).toBe(false);
    });
  }
});

describe("manifest verification", () => {
  it.each(AMBIGUOUS)("refuses a $name in a recorded site path", ({ segment }) => {
    expect(checkRole("sitePath", `/docs/${segment}/`)).toBeDefined();
  });

  it.each(AMBIGUOUS)("refuses a $name in a recorded artifact path", ({ segment }) => {
    expect(checkRole("artifactPath", `docs/${segment}/index.html`)).toBeDefined();
  });

  it("accepts the paths a real artifact contains", () => {
    expect(checkRole("sitePath", "/docs/guide/")).toBeUndefined();
    expect(checkRole("artifactPath", "docs/guide/index.html")).toBeUndefined();
  });
});

describe("generated routes", () => {
  it.each(AMBIGUOUS)("refuses a $name as a registered route", ({ segment }) => {
    const registry = new RouteRegistry();
    expect(() => registry.add(`/docs/${segment}/`, "landing home")).toThrow();
  });

  it("detects a collision whichever path is registered first", () => {
    const forward = new RouteRegistry();
    forward.add("/docs/caf%C3%A9/", "first");
    expect(() => forward.add(`/docs/${NFC_CAFE}/`, "second")).toThrow();

    const reverse = new RouteRegistry();
    reverse.add(`/docs/${NFC_CAFE}/`, "first");
    expect(() => reverse.add("/docs/caf%C3%A9/", "second")).toThrow();
  });

  it("derives the same collision key from both spellings", () => {
    expect(collisionKey("/docs/caf%C3%A9/")).toBe(collisionKey(`/docs/${NFC_CAFE}/`));
    expect(rawCollisionKey("/Docs/A/")).toBe(rawCollisionKey("/docs/a/"));
  });
});

describe("trusted subsite references", () => {
  const MOUNT = "/reference/";

  it("resolves an ordinary local reference", () => {
    expect(resolveReference("assets/theme.css", "index.html", MOUNT)).toEqual({
      kind: "local",
      path: "assets/theme.css",
    });
  });

  it.each(AMBIGUOUS.filter((row) => !row.name.startsWith("literal dot")))(
    "refuses a $name in a subsite reference",
    ({ segment }) => {
      const resolved = resolveReference(`${segment}/theme.css`, "index.html", MOUNT);
      expect(resolved.kind).not.toBe("local");
    },
  );

  it("resolves a literal dot segment and then proves containment", () => {
    // `../style.css` is how every documentation generator writes a sibling path, so it is
    // resolved rather than refused - and then checked.
    expect(resolveReference("../style.css", "api/index.html", MOUNT)).toEqual({
      kind: "local",
      path: "style.css",
    });
    expect(resolveReference("./theme.css", "index.html", MOUNT)).toEqual({
      kind: "local",
      path: "theme.css",
    });
    expect(resolveReference("../../outside.css", "api/index.html", MOUNT).kind).toBe("escapes");
  });

  it("still refuses an encoded dot segment, which nobody writes by hand", () => {
    expect(resolveReference("%2e%2e/style.css", "api/index.html", MOUNT).kind).toBe("escapes");
    expect(resolveReference("%252e%252e/style.css", "api/index.html", MOUNT).kind).toBe("escapes");
  });
});

describe("the authored-URL splitter", () => {
  it("returns the pathname as written, not as resolved", () => {
    expect(splitAuthoredUrl("https://x.org/site/../admin/")?.path).toBe("/site/../admin/");
    expect(splitAuthoredUrl("https://x.org")?.path).toBe("/");
    expect(splitAuthoredUrl("https://x.org/a?b=c#d")).toMatchObject({
      path: "/a",
      query: "b=c",
      fragment: "d",
    });
  });

  it("refuses something that is not an absolute URL", () => {
    expect(splitAuthoredUrl("/site/")).toBeUndefined();
    expect(splitAuthoredUrl("not a url")).toBeUndefined();
  });
});

describe("the contract is one contract", () => {
  it("gives the same verdict for the same value at every consumer", () => {
    for (const { segment } of AMBIGUOUS) {
      const sitePath = `/docs/${segment}/`;
      const verdicts = [
        isSafeRawPath(sitePath),
        checkRole("sitePath", sitePath) === undefined,
        parseCanonicalUrl(`https://portal.example.org${sitePath}`).ok,
        normalizeDatabrowserBase(sitePath).ok,
      ];
      expect(new Set(verdicts).size, `${segment} is judged inconsistently`).toBe(1);
      expect(verdicts[0]).toBe(false);
    }
  });
});
