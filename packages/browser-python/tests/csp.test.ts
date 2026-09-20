/**
 * The policy builder, and the fact that a host's input is INPUT.
 *
 * `contentSecurityPolicy()` takes origins from whoever deploys the package, and a CSP header is
 * a `;`-separated list of directives, so `dataOrigins: ["https://data.example; script-src *"]`
 * concatenated verbatim ends the header with a complete `script-src` granting everything. The
 * value usually arrives from a deployment config, an environment variable or a query parameter,
 * so "the host would not do that" is not the threat model. The rule: an origin is parsed with
 * `URL` and only its `.origin` is ever serialised; anything else is refused at build time.
 */
import { describe, expect, it } from "vitest";
import { CSP_DIRECTIVES, contentSecurityPolicy } from "../src/csp.js";

/** The values of one directive from a built header. */
const directive = (policy: string, name: string) =>
  policy
    .split("; ")
    .find((part) => part.startsWith(`${name} `))
    ?.slice(name.length + 1) ?? null;

describe("origins are parsed, not pasted", () => {
  it("keeps a legitimate origin", () => {
    const policy = contentSecurityPolicy({ dataOrigins: ["https://data.example"] });
    expect(directive(policy, "connect-src")).toBe("'self' https://data.example");
  });

  it("keeps only the origin, discarding a path a host happened to paste", () => {
    const policy = contentSecurityPolicy({ dataOrigins: ["https://data.example/zarr/store.zarr"] });
    expect(directive(policy, "connect-src")).toBe("'self' https://data.example");
  });

  it("REFUSES a value that would inject a second directive", () => {
    expect(() =>
      contentSecurityPolicy({ dataOrigins: ["https://data.example; script-src *"] }),
    ).toThrow(/origin/i);
  });

  it("refuses a scheme that has no origin", () => {
    expect(() => contentSecurityPolicy({ dataOrigins: ["javascript:alert(1)"] })).toThrow();
    expect(() => contentSecurityPolicy({ dataOrigins: ["data:text/html,x"] })).toThrow();
  });

  it("refuses an injected runtime origin too - script-src is the worst place for one", () => {
    expect(() =>
      contentSecurityPolicy({ runtimeOrigin: "https://cdn.example; script-src *" }),
    ).toThrow(/origin/i);
  });

  it("allows a wildcard host, which is a legitimate CSP source", () => {
    const policy = contentSecurityPolicy({ dataOrigins: ["https://*.example.com"] });
    expect(directive(policy, "connect-src")).toBe("'self' https://*.example.com");
  });

  it("a refused origin never reaches the header, even partly", () => {
    let policy = "";
    try {
      policy = contentSecurityPolicy({ dataOrigins: ["https://ok.example", "not an origin"] });
    } catch {
      // expected
    }
    expect(policy).toBe("");
  });
});

// Waterpark is the case this exists for: a science portal whose visitors open datasets from
// wherever the data happens to live, which cannot be enumerated at deployment time.
describe("broad network mode", () => {
  it("is off by default: connect-src stays 'self'", () => {
    expect(directive(contentSecurityPolicy(), "connect-src")).toBe("'self'");
  });

  it("widens ONLY connect-src, and only to https", () => {
    const policy = contentSecurityPolicy({ network: "https" });
    expect(directive(policy, "connect-src")).toBe("'self' https:");
    expect(directive(policy, "script-src")).toBe("'self' 'wasm-unsafe-eval'");
    expect(policy).not.toContain("default-src 'none'; script-src 'self' 'wasm-unsafe-eval' https:");
  });

  it("still refuses a wildcard: 'https:' is a scheme, not `*`", () => {
    expect(contentSecurityPolicy({ network: "https" })).not.toContain("*");
  });
});

// Whether this page may be framed is not this package's decision. The default says no, because a
// console that runs visitor-authored Python is a clickjacking target; a portal that embeds it in
// its own shell needs a way to say so without hand-editing the header.
describe("frame-ancestors is the host's call", () => {
  it("defaults to none", () => {
    expect(directive(contentSecurityPolicy(), "frame-ancestors")).toBe("'none'");
  });

  it("accepts 'self' and an origin, and validates the origin", () => {
    expect(
      directive(
        contentSecurityPolicy({ frameAncestors: ["'self'", "https://portal.example"] }),
        "frame-ancestors",
      ),
    ).toBe("'self' https://portal.example");
    expect(() =>
      contentSecurityPolicy({ frameAncestors: ["https://x.example; script-src *"] }),
    ).toThrow();
  });

  it("refuses 'none' mixed with anything else, which is a policy that means nothing", () => {
    // `frame-ancestors 'none' https://portal.example` is not a narrower policy than either half:
    // `'none'` is not a source but the ABSENCE of sources, so a browser reading a list holding
    // it alongside an origin has been handed a contradiction. Whichever way an engine resolves
    // it, the deployment does not know which it asked for - so it is refused here.
    expect(() => contentSecurityPolicy({ frameAncestors: ["'none'", "'self'"] })).toThrow(/'none'/);
    expect(() =>
      contentSecurityPolicy({ frameAncestors: ["https://portal.example", "'none'"] }),
    ).toThrow(/'none'/);
    // Alone, it is exactly the default and entirely legitimate.
    expect(
      directive(contentSecurityPolicy({ frameAncestors: ["'none'"] }), "frame-ancestors"),
    ).toBe("'none'");
  });

  it("an empty list is not a way to delete the directive", () => {
    expect(directive(contentSecurityPolicy({ frameAncestors: [] }), "frame-ancestors")).toBe(
      "'none'",
    );
  });
});

describe("the manifest itself", () => {
  it("has no wildcard anywhere, in any option combination", () => {
    const policy = contentSecurityPolicy({
      console: true,
      allowInlineStyles: true,
      network: "https",
      runtimeOrigin: "https://cdn.example",
      dataOrigins: ["https://data.example"],
      frameAncestors: ["'self'"],
    });
    expect(policy).not.toContain("*");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(directive(policy, "default-src")).toBe("'none'");
  });

  it("is data, so a deployment can render it rather than copy it", () => {
    expect(CSP_DIRECTIVES["default-src"]).toEqual(["'none'"]);
  });
});

/**
 * The portal side of a two-origin embedding. `default-src 'none'` means `frame-src` falls back
 * to it, so a portal whose policy came from this function could not frame the playground at
 * all. Naming that origin widens nothing about scripts, connections or styles.
 */
describe("frameSrc, for a portal that embeds a playground on another origin", () => {
  it("names the playground origin, and only it", () => {
    const policy = contentSecurityPolicy({ frameSrc: ["https://play.example"] });
    expect(policy).toContain("frame-src https://play.example");
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("*");
  });

  it("serialises to the origin, so a smuggled directive cannot ride along", () => {
    expect(() =>
      contentSecurityPolicy({ frameSrc: ["https://play.example; script-src *"] }),
    ).toThrow(/frameSrc/);
  });

  it("keeps a path or query out of the header", () => {
    expect(contentSecurityPolicy({ frameSrc: ["https://play.example/embed?x=1"] })).toContain(
      "frame-src https://play.example",
    );
  });

  it("is absent when nothing is embedded, so default-src 'none' still governs frames", () => {
    expect(contentSecurityPolicy({})).not.toContain("frame-src");
  });
});
