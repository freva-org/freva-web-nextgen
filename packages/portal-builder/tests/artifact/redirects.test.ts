// `redirects:` for a site migrated into the portal.
//
// Waterpark's old public URLs - /storage_concepts/, /high-level-access/, /databrowser/,
// /examples/01_first_map/ … - move under /docs/ and the component routes. Each redirect is
// validated against the site being built, written into host-policy.json for the host, emitted as
// a static fallback page at the old path, and probed by host-check.

import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, codes, resolveFixture, tempRoot, writeSite } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { createPreviewServer } from "../../src/verify/preview.js";
import { hostCheck } from "../../src/verify/host-check.js";
import { verifyArtifact } from "../../src/verify/verify.js";
import { redirectLocation } from "../../src/model/redirects.js";

afterAll(cleanupFixtures);

const PAGE = (title: string): string => `---\ntitle: ${title}\n---\n\n# ${title}\n\nText.\n`;

function site(redirects: string, canonicalUrl?: string): string {
  const root = tempRoot("redirects-");
  writeSite(root, {
    ...(canonicalUrl ? { canonicalUrl } : {}),
    content: {
      "content/storage-concepts/index.md": PAGE("Storage concepts"),
      "content/storage-concepts/why-healpix.md": PAGE("Why HEALPix"),
      "content/high-level-access.md": PAGE("High-level access"),
      "content/examples/01_first_map.md": PAGE("A map of one month"),
      "downloads/notes.txt": "notes\n",
    },
    extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
  downloads:
    - root: ./downloads
      mount: /downloads/
services:
  dataApi:
    kind: databrowser
    baseUrl: https://data.example.org/api
  stacApi:
    kind: stac
    catalogUrl: https://stac.example.org/
components:
  data:
    kind: databrowser
    enabled: true
    service: dataApi
    route: /docs/databrowser/
  catalog:
    kind: stac-browser
    enabled: false
    service: stacApi
    route: /docs/stac-browser/
redirects:
${redirects}`,
  });
  return root;
}

const WATERPARK = `  - from: /storage_concepts/
    href: /docs/storage-concepts/
  - from: /storage_concepts/why-healpix/
    href: /docs/storage-concepts/why-healpix/
  - from: /high-level-access
    href: /docs/high-level-access/
  - from: /examples/01_first_map/
    href: /docs/examples/01_first_map/
    status: 308
  - from: /databrowser/
    component: data
  - from: /stac-browser/
    component: catalog
  - from: /home-page/
    landing: home
  - from: /newsletter/
    href: https://lists.example.org/subscription/form
`;

describe("resolving redirects", () => {
  it("resolves every target kind, and omits one to a disabled component", async () => {
    const { model, diagnostics } = await resolveFixture(site(WATERPARK));
    expect(codes(diagnostics.errors)).toEqual([]);
    const omitted = diagnostics.items.filter((d) => d.pointer === "/redirects/5");
    expect(codes(omitted)).toEqual(["FP1202"]);
    expect(model!.redirects.map((r) => [r.from, r.to, r.status, r.external, r.file])).toEqual([
      ["/storage_concepts/", "/docs/storage-concepts/", 301, false, "storage_concepts/index.html"],
      [
        "/storage_concepts/why-healpix/",
        "/docs/storage-concepts/why-healpix/",
        301,
        false,
        "storage_concepts/why-healpix/index.html",
      ],
      // Directory form, whether or not the author wrote the slash.
      [
        "/high-level-access/",
        "/docs/high-level-access/",
        301,
        false,
        "high-level-access/index.html",
      ],
      [
        "/examples/01_first_map/",
        "/docs/examples/01_first_map/",
        308,
        false,
        "examples/01_first_map/index.html",
      ],
      ["/databrowser/", "/docs/databrowser/", 301, false, "databrowser/index.html"],
      ["/home-page/", "/", 301, false, "home-page/index.html"],
      [
        "/newsletter/",
        "https://lists.example.org/subscription/form",
        301,
        true,
        "newsletter/index.html",
      ],
    ]);
  });

  it("carries the base path on both sides under a nested canonical URL", async () => {
    const { model } = await resolveFixture(
      site(WATERPARK, "https://portal.example.org/waterpark/"),
    );
    const first = model!.redirects[0]!;
    expect(first.fromPath).toBe("/waterpark/storage_concepts/");
    expect(first.to).toBe("/waterpark/docs/storage-concepts/");
    expect(first.file).toBe("storage_concepts/index.html");
  });

  it.each([
    [
      "a page of this site",
      "  - from: /docs/high-level-access/\n    href: /docs/storage-concepts/\n",
      /is a page of this site/,
    ],
    [
      "a path under a mount",
      "  - from: /downloads/old/\n    href: /docs/storage-concepts/\n",
      /under '\/downloads\/'/,
    ],
    [
      "a framework directory",
      "  - from: /_portal/x/\n    href: /docs/storage-concepts/\n",
      /under '\/_portal\/'/,
    ],
    [
      "the same path twice",
      "  - from: /old/\n    href: /docs/storage-concepts/\n  - from: /OLD/\n    href: /docs/high-level-access/\n",
      /redirected twice/,
    ],
    ["a mailto: target", "  - from: /contact/\n    href: mailto:help@example.org\n", /mailto/],
  ])("refuses %s", async (_what, yaml, message) => {
    const { diagnostics } = await resolveFixture(site(yaml));
    const errors = diagnostics.errors;
    expect(errors.length).toBeGreaterThan(0);
    if (message) {
      expect(codes(errors)).toContain("FP1224");
      expect(errors.map((d) => d.message).join(" ")).toMatch(message);
    }
  });

  it("cannot chain: a target that is another redirect's old path does not exist", async () => {
    const { diagnostics } = await resolveFixture(
      site(
        "  - from: /old-guide/\n    href: /docs/high-level-access/\n" +
          "  - from: /older-guide/\n    href: /old-guide/\n",
      ),
    );
    expect(codes(diagnostics.errors)).toEqual(["FP1201"]);
    expect(diagnostics.errors[0]!.pointer).toBe("/redirects/1");
  });

  it("refuses a target that does not exist, like any navigation link", async () => {
    const { diagnostics } = await resolveFixture(
      site("  - from: /old/\n    href: /docs/no-such-page/\n"),
    );
    expect(codes(diagnostics.errors)).toEqual(["FP1201"]);
  });

  it("is a closed object with exactly one target", async () => {
    const none = await resolveFixture(site("  - from: /old/\n"));
    expect(codes(none.diagnostics.errors)).toContain("FP1104");
    const two = await resolveFixture(
      site("  - from: /old/\n    landing: home\n    href: /docs/storage-concepts/\n"),
    );
    expect(codes(two.diagnostics.errors)).toContain("FP1104");
  });
});

describe("the Location a host answers with", () => {
  it("merges the request's query into the target's own, and keeps the fragment last", () => {
    expect(redirectLocation("/docs/new/", "?q=search")).toBe("/docs/new/?q=search");
    expect(redirectLocation("/docs/new/", "")).toBe("/docs/new/");
    // Concatenating would give `/new?fixed=1?q=search`, where `q` is no parameter.
    expect(redirectLocation("/new?fixed=1", "?q=search")).toBe("/new?fixed=1&q=search");
    // …and a fragment received the query inside it.
    expect(redirectLocation("https://lists.example.org/form?list=2#top", "?q=a&r=b")).toBe(
      "https://lists.example.org/form?list=2&q=a&r=b#top",
    );
    // The target's parameters are never overwritten; the request's are appended.
    expect(redirectLocation("/new?lang=en", "?lang=de")).toBe("/new?lang=en&lang=de");
  });
});

describe("the built artifact", () => {
  let server: Server | undefined;
  afterAll(async () => {
    if (server) await new Promise<void>((done) => server!.close(() => done()));
  });

  it("carries the policy, the fallback pages, and passes verify and host-check", async () => {
    const out = join(tempRoot("redirects-out-"), "site");
    const result = await buildFixture(site(WATERPARK), out);
    expect(result.diagnostics.errors).toEqual([]);

    const policy = JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8"));
    expect(policy.redirects[0]).toEqual({
      from: "/storage_concepts/",
      to: "/docs/storage-concepts/",
      status: 301,
      preserveQuery: true,
      fallback: "storage_concepts/index.html",
    });

    const page = readFileSync(join(out, "storage_concepts", "index.html"), "utf8");
    expect(page).toContain('<meta http-equiv="refresh" content="0; url=/docs/storage-concepts/">');
    expect(page).toContain(
      '<link rel="canonical" href="https://portal.example.org/docs/storage-concepts/">',
    );
    expect(page).toContain('<meta name="robots" content="noindex">');
    expect(page).not.toMatch(/<script|<style|style=/);
    // Listed and checksummed like every other file.
    expect(readFileSync(join(out, "checksums.sha256"), "utf8")).toContain(
      "storage_concepts/index.html",
    );
    expect(verifyArtifact(out).errors).toEqual([]);

    server = createPreviewServer({ dir: out, port: 0 });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;

    const moved = await fetch(`${base}storage_concepts?x=1`, { redirect: "manual" });
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("/docs/storage-concepts/?x=1");
    const permanent = await fetch(`${base}examples/01_first_map/`, { redirect: "manual" });
    expect(permanent.status).toBe(308);

    const bag = await hostCheck({ dir: out, url: base });
    expect(bag.errors.map((d) => d.message)).toEqual([]);
  }, 300_000);

  it("answers a percent-encoded old path: the policy and the fallback page use it decoded", async () => {
    // A request for /old%20page/ reaches a host - and the preview - as /old page/, and a static
    // server looks the fallback up by that name. The authored spelling must not survive into
    // either, or the redirect is a 404.
    const out = join(tempRoot("redirects-encoded-"), "site");
    const result = await buildFixture(
      site(`  - from: /old%20page/
    href: /docs/storage-concepts/
`),
      out,
    );
    expect(result.diagnostics.errors).toEqual([]);
    const policy = JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8"));
    expect(policy.redirects[0]).toMatchObject({
      from: "/old page/",
      fallback: "old page/index.html",
    });
    expect(existsSync(join(out, "old page", "index.html"))).toBe(true);
    expect(existsSync(join(out, "old%20page"))).toBe(false);
    expect(verifyArtifact(out).errors).toEqual([]);

    const preview = createPreviewServer({ dir: out, port: 0 });
    await new Promise<void>((done) => preview.listen(0, "127.0.0.1", done));
    try {
      const address = preview.address();
      const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
      for (const path of ["old%20page/", "old%20page"]) {
        const moved = await fetch(`${base}${path}`, { redirect: "manual" });
        expect(moved.status, path).toBe(301);
        expect(moved.headers.get("location")).toBe("/docs/storage-concepts/");
      }
      const bag = await hostCheck({ dir: out, url: base });
      expect(bag.errors.map((d) => d.message)).toEqual([]);
    } finally {
      await new Promise<void>((done) => preview.close(() => done()));
    }
  }, 300_000);

  it("keeps a target's own query and fragment through preview and host-check", async () => {
    const out = join(tempRoot("redirects-query-"), "site");
    const result = await buildFixture(
      site(
        "  - from: /newsletter/\n    href: https://lists.example.org/subscription/form?list=2#top\n",
      ),
      out,
    );
    expect(result.diagnostics.errors).toEqual([]);
    const preview = createPreviewServer({ dir: out, port: 0 });
    await new Promise<void>((done) => preview.listen(0, "127.0.0.1", done));
    const address = preview.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
    try {
      const response = await fetch(`${base}newsletter/?q=search`, { redirect: "manual" });
      expect(response.headers.get("location")).toBe(
        "https://lists.example.org/subscription/form?list=2&q=search#top",
      );
      expect((await hostCheck({ dir: out, url: base })).errors).toEqual([]);
    } finally {
      await new Promise<void>((done) => preview.close(() => done()));
    }

    // A host that concatenates the two query strings, which is the bug, fails host-check.
    const concatenating = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://x");
      if (url.pathname.startsWith("/newsletter")) {
        response.writeHead(301, {
          location: `https://lists.example.org/subscription/form?list=2${url.search}#top`,
        });
        response.end();
        return;
      }
      preview.emit("request", request, response);
    });
    await new Promise<void>((done) => concatenating.listen(0, "127.0.0.1", done));
    const other = concatenating.address();
    const bad = `http://127.0.0.1:${typeof other === "object" && other ? other.port : 0}/`;
    try {
      const messages = (await hostCheck({ dir: out, url: bad })).errors.map((d) => d.message);
      expect(messages.join(" ")).toMatch(/newsletter/);
    } finally {
      await new Promise<void>((done) => concatenating.close(() => done()));
    }
  }, 300_000);

  it("host-check accepts a target whose own query uses the name `probe`", async () => {
    // A probe named `probe` would turn a target's `?probe=existing` into `?probe=existing&probe=1`,
    // and `.get("probe")` would report a dropped query on a conforming host.
    const out = join(tempRoot("redirects-probe-"), "site");
    const result = await buildFixture(
      site("  - from: /old/\n    href: https://lists.example.org/form?probe=existing\n"),
      out,
    );
    expect(result.diagnostics.errors).toEqual([]);
    const preview = createPreviewServer({ dir: out, port: 0 });
    const listen = async (
      handler: (url: URL, response: ServerResponse) => boolean,
    ): Promise<{ url: string; close: () => Promise<void> }> => {
      const host = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://x");
        if (!handler(url, response)) preview.emit("request", request, response);
      });
      await new Promise<void>((done) => host.listen(0, "127.0.0.1", done));
      const address = host.address();
      return {
        url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`,
        close: () => new Promise<void>((done) => host.close(() => done())),
      };
    };
    const redirectTo = (location: (url: URL) => string) => (url: URL, response: ServerResponse) => {
      if (!url.pathname.startsWith("/old")) return false;
      response.writeHead(301, { location: location(url) });
      response.end();
      return true;
    };
    const messagesFor = async (
      handler: (url: URL, response: ServerResponse) => boolean,
    ): Promise<string[]> => {
      const host = await listen(handler);
      try {
        return (await hostCheck({ dir: out, url: host.url })).errors.map((d) => d.message);
      } finally {
        await host.close();
      }
    };

    // The preview server - a conforming host - passes, and so does a host that orders the merged
    // query differently.
    expect(await messagesFor(() => false)).toEqual([]);
    expect(
      await messagesFor(
        redirectTo((url) => `https://lists.example.org/form${url.search}&probe=existing`),
      ),
    ).toEqual([]);
    // A host whose request query replaces the target's loses `probe=existing`.
    expect(
      (await messagesFor(redirectTo((url) => `https://lists.example.org/form${url.search}`))).join(
        " ",
      ),
    ).toMatch(
      /whose query is not the target's merged with the request's \(expected '\?probe=existing&/,
    );
    // A host that drops the request's query is still caught as exactly that.
    expect(
      (await messagesFor(redirectTo(() => "https://lists.example.org/form?probe=existing"))).join(
        " ",
      ),
    ).toMatch(/dropped the query string/);
    // Even when it forwards a request parameter named `probe`.
    expect(
      (
        await messagesFor(redirectTo(() => "https://lists.example.org/form?probe=existing&probe=1"))
      ).join(" "),
    ).toMatch(/dropped the query string/);
  }, 300_000);

  it("host-check reports a host that serves the fallback page instead of redirecting", async () => {
    const out = join(tempRoot("redirects-fallback-"), "site");
    const result = await buildFixture(
      site("  - from: /storage_concepts/\n    href: /docs/storage-concepts/\n"),
      out,
    );
    expect(result.diagnostics.errors).toEqual([]);
    // A static host with no redirect support: the preview server, minus the policy.
    const preview = createPreviewServer({ dir: out, port: 0 });
    const plain = createServer((request, response) => {
      if ((request.url ?? "").startsWith("/storage_concepts/")) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(readFileSync(join(out, "storage_concepts", "index.html")));
        return;
      }
      preview.emit("request", request, response);
    });
    await new Promise<void>((done) => plain.listen(0, "127.0.0.1", done));
    const address = plain.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
    try {
      const bag = await hostCheck({ dir: out, url: base });
      expect(bag.errors.map((d) => d.message).join(" ")).toMatch(
        /returned 200 \(the fallback page\)/,
      );
    } finally {
      await new Promise<void>((done) => plain.close(() => done()));
    }
    expect(existsSync(join(out, "storage_concepts", "index.html"))).toBe(true);
  }, 300_000);
});
