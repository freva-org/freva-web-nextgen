// The separate-origin playground artifact: what is generated, what it may run, and - the half
// that is easy to claim and hard to check - what is NOT in either half's module graph. The point
// of the two-origin arrangement is a boundary, and a boundary is only real if it is measured from
// both sides, so these tests read the built artifact: the child document's script graph, the
// parent pages' script graph, and the deployment list of files that cross to the other origin.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot, write } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { writeConsumerSite } from "../helpers/consumer.js";
import type { BuildResult } from "../../src/artifact/index.js";

afterAll(cleanupFixtures);

const ORIGIN = "https://py.example.org";

async function build(
  options: Parameters<typeof writeConsumerSite>[0],
  prefix: string,
): Promise<{ out: string; result: BuildResult }> {
  const root = writeConsumerSite(options);
  const out = join(tempRoot(prefix), "site");
  return { out, result: await buildFixture(root, out) };
}

/** Every `src`/`href` the document asks for on load, artifact-relative. */
function referenced(html: string): string[] {
  return [...html.matchAll(/(?:src|href)\s*=\s*"(\/[^"]+)"/g)].map((m) =>
    (m[1] ?? "").replace(/^\/+/, ""),
  );
}

/**
 * The transitive closure of one page's own scripts, over the bundler's recorded edges. Static AND
 * dynamic, because "we import it lazily" does not answer "is this code in this page's graph": a
 * dynamic import is still a module this page can reach and bytes this origin serves.
 */
function closure(result: BuildResult, html: string): Set<string> {
  const byFile = new Map((result.graph?.chunks ?? []).map((c) => [c.file, c]));
  const seen = new Set<string>();
  const queue = referenced(html).filter((f) => f.endsWith(".js"));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const chunk = byFile.get(file);
    for (const next of [...(chunk?.imports ?? []), ...(chunk?.dynamicImports ?? [])]) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/** Every module id reachable from a page, through the chunks in its closure. */
function modulesOf(result: BuildResult, files: Set<string>): string[] {
  const byFile = new Map((result.graph?.chunks ?? []).map((c) => [c.file, c]));
  return [...files].flatMap((file) => byFile.get(file)?.modules ?? []);
}

describe("a portal with no playground origin", () => {
  it("generates no playground document at all", async () => {
    const { out, result } = await build({ python: true }, "portal-pg-none-");
    expect(result.diagnostics.errors).toEqual([]);
    expect(existsSync(join(out, "playground-origin"))).toBe(false);
    expect(result.playgroundDeployment).toBeUndefined();
  }, 300_000);
});

describe("the generated playground artifact", () => {
  it("registers every example with an id, dataset, title, source and verified digest", async () => {
    const { out, result } = await build(
      { python: true, playgroundOrigin: ORIGIN },
      "portal-pg-manifest-",
    );
    expect(result.diagnostics.errors).toEqual([]);
    const html = readFileSync(join(out, "playground-origin", "index.html"), "utf8");
    const block = /id="playground-examples"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    expect(block).toBeTruthy();
    const examples = JSON.parse((block?.[1] ?? "").replaceAll("\\u003c", "<")) as {
      id: string;
      datasetId: string;
      title: string;
      source: string;
      sha256: string;
    }[];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(example.id).toMatch(/^[^/]+\/[^/]+\/[^/]+$/);
      expect(example.datasetId.length).toBeGreaterThan(0);
      expect(example.title.length).toBeGreaterThan(0);
      expect(example.source.length).toBeGreaterThan(0);
      // Checked as the child checks it at load, against the source it travels with: a manifest
      // registering any source under any digest makes the wire check compare two invented numbers.
      expect(createHash("sha256").update(example.source, "utf8").digest("hex")).toBe(
        example.sha256,
      );
    }
    // Every id is unique, which is what makes `resolve(id, digest)` a lookup rather than a guess.
    expect(new Set(examples.map((e) => e.id)).size).toBe(examples.length);
  }, 300_000);

  it("carries its configuration and manifest as data, with no inline script", async () => {
    const { out } = await build({ python: true, playgroundOrigin: ORIGIN }, "portal-pg-inline-");
    const html = readFileSync(join(out, "playground-origin", "index.html"), "utf8");
    // Every `<script>` is an external module or an `application/json` data block: an inline
    // executable one would need `unsafe-inline`, the one thing the child's policy must not have.
    for (const tag of html.matchAll(/<script\b([^>]*)>/g)) {
      const attrs = tag[1] ?? "";
      expect(
        /type="application\/json"/.test(attrs) || /\bsrc="/.test(attrs),
        `inline script in the playground document: <script${attrs}>`,
      ).toBe(true);
    }
    const config = /id="playground-config"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    const parsed = JSON.parse(config?.[1] ?? "{}") as Record<string, unknown>;
    expect(parsed.hostOrigin).toBe("https://portal.example.org");
    // Version 3 carries the four bounded operations - transcript, clear transcript, clear
    // history, restart - a message shape an older peer would misread, hence the bump.
    expect(parsed.protocolVersion).toBe(3);
    // Not the portal. The child is handed what it needs and nothing that describes the site.
    expect(Object.keys(parsed).sort()).toEqual([
      "hostOrigin",
      "profile",
      "protocolVersion",
      "runtimeIndexUrl",
    ]);
  }, 300_000);

  it("has no portal shell, navigation or island entry in its own graph", async () => {
    const { out, result } = await build(
      { python: true, playgroundOrigin: ORIGIN },
      "portal-pg-child-graph-",
    );
    const html = readFileSync(join(out, "playground-origin", "index.html"), "utf8");
    const modules = modulesOf(result, closure(result, html));
    for (const forbidden of [
      "builder:client/shell.ts",
      "builder:client/components/dataset-tree.ts",
      "builder:client/components/python-playground.ts",
      "builder:client/components/databrowser.ts",
      "builder:generated/portal-entry",
    ]) {
      expect(modules.filter((m) => m.startsWith(forbidden))).toEqual([]);
    }
    // …and it does have the three things it exists for.
    expect(modules.some((m) => m.startsWith("builder:client/playground-origin.ts"))).toBe(true);
    expect(modules.some((m) => m.includes("browser-python") && m.includes("embed"))).toBe(true);
    expect(modules.some((m) => m.includes("browser-python") && m.includes("console"))).toBe(true);
  }, 300_000);
});

describe("the parent, in framed mode", () => {
  it("has no console, terminal library, Worker or interpreter in its own graph", async () => {
    // Measured from the emitted page, not the source: `loadChunks` takes a `framed` flag, and a
    // parent that can reach the console through any edge, static or dynamic, serves it anyway.
    const { out, result } = await build(
      { python: true, playgroundOrigin: ORIGIN },
      "portal-pg-parent-graph-",
    );
    const html = readFileSync(join(out, "index.html"), "utf8");
    const files = closure(result, html);
    const modules = modulesOf(result, files);

    const offenders = modules.filter((m) =>
      /jquery|prism|browser-python[^"]*\/(console|worker)|pyodide/i.test(m),
    );
    expect(offenders, `the framed parent can reach ${offenders.slice(0, 5).join(", ")}`).toEqual(
      [],
    );

    // The Worker is emitted beside the graph, so it is checked by file name as well as by module.
    expect([...files].filter((f) => f.includes("browser-python.worker"))).toEqual([]);

    // What it DOES have: the window chrome and the embed host, and nothing else of the playground.
    expect(modules.some((m) => m.includes("freva-client-terminal"))).toBe(true);
    expect(modules.some((m) => m.includes("browser-python") && m.includes("embed"))).toBe(true);
  }, 300_000);

  it("names the playground origin in frame-src and nowhere else", async () => {
    const { out } = await build({ python: true, playgroundOrigin: ORIGIN }, "portal-pg-csp-");
    const policy = JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8")) as {
      csp: Record<string, unknown>;
    };
    const text = JSON.stringify(policy.csp);
    expect(text).toContain(ORIGIN);
    // The policy document's shape is the host policy's business; what matters here is that the
    // origin appears as a FRAME source and that nothing else was widened for it.
    expect(text).toMatch(new RegExp(`frame-src[^\\]]*${ORIGIN.replace(/[.]/g, "\\.")}`));
    expect(text).not.toContain("wasm-unsafe-eval");
  }, 300_000);
});

describe("the deployment description", () => {
  it("lists exactly the files the playground origin needs, and no portal code", async () => {
    const { out, result } = await build(
      { python: true, playgroundOrigin: ORIGIN },
      "portal-pg-deploy-",
    );
    const deployment = result.playgroundDeployment;
    expect(deployment).toBeTruthy();
    expect(deployment?.entry).toBe("playground-origin/index.html");
    expect(deployment?.origin).toBe(ORIGIN);

    for (const file of deployment?.files ?? []) {
      expect(existsSync(join(out, ...file.split("/"))), `${file} is listed and missing`).toBe(true);
    }
    // The Worker reaches the child through no import edge - it is emitted beside the graph - so
    // a closure that does not name it explicitly deploys a playground that cannot run.
    expect(deployment?.files.some((f) => f.includes("browser-python.worker"))).toBe(true);

    // And nothing of the portal travels with it: the parent's own entry chunk is not in the list.
    const parentHtml = readFileSync(join(out, "index.html"), "utf8");
    const parentEntry = referenced(parentHtml).filter((f) => f.endsWith(".js"));
    expect(parentEntry.length).toBeGreaterThan(0);
    for (const file of parentEntry) expect(deployment?.files).not.toContain(file);
  }, 300_000);

  it("writes a child policy that frames only the portal and needs no inline anything", async () => {
    const { out } = await build({ python: true, playgroundOrigin: ORIGIN }, "portal-pg-headers-");
    const deployment = JSON.parse(
      readFileSync(join(out, "playground-origin", "deploy.json"), "utf8"),
    ) as { headers: Record<string, string> };
    const csp = deployment.headers["Content-Security-Policy"] ?? "";
    expect(csp).toContain("frame-ancestors https://portal.example.org");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("'wasm-unsafe-eval'");
    // `style-src` stays `'self'`: no `<style>` element, no external stylesheet. The one grant is
    // `style-src-attr`, because jQuery Terminal sets style ATTRIBUTES on the markup it builds, and
    // `browser-tests/python-real-interpreter.mjs` proves that load-bearing by removing it.
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    // `'wasm-unsafe-eval'` permits compiling WebAssembly and nothing else; bare `'unsafe-eval'`
    // would permit `eval` and `new Function`, which the interpreter does not need.
    expect(csp).not.toContain(" 'unsafe-eval'");
    const readme = readFileSync(join(out, "playground-origin", "README.md"), "utf8");
    expect(readme).toContain(ORIGIN);
    expect(readme).toContain("deploy.json");
  }, 300_000);
});

describe("two origins on one portal", () => {
  it("is a build error rather than a silent winner", async () => {
    const root = writeConsumerSite({
      python: true,
      playgroundOrigin: ORIGIN,
      secondBlock: true,
      secondBlockPython:
        "    python:\n" +
        "      enabled: true\n" +
        "      profile: minimal\n" +
        "      autostart: never\n" +
        "      maxSessions: 2\n" +
        "      playgroundOrigin: https://other.example.org\n" +
        "      terminal:\n" +
        "        style: freva-client-terminal\n" +
        "        osControls: auto\n" +
        "        alwaysOnTop: true\n" +
        "        rememberAppearance: true\n",
    });
    const out = join(tempRoot("portal-pg-conflict-"), "site");
    const result = await buildFixture(root, out);
    const codes = result.diagnostics.errors.map((d) => d.code);
    // FP1215 is the page-level disagreement and FP1216 the portal-level one; either is a refusal
    // to guess, which is the property under test.
    expect(codes.some((c) => c === "FP1215" || c === "FP1216")).toBe(true);
  }, 300_000);
});

// `write` is imported for the helper's use.
void write;

describe("a self-hosted runtime", () => {
  const MIRROR = "https://runtime.example.org/pyodide/v314.0.6/full/";

  it("puts the mirror's origin in the child's script-src as well as connect-src", async () => {
    // BOTH, because `pyodide.mjs` is a module the interpreter IMPORTS, not only bytes it fetches:
    // naming the mirror in `connect-src` alone gives a playground that downloads its own runtime
    // and is refused permission to run it. `browser-tests/python-real-interpreter.mjs` measures it.
    const root = writeConsumerSite({
      python: true,
      playgroundOrigin: ORIGIN,
      runtimeIndexUrl: MIRROR,
    });
    const out = join(tempRoot("portal-pg-mirror-"), "site");
    const result = await buildFixture(root, out);
    expect(result.diagnostics.errors).toEqual([]);
    const deployment = JSON.parse(
      readFileSync(join(out, "playground-origin", "deploy.json"), "utf8"),
    ) as { headers: Record<string, string> };
    const csp = deployment.headers["Content-Security-Policy"] ?? "";
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' https://runtime.example.org");
    expect(csp).toContain("connect-src 'self' https://runtime.example.org");
    // The pinned CDN is not named at all: a policy for a runtime this artifact does not fetch.
    expect(csp).not.toContain("cdn.jsdelivr.net");
  }, 300_000);

  it("names the mirror in a same-origin portal's own policy, and not the CDN", async () => {
    const root = writeConsumerSite({ python: true, runtimeIndexUrl: MIRROR });
    const out = join(tempRoot("portal-pg-mirror-local-"), "site");
    const result = await buildFixture(root, out);
    expect(result.diagnostics.errors).toEqual([]);
    const policy = readFileSync(join(out, "host-policy.json"), "utf8");
    expect(policy).toContain("https://runtime.example.org");
    expect(policy).not.toContain("cdn.jsdelivr.net");
  }, 300_000);

  it("hands the child its own runtime, so the deployed document does not guess", async () => {
    const root = writeConsumerSite({
      python: true,
      playgroundOrigin: ORIGIN,
      runtimeIndexUrl: MIRROR,
    });
    const out = join(tempRoot("portal-pg-mirror-child-"), "site");
    await buildFixture(root, out);
    const html = readFileSync(join(out, "playground-origin", "index.html"), "utf8");
    const config = /id="playground-config"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    const parsed = JSON.parse(config?.[1] ?? "{}") as Record<string, unknown>;
    expect(parsed.runtimeIndexUrl).toBe(MIRROR);
  }, 300_000);

  it("falls back to the pinned CDN when no mirror is configured", async () => {
    const root = writeConsumerSite({ python: true, playgroundOrigin: ORIGIN });
    const out = join(tempRoot("portal-pg-cdn-"), "site");
    await buildFixture(root, out);
    const deployment = JSON.parse(
      readFileSync(join(out, "playground-origin", "deploy.json"), "utf8"),
    ) as { headers: Record<string, string> };
    expect(deployment.headers["Content-Security-Policy"]).toContain("cdn.jsdelivr.net");
  }, 300_000);
});
