// The notebook in the portal's own artifact (`notebook.deployment: same-origin`): no
// `playgroundOrigin`, the site at `<basePath>notebook/` with a policy of its own replacing the
// portal's there, the shared sign-in callback at `<basePath>auth/callback/`, one preview serving
// all of it, and separate-origin deployments untouched.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { writeConsumerSite } from "../helpers/consumer.js";
import { fakeSite } from "../helpers/notebook-site.js";
import { pageMetaPolicyProblem } from "@freva-org/jupyterlite-freva-kernel/prepare";
import { resolveModel } from "../../src/model/resolve.js";
import { planNotebook, withMetaPolicy, type NotebookPlan } from "../../src/model/notebook.js";
import { portalBaseUrl } from "../../src/model/python-playground.js";
import { portalBaseSource } from "../../client/portal-base.js";
import { verifyArtifact } from "../../src/verify/verify.js";
import {
  authCallbackEntries,
  describeAuthCallbacks,
  notebookCallbackOf,
} from "../../src/model/auth-callbacks.js";
import { createPreviewServer } from "../../src/verify/preview.js";

afterAll(cleanupFixtures);

const ASSISTANT =
  "    assistant:\n      climateclaw:\n        host: https://freva.example.org\n" +
  "        defaultModel: gpt-test\n";

interface SiteOptions {
  assistant?: boolean;
  /** The portal's own sign-in (`components.login`). The consumer site has it on. */
  login?: boolean;
  basePath?: string;
  meta?: boolean;
  block?: boolean;
  starter?: string;
  /** A console on its own origin beside the same-origin notebook (no `consoleInPage`). */
  consoleOrigin?: string;
}

function site(options: SiteOptions = {}): string {
  const root = writeConsumerSite({
    // With a console on its own origin, the documentation's snippets are its examples.
    python: !options.consoleOrigin,
    playground: {
      profile: "minimal",
      ...(options.starter ? { initialSource: options.starter } : {}),
      ...(options.consoleOrigin ? { playgroundOrigin: options.consoleOrigin } : {}),
      extraYaml:
        (options.consoleOrigin ? "" : "  consoleInPage: true\n") +
        "  notebook:\n    enabled: true\n    deployment: same-origin\n" +
        (options.meta ? "    metaPolicy: true\n" : "") +
        (options.assistant ? ASSISTANT : ""),
    },
    runnableDocs: true,
  });
  const config = join(root, "portal.yaml");
  let text = readFileSync(config, "utf8");
  if (options.login === false) {
    text = text.replace(/( {2}login:\n {4}kind: auth\n {4}enabled:) true/, "$1 false");
  }
  if (options.basePath) {
    text = text.replace(
      "canonicalUrl: https://portal.example.org/",
      `canonicalUrl: https://portal.example.org${options.basePath}`,
    );
  }
  writeFileSync(config, text);
  if (options.block) {
    const landing = join(root, "landings", "home.yaml");
    writeFileSync(landing, `${readFileSync(landing, "utf8")}  - type: notebook\n    view: files\n`);
  }
  return root;
}

const resolve = (root: string) =>
  resolveModel({
    sourceRoot: root,
    configPath: join(root, "portal.yaml"),
    release: false,
    skipNotebook: true,
  });

async function planFor(root: string): Promise<NotebookPlan> {
  const resolved = await resolve(root);
  return withMetaPolicy(
    planNotebook(
      resolved.portalPlayground!,
      resolved.notebookPlayground!,
      resolved.notebookSeeds ?? [],
      resolved.notebookLab,
      resolved.notebookIdentity,
    ),
    resolved.portalPlayground!,
    resolved.notebookPlayground!,
    resolved.notebookLab,
  );
}

const hostPolicyOf = (out: string) =>
  JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8")) as {
    csp: {
      portal: Record<string, string>;
      paths?: { match: { prefix?: string; path?: string }; directives: Record<string, string> }[];
    };
    headers: { match: Record<string, string>; set: Record<string, string> }[];
  };

describe("a same-origin notebook", () => {
  it("needs no playgroundOrigin, says what it gives up, and plans from the portal's own origin", async () => {
    const resolved = await resolve(site({ assistant: true, block: true }));
    expect(resolved.diagnostics.errors).toEqual([]);
    expect(resolved.diagnostics.items.some((d) => d.code === "FP1235")).toBe(false);
    const notice = resolved.diagnostics.items.find((d) => d.code === "FP1239");
    expect(notice?.severity).toBe("info");
    expect(notice?.hint).toMatch(/share one origin and its storage/);
    expect(notice?.hint).toMatch(/github\.io/);
    expect(resolved.portalPlayground?.notebookSameOrigin).toBe(true);
    // No child playground: nothing is deployed elsewhere.
    expect(resolved.model!.playground).toBeUndefined();
    expect(resolved.notebookPlayground?.origin).toBe("https://portal.example.org");
    expect(resolved.notebookLab?.playgroundOrigin).toBe("https://portal.example.org");
    // The landing frames it origin-relatively: the same build works wherever it is served.
    const block = resolved.model!.landings[0]!.blocks.find((b) => b.type === "notebook")!;
    expect(block.notebook).toMatchObject({ src: "/notebook/tree/index.html", sameOrigin: true });
    expect(resolved.model!.sameOriginNotebook).toEqual({
      callbackPath: "/auth/callback/",
      emitCallback: false,
      metaPolicy: false,
    });
  });

  it("is refused without either origin, as before (FP1235); metaPolicy alone changes nothing", async () => {
    const root = writeConsumerSite({
      python: true,
      playground: {
        profile: "minimal",
        extraYaml: "  notebook:\n    enabled: true\n    metaPolicy: true\n",
      },
      runnableDocs: true,
    });
    const resolved = await resolve(root);
    expect(resolved.diagnostics.errors.find((d) => d.code === "FP1235")?.hint).toMatch(
      /deployment: same-origin/,
    );
    expect(resolved.diagnostics.warnings.find((d) => d.code === "FP1239")?.pointer).toBe(
      "/pythonPlayground/notebook/metaPolicy",
    );
  });

  it("follows the base path: block, settings, callback and the kernel's starter", async () => {
    const root = site({
      assistant: true,
      block: true,
      basePath: "/showroom/",
      starter: 'print(PORTAL_BASE_URL + "python-wheels/")',
    });
    const resolved = await resolve(root);
    expect(resolved.diagnostics.errors).toEqual([]);
    const block = resolved.model!.landings[0]!.blocks.find((b) => b.type === "notebook")!;
    expect(block.notebook?.src).toBe("/showroom/notebook/tree/index.html");
    const plan = await planFor(root);
    expect(plan.lab!.overrides["@freva-org/jupyterlite-climateclaw:plugin"]!.callbackPath).toBe(
      "/showroom/auth/callback/",
    );
    // The kernel and the console in the pages run the starter as written, and are told the base.
    expect(String(plan.settings.starter).trim()).toBe('print(PORTAL_BASE_URL + "python-wheels/")');
    expect(plan.settings.portalBaseUrl).toBe("/showroom/");
    const page = resolved.model!.routes.find((r) => r.python)!;
    expect(page.python!.initialSource).toBe(plan.settings.starter);
    expect(page.python!.portalBaseUrl).toBe("/showroom/");
  });

  it("is published at notebook/ in the portal's artifact, under its own policy, and verified", async () => {
    const root = site({ block: true });
    const plan = await planFor(root);
    const out = join(tempRoot("portal-same-nb-"), "site");
    const result = await buildFixture(root, out, { notebookDir: fakeSite(plan) });
    expect(result.diagnostics.errors).toEqual([]);
    expect(result.playgroundDeployment).toBeUndefined();
    expect(existsSync(join(out, "playground-origin"))).toBe(false);
    expect(existsSync(join(out, "notebook", "NOTEBOOK-INVENTORY.json"))).toBe(true);
    const checksums = readFileSync(join(out, "checksums.sha256"), "utf8");
    expect(checksums).toMatch(/ {2}notebook\/notebooks\/index\.html$/m);
    const policy = hostPolicyOf(out);
    const own = policy.csp.paths?.find((p) => p.match.prefix === "/notebook/");
    // Framed by the portal's own pages, whatever origin serves them; never by another site.
    expect(own?.directives["frame-ancestors"]).toBe("'self'");
    expect(own?.directives["script-src"]).toMatch(/^'self' 'wasm-unsafe-eval'/);
    expect(own?.directives["script-src"]).not.toMatch(/'unsafe-eval'|'unsafe-inline'/);
    expect(policy.csp.portal["frame-src"]).toContain("'self'");
    expect(policy.headers.some((h) => h.match.prefix === "/notebook/")).toBe(true);
    expect(verifyArtifact(out).errors).toEqual([]);

    // A file changed after the build fails verification, by the inventory.
    const page = join(out, "notebook", "notebooks", "index.html");
    writeFileSync(page, `${readFileSync(page, "utf8")}<!-- changed -->`);
    expect(
      verifyArtifact(out).errors.some((d) =>
        /does not match the notebook inventory/.test(d.message),
      ),
    ).toBe(true);
  }, 300_000);

  it("without the portal's sign-in, emits the relay page at auth/callback/ under its own policy", async () => {
    const out = join(tempRoot("portal-same-cb-"), "site");
    const result = await buildFixture(site({ assistant: true, login: false }), out, {
      skipNotebook: true,
    });
    expect(result.diagnostics.errors).toEqual([]);
    const html = readFileSync(join(out, "auth", "callback", "index.html"), "utf8");
    expect(html).toContain("data-auth-callback");
    expect(html).toContain('href="/notebook/lab/"');
    expect(html).not.toContain("http-equiv");
    expect(existsSync(join(out, "playground-origin"))).toBe(false);
    const policy = hostPolicyOf(out);
    const own = policy.csp.paths?.find((p) => p.match.path === "/auth/callback/");
    expect(own?.directives).toMatchObject({
      "default-src": "'none'",
      "frame-ancestors": "'none'",
      "form-action": "'none'",
    });
    const headers = policy.headers.find((h) => h.match.path === "/auth/callback/");
    expect(headers?.set["Cache-Control"]).toBe("no-store");
    // Its scripts are its own: none of their hashes are in the portal's policy.
    for (const value of Object.values(own?.directives ?? {})) {
      for (const hash of value.match(/'sha256-[^']+'/g) ?? []) {
        expect(policy.csp.portal["script-src"]).not.toContain(hash);
      }
    }
    // The relay carries no interpreter.
    const scripts = [...html.matchAll(/<script[^>]*src="\/([^"]+)"/g)].map((m) => m[1]!);
    const code = scripts.map((f) => readFileSync(join(out, ...f.split("/")), "utf8")).join("\n");
    expect(code).not.toMatch(/pyodide/i);
    expect(verifyArtifact(out).errors).toEqual([]);

    // With metaPolicy, the page carries it too: first in its head, without frame-ancestors.
    const metaOut = join(tempRoot("portal-same-cb-meta-"), "site");
    await buildFixture(site({ assistant: true, login: false, meta: true }), metaOut, {
      skipNotebook: true,
    });
    const metaHtml = readFileSync(join(metaOut, "auth", "callback", "index.html"), "utf8");
    const tag = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(metaHtml);
    // The head's first element after its `<meta charset>`, and the only policy.
    expect(pageMetaPolicyProblem(metaHtml, tag![1]!)).toBeNull();
    expect(tag?.[1]).toMatch(/^default-src 'none'; script-src 'self'/);
    expect(tag?.[1]).not.toMatch(/frame-ancestors/);
  }, 300_000);

  it("with the portal's sign-in, one callback route serves both (it relays the notebook's popup)", async () => {
    const out = join(tempRoot("portal-same-login-"), "site");
    const result = await buildFixture(site({ assistant: true }), out, { skipNotebook: true });
    expect(result.diagnostics.errors).toEqual([]);
    expect(result.model!.sameOriginNotebook?.emitCallback).toBe(false);
    const html = readFileSync(join(out, "auth", "callback", "index.html"), "utf8");
    expect(html).toContain("data-auth-callback");
    // A portal page: the portal's policy, not a second one.
    expect(hostPolicyOf(out).csp.paths?.some((p) => p.match.path) ?? false).toBe(false);
    expect(html).not.toContain("http-equiv");

    // With metaPolicy, that route carries the portal's policy as a meta tag, all of it its
    // same-tab sign-in needs (the auth service), without what a meta tag cannot deliver.
    const metaOut = join(tempRoot("portal-same-login-meta-"), "site");
    const meta = await buildFixture(site({ assistant: true, meta: true }), metaOut, {
      skipNotebook: true,
    });
    expect(meta.diagnostics.errors).toEqual([]);
    const page = readFileSync(join(metaOut, "auth", "callback", "index.html"), "utf8");
    const tag = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(page)?.[1];
    expect(pageMetaPolicyProblem(page, tag!)).toBeNull();
    const portal = hostPolicyOf(metaOut).csp.portal;
    expect(tag).toContain(`connect-src ${portal["connect-src"]}`);
    expect(tag).toContain(`script-src ${portal["script-src"]}`);
    expect(tag).toMatch(/auth\.example\.org/);
    expect(tag).not.toMatch(/frame-ancestors/);
    expect(page.match(/http-equiv/g)).toHaveLength(1);
    expect(verifyArtifact(metaOut).errors).toEqual([]);
  }, 300_000);

  it("with metaPolicy, carries each document's policy in a <meta> tag, and checks the site has it", async () => {
    const root = site({ assistant: false, login: false, meta: true });
    const plan = await planFor(root);
    expect(plan.metaPolicy).toMatch(/^default-src 'none'/);
    expect(plan.metaPolicy).not.toMatch(/frame-ancestors/);
    const out = join(tempRoot("portal-same-meta-"), "site");
    const result = await buildFixture(root, out, { notebookDir: fakeSite(plan) });
    expect(result.diagnostics.errors).toEqual([]);
    const page = readFileSync(join(out, "notebook", "notebooks", "index.html"), "utf8");
    expect(page).toMatch(/<head>\n<meta http-equiv="Content-Security-Policy" content="default-src/);
    // What a meta tag cannot deliver is reported.
    expect(
      result.diagnostics.items.some(
        (d) => d.code === "FP1239" && /except frame-ancestors/.test(d.message),
      ),
    ).toBe(true);
    // A site prepared without the meta policy is not this configuration's.
    const bare = await buildFixture(root, join(tempRoot("portal-same-meta-bare-"), "site"), {
      notebookDir: fakeSite(plan, plan.seeds, undefined, undefined, { metaPolicy: null }),
    });
    expect(bare.diagnostics.errors.find((d) => d.code === "FP1605")?.hint).toMatch(/meta policy/);
  }, 300_000);

  it("is served by one preview: each path's own policy, the portal's elsewhere, under the base path", async () => {
    const serve = async (
      dir: string,
      run: (get: (p: string) => Promise<Response>) => Promise<void>,
    ) => {
      const server = createPreviewServer({ dir, port: 0 });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const { port } = server.address() as AddressInfo;
      try {
        await run((path) => fetch(`http://127.0.0.1:${port}${path}`));
      } finally {
        server.close();
      }
    };
    // The notebook (no assistant: the stand-in site has no Lab).
    const root = site({ block: true, basePath: "/showroom/" });
    const notebookOut = join(tempRoot("portal-same-preview-nb-"), "site");
    const built = await buildFixture(root, notebookOut, {
      notebookDir: fakeSite(await planFor(root)),
    });
    expect(built.diagnostics.errors).toEqual([]);
    await serve(notebookOut, async (get) => {
      const portal = await get("/showroom/");
      expect(portal.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
      const notebook = await get("/showroom/notebook/notebooks/index.html");
      expect(notebook.status).toBe(200);
      const csp = notebook.headers.get("content-security-policy") ?? "";
      // One policy per response: the notebook's replaces the portal's, never stacked on it.
      expect(csp).toMatch(/frame-ancestors 'self'/);
      expect(csp).toMatch(/style-src 'self' 'unsafe-inline'/);
      expect(notebook.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await get("/notebook/notebooks/index.html")).status).toBe(404);
    });
    // The relay page, without the portal's sign-in.
    const callbackOut = join(tempRoot("portal-same-preview-cb-"), "site");
    await buildFixture(
      site({ assistant: true, login: false, basePath: "/showroom/" }),
      callbackOut,
      { skipNotebook: true },
    );
    await serve(callbackOut, async (get) => {
      const callback = await get("/showroom/auth/callback/?code=x&state=y");
      expect(callback.status).toBe(200);
      expect(callback.headers.get("cache-control")).toBe("no-store");
      expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
      expect(callback.headers.get("content-security-policy")).toMatch(
        /^default-src 'none'; script-src 'self'.*frame-ancestors 'none'$/,
      );
    });
  }, 300_000);
});

describe("a same-origin notebook beside a console on its own origin", () => {
  const CONSOLE = "https://python.example.org";

  it("signs in on the portal, prints that callback, and leaves the console's origin out of it", async () => {
    const root = site({ assistant: true, login: false, consoleOrigin: CONSOLE });
    const resolved = await resolve(root);
    expect(resolved.diagnostics.errors).toEqual([]);
    expect(resolved.model!.playground?.origin).toBe(CONSOLE);
    expect(resolved.model!.playground?.authCallbackPath).toBeUndefined();
    expect(resolved.model!.sameOriginNotebook).toMatchObject({
      callbackPath: "/auth/callback/",
      emitCallback: true,
    });
    // What the build prints for registration: the portal's callback, not the console's origin.
    const printed = describeAuthCallbacks(
      authCallbackEntries(resolved.model, notebookCallbackOf(resolved.model)),
    ).join("\n");
    expect(printed).toContain("notebook  login   https://portal.example.org/auth/callback/");
    expect(printed).not.toContain(`${CONSOLE}/auth/callback/`);
  }, 300_000);

  it("deploys the relay page on the portal and nothing of the notebook to the console's origin", async () => {
    const root = site({
      assistant: true,
      login: false,
      consoleOrigin: CONSOLE,
      starter: 'print(PORTAL_BASE_URL + "python-wheels/")',
    });
    const out = join(tempRoot("portal-mixed-"), "site");
    const result = await buildFixture(root, out, { skipNotebook: true });
    expect(result.diagnostics.errors).toEqual([]);
    expect(readFileSync(join(out, "auth", "callback", "index.html"), "utf8")).toContain(
      "data-auth-callback",
    );
    // Moved, not copied: the console's origin gets no callback of its own.
    expect(existsSync(join(out, "playground-origin", "auth"))).toBe(false);
    const deployment = result.playgroundDeployment!;
    expect(deployment.callback).toBeUndefined();
    expect(deployment.pathHeaders).toBeUndefined();
    expect(deployment.files.some((f) => /notebook|auth\/callback/.test(f))).toBe(false);
    const readme = readFileSync(join(out, "playground-origin", "README.md"), "utf8");
    expect(readme).not.toMatch(/notebook/);
    // The console's starter names the portal, which its own policy lets it reach.
    const child = readFileSync(join(out, "playground-origin", "index.html"), "utf8");
    expect(child).toMatch(/portalBaseUrl[^,]*https:\/\/portal\.example\.org\//);
    expect(child).not.toMatch(/PORTAL_BASE_URL =/);
    expect(deployment.headers["Content-Security-Policy"]).toMatch(
      /connect-src [^;]*https:\/\/portal\.example\.org/,
    );
  }, 300_000);

  it("copies the notebook into the portal and leaves it out of the console's deployment", async () => {
    const root = site({ consoleOrigin: CONSOLE });
    const plan = await planFor(root);
    const out = join(tempRoot("portal-mixed-nb-"), "site");
    const result = await buildFixture(root, out, { notebookDir: fakeSite(plan) });
    expect(result.diagnostics.errors).toEqual([]);
    expect(existsSync(join(out, "notebook", "NOTEBOOK-INVENTORY.json"))).toBe(true);
    expect(existsSync(join(out, "playground-origin", "notebook"))).toBe(false);
    const deployment = result.playgroundDeployment!;
    expect(deployment.files.some((f) => f.includes("notebook"))).toBe(false);
    expect(deployment.pathHeaders).toBeUndefined();
    expect(readFileSync(join(out, "playground-origin", "README.md"), "utf8")).not.toMatch(
      /mv .*notebook/,
    );
    expect(verifyArtifact(out).errors).toEqual([]);
  }, 300_000);
});

describe("PORTAL_BASE_URL", () => {
  it("is the base path on the portal's origin and the full URL on another, resolved where it runs", () => {
    expect(portalBaseUrl("/showroom")).toBe("/showroom/");
    expect(portalBaseUrl("/", "https://portal.example.org/")).toBe("https://portal.example.org/");
    expect(portalBaseSource("/showroom/", "http://localhost:4321/showroom/notebook/")).toBe(
      'PORTAL_BASE_URL = "http://localhost:4321/showroom/"',
    );
    expect(portalBaseSource("https://portal.example.org/", "https://console.example.org/")).toBe(
      'PORTAL_BASE_URL = "https://portal.example.org/"',
    );
    expect(portalBaseSource(undefined, "https://portal.example.org/")).toBeUndefined();
  });

  it("is given only to interpreters whose starter names it; the starter is never edited", async () => {
    const starter = "from __future__ import annotations; print(PORTAL_BASE_URL)  # as written";
    const named = await resolve(site({ basePath: "/showroom/", starter }));
    expect(named.diagnostics.errors).toEqual([]);
    const page = named.model!.routes.find((r) => r.python)!;
    expect(page.python!.initialSource!.trim()).toBe(starter);
    expect(page.python!.portalBaseUrl).toBe("/showroom/");
    const plain = await resolve(site({ starter: "print(1)" }));
    const other = plain.model!.routes.find((r) => r.python)!;
    expect(other.python!.initialSource!.trim()).toBe("print(1)");
    expect(other.python!.portalBaseUrl).toBeUndefined();
    expect((await planFor(site({ starter: "print(1)" }))).settings.portalBaseUrl).toBeUndefined();
  });
});
