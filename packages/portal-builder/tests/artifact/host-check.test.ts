// Host conformance, checked against a server that really serves the artifact. `preview` is that
// server, which is the honest scope: it shows that `host-check` asks the right questions and
// that a conforming host answers them. It claims nothing about TLS, CDNs or access logs, which
// only a deployed target and `host-check` can settle.

import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite } from "../helpers/site.js";
import { createPreviewServer } from "../../src/verify/preview.js";
import { compareCsp, hostCheck, parseCsp } from "../../src/verify/host-check.js";

let out: string;
let server: Server;
let base: string;

beforeAll(async () => {
  const source = writeMatrixSite({ databrowser: true, stac: false, auth: true });
  out = join(tempRoot("portal-host-"), "site");
  const result = await buildFixture(source, out);
  expect(result.diagnostics.errors).toEqual([]);

  server = createPreviewServer({ dir: out, port: 0 });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  cleanupFixtures();
});

describe("a conforming host", () => {
  it("serves the root document and every deep link without a SPA fallback", async () => {
    const root = await fetch(base);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");

    const deep = await fetch(`${base}docs/guide/`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("Guide");

    const unknown = await fetch(`${base}definitely-missing/`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("Page not found");
  });

  it("redirects the non-slash directory form and preserves the query", async () => {
    const response = await fetch(`${base}docs/guide?probe=1`, { redirect: "manual" });
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/docs/guide/?probe=1");
  });

  it("applies the recorded cache classes", async () => {
    const manifest = JSON.parse(readFileSync(join(out, "portal-manifest.json"), "utf8")) as {
      files: { path: string; cacheClass: string }[];
    };
    const immutable = manifest.files.find((f) => f.cacheClass === "immutable");
    if (immutable) {
      const response = await fetch(`${base}${immutable.path}`);
      expect(response.headers.get("cache-control")).toContain("immutable");
    }
    const html = await fetch(base);
    expect(html.headers.get("cache-control")).not.toContain("immutable");
  });

  it("applies the auth callback's privacy headers", async () => {
    const response = await fetch(`${base}auth/callback/`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("passes host-check with no errors", async () => {
    const bag = await hostCheck({ dir: out, url: base });
    const errors = bag.errors.map((d) => d.message);
    expect(errors).toEqual([]);
  }, 60_000);

  it("reports a host that drops the download headers", async () => {
    // A second artifact whose manifest declares a download the preview server serves without
    // the required headers, so the check has something to fail on.
    const manifestPath = join(out, "portal-manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(original) as {
      files: { path: string; mimeType: string; cacheClass: string; contentDisposition?: string }[];
    };
    manifest.files.push({
      path: "index.html",
      mimeType: "text/html; charset=utf-8",
      cacheClass: "download",
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const bag = await hostCheck({ dir: out, url: base });
    expect(bag.errors.some((d) => d.message.includes("Content-Disposition"))).toBe(true);
    writeFileSync(manifestPath, original);
  }, 60_000);

  it("warns when the artifact is served at a URL it was not built for", async () => {
    const bag = await hostCheck({ dir: out, url: "https://elsewhere.example.org/" });
    expect(bag.warnings.some((d) => d.message.includes("canonical URL"))).toBe(true);
  }, 60_000);
});

describe("the deployed Content-Security-Policy", () => {
  const rootHeaders =
    (change: (headers: Headers) => void): typeof fetch =>
    async (input, init) => {
      const response = await fetch(input, init);
      if (String(input) !== base) return response;
      const headers = new Headers(response.headers);
      change(headers);
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };
  const served = async (): Promise<string> =>
    (await fetch(base)).headers.get("content-security-policy") ?? "";
  const check = async (change: (headers: Headers) => void) => {
    const bag = await hostCheck({ dir: out, url: base, fetchImpl: rootHeaders(change) });
    return {
      errors: bag.errors.map((d) => d.message).filter((m) => m.includes("Content-Security-Policy")),
      warnings: bag.warnings
        .map((d) => d.message)
        .filter((m) => m.includes("Content-Security-Policy")),
    };
  };

  it("is sent by a conforming host, exactly as recorded", async () => {
    const policy = JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8")) as {
      csp: { portal: Record<string, string> };
    };
    expect(await served()).toContain(`default-src ${policy.csp.portal["default-src"]}`);
    const { errors, warnings } = await check(() => {});
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  }, 60_000);

  it("is reported when the host sends none", async () => {
    const { errors } = await check((h) => h.delete("content-security-policy"));
    expect(errors.join("\n")).toMatch(/sends no Content-Security-Policy/);
  }, 60_000);

  it("is reported when the host only reports it", async () => {
    const policy = await served();
    const { errors } = await check((h) => {
      h.delete("content-security-policy");
      h.set("content-security-policy-report-only", policy);
    });
    expect(errors.join("\n")).toMatch(/only as Content-Security-Policy-Report-Only/);
  }, 60_000);

  it("is reported when a directive allows more than recorded", async () => {
    const policy = await served();
    const { errors } = await check((h) =>
      h.set(
        "content-security-policy",
        policy.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
      ),
    );
    expect(errors.join("\n")).toMatch(/weaker.*'script-src' also allows 'unsafe-inline'/);
  }, 60_000);

  it("is reported when a directive with no fallback is dropped", async () => {
    const policy = await served();
    const { errors } = await check((h) =>
      h.set(
        "content-security-policy",
        policy
          .split(";")
          .filter((part) => !part.trim().startsWith("frame-ancestors"))
          .join(";"),
      ),
    );
    expect(errors.join("\n")).toMatch(/does not restrict 'frame-ancestors'/);
  }, 60_000);

  it("is reported when the host adds a directive that widens a fallback", async () => {
    const policy = await served();
    const { errors } = await check((h) =>
      h.set("content-security-policy", `${policy}; script-src-elem *`),
    );
    expect(errors.join("\n")).toMatch(/'script-src-elem' also allows \*/);
  }, 60_000);

  it("accepts reporting directives and a second, stricter policy beside it", async () => {
    const policy = await served();
    const { errors } = await check((h) =>
      h.set("content-security-policy", `${policy}; report-uri /csp-report, default-src 'none'`),
    );
    expect(errors).toEqual([]);
  }, 60_000);

  it("only warns when the host is stricter than recorded", async () => {
    const policy = await served();
    const { errors, warnings } = await check((h) =>
      h.set("content-security-policy", policy.replace(/img-src 'self' data:/, "img-src 'self'")),
    );
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toMatch(/stricter.*'img-src' omits data:/);
  }, 60_000);

  it("only warns when the host blocks a directive outright with 'none'", async () => {
    const policy = await served();
    const { errors, warnings } = await check((h) =>
      h.set("content-security-policy", policy.replace(/img-src [^;]*/, "img-src 'none'")),
    );
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toMatch(/'img-src' blocks everything/);
  }, 60_000);

  it("accepts a directive the host adds that is no wider than its fallback", async () => {
    const policy = await served();
    const { errors, warnings } = await check((h) =>
      h.set("content-security-policy", `${policy}; object-src 'none'`),
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  }, 60_000);
});

describe("comparing a served policy with the recorded one, under CSP semantics", () => {
  const compare = (expected: Record<string, string>, served: string) =>
    compareCsp(expected, parseCsp(served));

  it("treats 'none' as the empty list, alone or beside other sources", () => {
    expect(compare({ "img-src": "'self' data:" }, "img-src 'none'")).toEqual({
      widened: [],
      narrowed: ["'img-src' blocks everything"],
    });
    expect(compare({ "img-src": "'self'" }, "img-src 'self' 'none'")).toEqual({
      widened: [],
      narrowed: [],
    });
  });

  it("lets a stricter frame-ancestors through as a narrowing", () => {
    expect(
      compare({ "frame-ancestors": "'self' https://portal.example" }, "frame-ancestors 'none'"),
    ).toEqual({
      widened: [],
      narrowed: ["'frame-ancestors' blocks everything"],
    });
  });

  it("follows fallbacks both ways", () => {
    expect(
      compare({ "default-src": "'none'" }, "default-src 'none'; object-src 'none'").widened,
    ).toEqual([]);
    expect(compare({ "default-src": "'none'", "img-src": "'self'" }, "default-src 'none'")).toEqual(
      {
        widened: [],
        narrowed: ["'img-src' blocks everything"],
      },
    );
    expect(
      compare(
        { "default-src": "'none'", "script-src": "'self'" },
        "default-src 'none'; script-src 'self'; script-src-elem 'self' https://cdn.example",
      ).widened,
    ).toEqual(["'script-src-elem' also allows https://cdn.example"]);
  });

  it("reports a dropped directive that has no fallback as unrestricted", () => {
    expect(
      compare({ "default-src": "'none'", "base-uri": "'none'" }, "default-src 'none'").widened,
    ).toEqual(["does not restrict 'base-uri'"]);
  });

  it("folds the case of keywords and schemes, but not of hashes", () => {
    expect(compare({ "img-src": "'self' data:" }, "img-src 'SELF' DATA:")).toEqual({
      widened: [],
      narrowed: [],
    });
    expect(compare({ "script-src": "'sha256-AbC='" }, "script-src 'SHA256-AbC='").widened).toEqual(
      [],
    );
    expect(compare({ "script-src": "'sha256-AbC='" }, "script-src 'sha256-abc='").widened).toEqual([
      "'script-src' also allows 'sha256-abc='",
    ]);
  });

  it("ignores reporting directives and directives a browser does not know", () => {
    expect(
      compare({ "default-src": "'none'" }, "default-src 'none'; report-uri /r; made-up-src *"),
    ).toEqual({
      widened: [],
      narrowed: [],
    });
  });

  it("counts removing the last hash or nonce beside 'unsafe-inline' as a widening", () => {
    const result = compare(
      { "script-src": "'self' 'unsafe-inline' 'nonce-abc'" },
      "script-src 'self' 'unsafe-inline'",
    );
    expect(result.widened).toEqual([
      "'script-src' allows any inline code: no hash or nonce is left to disable its 'unsafe-inline'",
    ]);
    expect(
      compare(
        { "default-src": "'self' 'unsafe-inline' 'sha256-AbC='" },
        "default-src 'self' 'unsafe-inline'",
      ).widened,
    ).toContain(
      "'default-src' allows any inline code: no hash or nonce is left to disable its 'unsafe-inline'",
    );
  });

  it("does not count removing one of several hashes as a widening", () => {
    expect(
      compare(
        { "script-src": "'unsafe-inline' 'sha256-AbC=' 'sha256-DeF='" },
        "script-src 'unsafe-inline' 'sha256-AbC='",
      ),
    ).toEqual({ widened: [], narrowed: ["'script-src' omits 'sha256-DeF='"] });
  });

  it("does not trip over directive names that are also object properties", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(() =>
        compare({ "default-src": "'none'" }, `default-src 'none'; ${name} *`),
      ).not.toThrow();
      expect(compare({ "default-src": "'none'" }, `default-src 'none'; ${name} *`)).toEqual({
        widened: [],
        narrowed: [],
      });
    }
  });
});
