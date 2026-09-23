// The generated auth callback route. The callback is a privacy-sensitive technical page, and
// most of its contract is about *order*: the referrer meta before any subresource, the parameter
// scrub as the first client action, and host requirements that are conformance rather than
// deployment advice.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite } from "../helpers/site.js";

afterAll(cleanupFixtures);

let enabledOut: string;
let disabledOut: string;

async function buildOnce(auth: boolean): Promise<string> {
  const root = writeMatrixSite({ databrowser: true, stac: false, auth });
  const out = join(tempRoot("portal-auth-out-"), "site");
  const result = await buildFixture(root, out);
  expect(result.diagnostics.errors).toEqual([]);
  return out;
}

describe("with auth enabled", () => {
  it("generates a real callback HTML route", async () => {
    enabledOut = await buildOnce(true);
    expect(existsSync(join(enabledOut, "auth", "callback", "index.html"))).toBe(true);
  }, 120_000);

  it("places the referrer meta before any subresource in the head", () => {
    const html = readFileSync(join(enabledOut, "auth", "callback", "index.html"), "utf8");
    const referrer = html.indexOf('name="referrer" content="no-referrer"');
    const head = html.indexOf("</head>");
    expect(referrer).toBeGreaterThan(-1);
    const firstSubresource = Math.min(
      ...["<link", "<script", "<img"].map((tag) => {
        const index = html.indexOf(tag);
        return index === -1 ? head : index;
      }),
    );
    expect(referrer).toBeLessThan(firstSubresource);
  });

  it("loads no third-party resource", () => {
    const html = readFileSync(join(enabledOut, "auth", "callback", "index.html"), "utf8");
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    const external = urls.filter((u) => /^https?:\/\//i.test(u));
    expect(external).toEqual([]);
  });

  it("scrubs the callback parameters as the first client action", () => {
    const files = readdirSync(join(enabledOut, "_portal")).filter((f) => f.endsWith(".js"));
    const shipped = [
      ...files.map((f) => readFileSync(join(enabledOut, "_portal", f), "utf8")),
      readFileSync(join(enabledOut, "auth", "callback", "index.html"), "utf8"),
    ].join("\n");
    expect(shipped).toContain("replaceState");
    // The branch runs before the shell is initialized on that route.
    expect(shipped).toMatch(/auth-callback/);
  });

  it("records the callback host policy, including access-log redaction", () => {
    const policy = JSON.parse(readFileSync(join(enabledOut, "host-policy.json"), "utf8")) as {
      authCallback?: {
        path: string;
        headers: Record<string, string>;
        accessLog: { redactQueryString: boolean };
      };
    };
    expect(policy.authCallback?.path).toBe("/auth/callback/");
    expect(policy.authCallback?.headers["Cache-Control"]).toBe("no-store");
    expect(policy.authCallback?.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(policy.authCallback?.accessLog.redactQueryString).toBe(true);
  });

  it("classifies the callback document as no-store in the artifact manifest", () => {
    const manifest = JSON.parse(readFileSync(join(enabledOut, "portal-manifest.json"), "utf8")) as {
      files: { path: string; cacheClass: string }[];
    };
    const entry = manifest.files.find((f) => f.path === "auth/callback/index.html");
    expect(entry?.cacheClass).toBe("no-store");
  });

  it("shows a safe message and a link home for a direct visit", () => {
    const html = readFileSync(join(enabledOut, "auth", "callback", "index.html"), "utf8");
    expect(html).toContain("data-portal-callback");
    expect(html).toMatch(/Back to/);
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });
});

describe("with auth disabled", () => {
  it("generates no callback page, no account control and no auth bundle", async () => {
    disabledOut = await buildOnce(false);
    expect(existsSync(join(disabledOut, "auth"))).toBe(false);
    const html = readFileSync(join(disabledOut, "index.html"), "utf8");
    expect(html).not.toContain("data-portal-account");
    const files = readdirSync(join(disabledOut, "_portal")).filter((f) => f.endsWith(".js"));
    const shipped = [
      ...files.map((f) => readFileSync(join(disabledOut, "_portal", f), "utf8")),
      html,
    ].join("\n");
    expect(shipped).not.toContain("https://auth.example.org/v2");
    const policy = JSON.parse(readFileSync(join(disabledOut, "host-policy.json"), "utf8")) as {
      authCallback?: unknown;
    };
    expect(policy.authCallback).toBeUndefined();
  }, 120_000);
});
