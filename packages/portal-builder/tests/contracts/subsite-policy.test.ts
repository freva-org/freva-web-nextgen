// `static-docs-v1` implements what its schema says. `runtime.frameOrigins` and
// `runtime.connectOrigins` have to mean something: a collector that rejects every external
// reference before looking at either makes declaring an origin a no-op, and a `frame-src` that
// omits `'self'` blocks even the same-origin frame the inventory permits.
//
// These tests fix the meaning of each class of reference: a subresource is forbidden whatever
// the policy says, a connection and a frame are permitted exactly when the policy names their
// origin, and a same-origin frame is always permitted.

import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupFixtures,
  codes,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { inspectHtml } from "../../src/model/subsite-inventory.js";

afterAll(cleanupFixtures);

const SUBSITE = `trustedSubsites:
  - profile: static-docs-v1
    source: ./reference-docs
    mount: /reference/
    trust: active
    policy: ./policies/reference.json
`;

function policy(runtime: {
  connectOrigins?: string[];
  frameOrigins?: string[];
  workers?: "none" | "self";
}): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      profile: "static-docs-v1",
      entryPoints: ["index.html"],
      runtime: {
        connectOrigins: runtime.connectOrigins ?? [],
        frameOrigins: runtime.frameOrigins ?? [],
        workers: runtime.workers ?? "none",
      },
    },
    null,
    2,
  )}\n`;
}

function site(files: Record<string, string>, runtime: Parameters<typeof policy>[0] = {}): string {
  const root = tempRoot("portal-subsite-policy-");
  write(root, "policies/reference.json", policy(runtime));
  for (const [path, body] of Object.entries(files)) write(root, path, body);
  writeSite(root, { extra: SUBSITE });
  return root;
}

const page = (body: string): string =>
  `<!doctype html><html><head><title>Docs</title></head><body><h1>Docs</h1>${body}</body></html>`;

describe("the inventory separates classes of reference", () => {
  const MOUNT = "/reference/";
  const kinds = (html: string): string[] =>
    inspectHtml(html, "index.html", MOUNT).findings.map((finding) => finding.kind);

  it("calls an external stylesheet a subresource", () => {
    expect(kinds('<link rel="stylesheet" href="https://cdn.example.org/x.css">')).toEqual([
      "external-subresource",
    ]);
  });

  it("calls an external script a subresource", () => {
    expect(kinds('<script src="https://cdn.example.org/x.js"></script>')).toEqual([
      "external-subresource",
    ]);
  });

  it("calls an external iframe a frame", () => {
    expect(kinds('<iframe src="https://player.example.org/v/1"></iframe>')).toEqual([
      "external-frame",
    ]);
  });

  it("calls a preconnect a connection", () => {
    expect(kinds('<link rel="preconnect" href="https://api.example.org">')).toEqual([
      "external-connection",
    ]);
  });

  it("reports the browser-computed origin, not the reference text", () => {
    const findings = inspectHtml(
      '<iframe src="https://Player.Example.org:443/v/1?x=1#y"></iframe>',
      "index.html",
      MOUNT,
    ).findings;
    expect(findings[0]).toMatchObject({
      kind: "external-frame",
      origin: "https://player.example.org",
    });
  });

  it("says nothing about a same-origin frame", () => {
    expect(kinds('<iframe src="embedded.html"></iframe>')).toEqual([]);
  });
});

describe("external frames", () => {
  it("are refused when the policy declares no origin", async () => {
    const root = site({
      "reference-docs/index.html": page('<iframe src="https://player.example.org/v/1"></iframe>'),
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1405");
    expect(result.diagnostics.errors.map((d) => d.message).join("\n")).toContain(
      "runtime.frameOrigins",
    );
  });

  it("are accepted when the policy declares their exact origin", async () => {
    const root = site(
      {
        "reference-docs/index.html": page('<iframe src="https://player.example.org/v/1"></iframe>'),
      },
      { frameOrigins: ["https://player.example.org"] },
    );
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
  });

  it("are refused when a different origin is declared", async () => {
    const root = site(
      {
        "reference-docs/index.html": page('<iframe src="https://player.example.org/v/1"></iframe>'),
      },
      { frameOrigins: ["https://other.example.org"] },
    );
    expect(codes((await resolveFixture(root)).diagnostics)).toContain("FP1405");
  });

  it("are accepted same-origin with no declaration at all", async () => {
    const root = site({
      "reference-docs/index.html": page('<iframe src="embedded.html"></iframe>'),
      "reference-docs/embedded.html": page("<p>Embedded.</p>"),
    });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
  });

  it("must exist when they are same-origin", async () => {
    const root = site({
      "reference-docs/index.html": page('<iframe src="absent.html"></iframe>'),
    });
    expect(codes((await resolveFixture(root)).diagnostics)).toContain("FP1405");
  });
});

describe("external connections", () => {
  it("are refused when the policy declares no origin", async () => {
    const root = site({
      "reference-docs/index.html": page('<link rel="preconnect" href="https://api.example.org">'),
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1405");
    expect(result.diagnostics.errors.map((d) => d.message).join("\n")).toContain(
      "runtime.connectOrigins",
    );
  });

  it("are accepted when the policy declares their exact origin", async () => {
    const root = site(
      {
        "reference-docs/index.html": page('<link rel="preconnect" href="https://api.example.org">'),
      },
      { connectOrigins: ["https://api.example.org"] },
    );
    expect((await resolveFixture(root)).diagnostics.errors).toEqual([]);
  });

  it("do not make an external subresource acceptable", async () => {
    // The policy names the origin; the reference is still a stylesheet.
    const root = site(
      {
        "reference-docs/index.html": page(
          '<link rel="stylesheet" href="https://api.example.org/x.css">',
        ),
      },
      { connectOrigins: ["https://api.example.org"], frameOrigins: ["https://api.example.org"] },
    );
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1405");
    expect(result.diagnostics.errors.map((d) => d.message).join("\n")).toContain(
      "never for a subresource",
    );
  });
});

describe("declared origins", () => {
  it.each([
    ["a wildcard", "https://*.example.org"],
    ["a path", "https://api.example.org/v1"],
    ["credentials", "https://user:pass@api.example.org"],
    ["a fragment", "https://api.example.org/#x"],
    ["an explicit default port", "https://api.example.org:443"],
    ["an uppercase host", "https://API.example.org"],
    ["a trailing slash", "https://api.example.org/"],
  ])("refuse %s", async (_name, origin) => {
    const root = site(
      { "reference-docs/index.html": page("<p>Docs.</p>") },
      { connectOrigins: [origin] },
    );
    const result = await resolveFixture(root);
    // Either the schema refuses the spelling or the collector does; both are a refusal, and
    // neither silently normalizes it.
    expect(result.diagnostics.errors.length).toBeGreaterThan(0);
  });
});

describe("the emitted subsite CSP", () => {
  const cspFor = async (
    files: Record<string, string>,
    runtime: Parameters<typeof policy>[0],
  ): Promise<Record<string, string>> => {
    const root = site(files, runtime);
    const out = join(tempRoot("portal-subsite-csp-out-"), "site");
    const built = await buildFixture(root, out);
    expect(built.diagnostics.errors).toEqual([]);
    const host = JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8")) as {
      csp: { subsites: { directives: Record<string, string> }[] };
    };
    return host.csp.subsites[0]!.directives;
  };

  it("always permits same-origin frames", async () => {
    const directives = await cspFor(
      {
        "reference-docs/index.html": page('<iframe src="embedded.html"></iframe>'),
        "reference-docs/embedded.html": page("<p>Embedded.</p>"),
      },
      {},
    );
    expect(directives["frame-src"]).toBe("'self'");
    expect(directives["frame-src"]).not.toBe("'none'");
    // Permitting the frame and forbidding the framed page to be embedded are two halves of a
    // policy that contradict each other, and the browser enforces the stricter half.
    expect(directives["frame-ancestors"]).toBe("'self'");
  }, 120_000);

  it("adds the declared frame origins, sorted, after 'self'", async () => {
    const directives = await cspFor(
      {
        "reference-docs/index.html": page('<iframe src="https://player.example.org/v/1"></iframe>'),
      },
      { frameOrigins: ["https://player.example.org", "https://a.example.org"] },
    );
    expect(directives["frame-src"]).toBe("'self' https://a.example.org https://player.example.org");
  }, 120_000);

  it("adds the declared connect origins, sorted, after 'self'", async () => {
    const directives = await cspFor(
      {
        "reference-docs/index.html": page('<link rel="preconnect" href="https://api.example.org">'),
      },
      { connectOrigins: ["https://api.example.org", "https://a.example.org"] },
    );
    expect(directives["connect-src"]).toBe("'self' https://a.example.org https://api.example.org");
  }, 120_000);

  it("implements workers as exactly none or self", async () => {
    const none = await cspFor(
      { "reference-docs/index.html": page("<p>Docs.</p>") },
      {
        workers: "none",
      },
    );
    expect(none["worker-src"]).toBe("'none'");

    const self = await cspFor(
      { "reference-docs/index.html": page("<p>Docs.</p>") },
      {
        workers: "self",
      },
    );
    expect(self["worker-src"]).toBe("'self'");
  }, 240_000);
});
