// The notebook beside the separate-origin playground: required when enabled, checked against
// this configuration before anything is copied, deployed whole with a policy of its own under
// `/notebook/`, and re-checked against its inventory by `verify`.
//
// The site here is a minimal stand-in with a REAL inventory (the kernel package's own `siteFiles`
// and audit rules); the browser suite builds and runs a real one.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DISABLED_EXTENSIONS,
  INVENTORY,
  INVENTORY_SCHEMA,
  LITE_CORE_VERSION,
  pinnedRequirements,
  siteFiles,
  PREPARE_DIGEST,
} from "@freva-org/jupyterlite-freva-kernel/prepare";
import { cleanupFixtures, tempRoot, write } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { writeConsumerSite } from "../helpers/consumer.js";
import { resolveModel } from "../../src/model/resolve.js";
import {
  KERNEL_PACKAGE,
  extensionPackage,
  planNotebook,
  type NotebookPlan,
} from "../../src/model/notebook.js";
import { verifyArtifact } from "../../src/verify/verify.js";
import { authCallbackEntries, describeAuthCallbacks } from "../../src/model/auth-callbacks.js";

afterAll(cleanupFixtures);

const ORIGIN = "https://py.example.org";

const SEED = JSON.stringify({
  cells: [{ cell_type: "markdown", metadata: {}, source: ["# Start here\n"] }],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});

const ASSISTANT =
  "    assistant:\n      climateclaw:\n        host: https://freva.example.org\n" +
  "        defaultModel: gpt-test\n";

function site(seeds = false, assistant = false): string {
  const root = writeConsumerSite({
    python: true,
    playgroundOrigin: ORIGIN,
    playground: {
      profile: "minimal",
      playgroundOrigin: ORIGIN,
      addonBaseUrl: `${ORIGIN}/python-addons/`,
      extraYaml:
        "  notebook:\n    enabled: true\n" +
        (assistant ? ASSISTANT : "") +
        (seeds ? "    seeds:\n      - ./notebooks/intro.ipynb\n" : "") +
        "  sessionChoices:\n    profiles:\n      minimal: {}\n      xarray-zarr:\n        allowedAddons: [dask]\n",
    },
    runnableDocs: true,
  });
  if (seeds) write(root, "notebooks/intro.ipynb", SEED);
  return root;
}

/** The installed kernel extension's manifest, as `prepare-notebook` copies it into a site. */
const kernelManifest = (): string =>
  readFileSync(join(extensionPackage(KERNEL_PACKAGE).labextension, "package.json"), "utf8");

/** A stand-in prepared site for `plan`: what `prepare-notebook` would write, minus JupyterLite. */
function fakeSite(
  plan: NotebookPlan,
  seeds = plan.seeds,
  kernel = kernelManifest(),
  requirements = pinnedRequirements(),
  made: { preparedBy?: string; faviconUrl?: boolean } = {},
): string {
  const dir = join(tempRoot("portal-notebook-site-"), "notebook");
  const put = (path: string, text: string): void => {
    mkdirSync(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...path.split("/")), text);
  };
  put(
    "jupyter-lite.json",
    JSON.stringify({
      "jupyter-config-data": {
        federated_extensions: [{ name: "@freva-org/jupyterlite-freva-kernel" }],
        disabledExtensions: DISABLED_EXTENSIONS,
        // As `linkFavicon` names it for JupyterLite's boot script.
        ...(plan.favicon && made.faviconUrl !== false
          ? { faviconUrl: `./${plan.favicon.path}` }
          : {}),
      },
    }),
  );
  put("notebooks/index.html", '<!doctype html><script src="./config-utils.js"></script>');
  put(`extensions/${KERNEL_PACKAGE}/package.json`, kernel);
  for (const seed of seeds) put(`files/${seed.name}`, seed.text);
  if (plan.favicon) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, plan.favicon.path), plan.favicon.bytes);
  }
  put(
    INVENTORY,
    JSON.stringify({
      schemaVersion: INVENTORY_SCHEMA,
      jupyterliteCore: LITE_CORE_VERSION,
      requirements,
      seeds: seeds.map((s) => s.name),
      settingsSha256: plan.settingsSha256,
      ...(plan.appName ? { appName: plan.appName } : {}),
      ...(plan.favicon
        ? { favicon: { path: plan.favicon.path, sha256: plan.favicon.sha256 } }
        : {}),
      preparedBy: made.preparedBy ?? PREPARE_DIGEST,
      files: siteFiles(dir),
    }),
  );
  return dir;
}

async function planFor(root: string): Promise<NotebookPlan> {
  const resolved = await resolveModel({
    sourceRoot: root,
    configPath: join(root, "portal.yaml"),
    release: false,
    skipNotebook: true,
  });
  return planNotebook(
    resolved.portalPlayground!,
    resolved.model!.playground!,
    resolved.notebookSeeds ?? [],
    resolved.notebookLab,
    resolved.notebookIdentity,
  );
}

describe("the notebook", () => {
  it("is required when enabled, with the command that prepares it (FP1604)", async () => {
    const root = site();
    const result = await buildFixture(root, join(tempRoot("portal-nb-missing-"), "site"));
    const missing = result.diagnostics.errors.find((d) => d.code === "FP1604");
    expect(missing?.pointer).toBe("/pythonPlayground/notebook");
    expect(missing?.hint).toMatch(/prepare-notebook/);
  }, 300_000);

  it("refuses a site prepared for another configuration (FP1605)", async () => {
    const root = site();
    const plan = await planFor(root);
    const stale = fakeSite({ ...plan, settingsSha256: "0".repeat(64) });
    const result = await buildFixture(root, join(tempRoot("portal-nb-stale-"), "site"), {
      notebookDir: stale,
    });
    const refused = result.diagnostics.errors.find((d) => d.code === "FP1605");
    expect(refused?.hint).toMatch(/different kernel settings/);
  }, 300_000);

  it("refuses a site holding an older build of the kernel, with no JupyterLab options (FP1605)", async () => {
    const root = site();
    const plan = await planFor(root);
    expect(plan.lab).toBeUndefined();
    const older = kernelManifest().replace(/remoteEntry\.[0-9a-f]+\.js/, "remoteEntry.0000.js");
    const result = await buildFixture(root, join(tempRoot("portal-nb-old-kernel-"), "site"), {
      notebookDir: fakeSite(plan, plan.seeds, older),
    });
    expect(result.diagnostics.errors.find((d) => d.code === "FP1605")?.hint).toMatch(
      /older build of @freva-org\/jupyterlite-freva-kernel/,
    );
  }, 300_000);

  it("refuses a site built with another pinned JupyterLite toolchain (FP1605)", async () => {
    const root = site();
    const plan = await planFor(root);
    const [first, ...rest] = pinnedRequirements();
    const other = [{ ...first!, sha256: "0".repeat(64) }, ...rest];
    const result = await buildFixture(root, join(tempRoot("portal-nb-toolchain-"), "site"), {
      notebookDir: fakeSite(plan, plan.seeds, kernelManifest(), other),
    });
    expect(result.diagnostics.errors.find((d) => d.code === "FP1605")?.hint).toMatch(
      /different pinned JupyterLite toolchain/,
    );
  }, 300_000);

  it("carries the portal's name and favicon, and refuses a site with others (FP1605)", async () => {
    const root = site();
    const plan = await planFor(root);
    expect(plan.appName).toMatch(/ Playground$/);
    expect(plan.favicon?.path).toMatch(/^favicon\.(svg|png|ico)$/);
    const other = fakeSite({ ...plan, appName: "Freva Notebook" });
    const renamed = await buildFixture(root, join(tempRoot("portal-nb-name-"), "site"), {
      notebookDir: other,
    });
    expect(renamed.diagnostics.errors.find((d) => d.code === "FP1605")?.hint).toMatch(
      /is named "Freva Notebook"/,
    );
    const { favicon, ...without } = plan;
    expect(favicon).toBeDefined();
    const plain = await buildFixture(root, join(tempRoot("portal-nb-icon-"), "site"), {
      notebookDir: fakeSite(without),
    });
    expect(plain.diagnostics.errors.find((d) => d.code === "FP1605")?.hint).toMatch(
      /tab icon is not this portal's favicon/,
    );
  }, 300_000);

  it("prepares again a site from another revision of prepare-notebook, or one whose bootstrap names another icon", async () => {
    const root = site();
    const plan = await planFor(root);
    const older = await buildFixture(root, join(tempRoot("portal-nb-rev-"), "site"), {
      notebookDir: fakeSite(plan, plan.seeds, kernelManifest(), pinnedRequirements(), {
        preparedBy: "an-earlier-revision",
      }),
    });
    expect(older.diagnostics.errors.find((d) => d.code === "FP1605")?.hint).toMatch(
      /prepared by another revision of prepare-notebook/,
    );
    const icon = await buildFixture(root, join(tempRoot("portal-nb-boot-"), "site"), {
      notebookDir: fakeSite(plan, plan.seeds, kernelManifest(), pinnedRequirements(), {
        faviconUrl: false,
      }),
    });
    expect(icon.diagnostics.errors.find((d) => d.code === "FP1605")?.hint).toMatch(
      /jupyter-lite\.json does not name the site's tab icon/,
    );
  }, 300_000);

  it("seeds the deployment's own notebooks, and refuses a site whose copy differs", async () => {
    const root = site(true);
    const plan = await planFor(root);
    expect(plan.seeds.map((seed) => seed.name)).toContain("intro.ipynb");
    const ok = await buildFixture(root, join(tempRoot("portal-nb-seeds-"), "site"), {
      notebookDir: fakeSite(plan),
    });
    expect(ok.diagnostics.errors).toEqual([]);
    const edited = plan.seeds.map((seed) =>
      seed.name === "intro.ipynb" ? { ...seed, text: SEED.replace("Start", "Stop") } : seed,
    );
    const stale = await buildFixture(root, join(tempRoot("portal-nb-seeds-stale-"), "site"), {
      notebookDir: fakeSite(plan, edited),
    });
    expect(stale.diagnostics.errors.find((d) => d.code === "FP1605")?.hint).toMatch(
      /seed notebooks/,
    );
  }, 300_000);

  it("is deployed whole under /notebook/ with its own policy, and verify re-checks it", async () => {
    const root = site();
    const plan = await planFor(root);
    expect(plan.seeds.length).toBeGreaterThan(0);
    const out = join(tempRoot("portal-nb-ok-"), "site");
    const result = await buildFixture(root, out, { notebookDir: fakeSite(plan) });
    expect(result.diagnostics.errors).toEqual([]);
    const deployment = result.playgroundDeployment!;
    const notebookFiles = deployment.files.filter((f) =>
      f.startsWith("playground-origin/notebook/"),
    );
    expect(notebookFiles).toContain("playground-origin/notebook/NOTEBOOK-INVENTORY.json");
    expect(notebookFiles).toContain(`playground-origin/notebook/files/${plan.seeds[0]!.name}`);
    const csp = deployment.pathHeaders?.["/notebook/"]?.["Content-Security-Policy"] ?? "";
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval'/);
    expect(csp).not.toMatch(/'unsafe-eval'/);
    // The playground's own policy is untouched: still no inline styles.
    expect(deployment.headers["Content-Security-Policy"]).toMatch(/style-src 'self';/);
    const readme = readFileSync(join(out, "playground-origin", "README.md"), "utf8");
    expect(readme).toMatch(
      /mv <playground-root>\/playground-origin\/notebook <playground-root>\/notebook/,
    );
    expect(verifyArtifact(out).errors).toEqual([]);

    // A file changed after the build fails `verify`, by the inventory as well as the checksums.
    const page = join(out, "playground-origin", "notebook", "notebooks", "index.html");
    writeFileSync(page, `${readFileSync(page, "utf8")}<!-- changed -->`);
    const errors = verifyArtifact(out).errors.map((d) => d.message);
    expect(errors.some((m) => /does not match the notebook inventory/.test(m))).toBe(true);
  }, 300_000);

  it("with an assistant, the notebook origin gets the shared sign-in callback beside the notebook", async () => {
    // The notebook site itself is not built here (its JupyterLab is the browser suite's): the
    // callback is the playground document's, beside it.
    const root = site(false, true);
    const out = join(tempRoot("portal-nb-auth-"), "site");
    const result = await buildFixture(root, out, { skipNotebook: true });
    expect(result.diagnostics.errors).toEqual([]);
    const deployment = result.playgroundDeployment!;
    expect(deployment.callback).toEqual({
      path: "/auth/callback/",
      file: "playground-origin/auth/callback/index.html",
    });
    // Resources only: the callback's "Back to the notebook" is a link, not a file to copy.
    expect(deployment.files).not.toContain("notebook/lab/");
    for (const file of deployment.files) {
      expect(() => readFileSync(join(out, ...file.split("/")))).not.toThrow();
    }
    const html = readFileSync(
      join(out, "playground-origin", "auth", "callback", "index.html"),
      "utf8",
    );
    expect(html).toContain("data-auth-callback");
    expect(html.indexOf('name="referrer" content="no-referrer"')).toBeLessThan(
      html.indexOf("<script"),
    );
    // Its scripts, and nothing of the playground's: no console, no interpreter. The compiler may
    // inline a small entry; then the policy allows exactly that script by its hash.
    const scripts = [...html.matchAll(/<script[^>]*src="\/([^"]+)"/g)].map((m) => m[1]!);
    const inline = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(
      (m) => m[1]!,
    );
    expect(scripts.length + inline.length).toBeGreaterThan(0);
    // The scripts and the chunks they import, all deployed.
    const graph = new Set(scripts);
    const imports = (text: string, from: string) => {
      for (const m of text.matchAll(/from\s*"(?:\.\/|\/)([^"]+)"/g)) {
        graph.add(m[0].includes('"/') ? m[1]! : `${from}${m[1]}`);
      }
    };
    for (const body of inline) imports(body, "");
    for (const file of graph) {
      imports(
        readFileSync(join(out, ...file.split("/")), "utf8"),
        file.slice(0, file.lastIndexOf("/") + 1),
      );
    }
    for (const file of graph) expect(deployment.files).toContain(file);
    const code = [
      ...inline,
      ...[...graph].map((f) => readFileSync(join(out, ...f.split("/")), "utf8")),
    ].join("\n");
    expect(code).toContain("freva-auth-callback.");
    expect(code).not.toMatch(/pyodide|browser-python/i);
    // The playground document does not load the callback's entry.
    const index = readFileSync(join(out, "playground-origin", "index.html"), "utf8");
    expect(index).not.toContain("data-auth-callback");
    // Its own policy: no-store, no referrer, never framed, its own script only.
    const headers = deployment.pathHeaders?.["/auth/callback/"] ?? {};
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    const hashes = inline.map(
      (body) => `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`,
    );
    expect(headers["Content-Security-Policy"]).toBe(
      `default-src 'none'; script-src ${["'self'", ...hashes].join(" ")}; base-uri 'none'; ` +
        "form-action 'none'; frame-ancestors 'none'",
    );
    // …and the portal's own policy allows none of the other origin's scripts.
    const portalPolicy = readFileSync(join(out, "host-policy.json"), "utf8");
    for (const hash of hashes) expect(portalPolicy).not.toContain(hash.slice(1, -1));
    const readme = readFileSync(join(out, "playground-origin", "README.md"), "utf8");
    expect(readme).toContain(
      "mv <playground-root>/playground-origin/auth/callback/index.html <playground-root>/auth/callback/index.html",
    );
    expect(readme).toContain(`${ORIGIN}/auth/callback/`);
    expect(verifyArtifact(out).errors).toEqual([]);
  }, 300_000);

  it("under a base path: the notebook, its callback and every deployed file follow it", async () => {
    const root = site(false, true);
    const config = join(root, "portal.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "canonicalUrl: https://portal.example.org/",
        "canonicalUrl: https://portal.example.org/showroom/",
      ),
    );
    const resolved = await resolveModel({
      sourceRoot: root,
      configPath: config,
      release: false,
      skipNotebook: true,
    });
    const lab = planNotebook(
      resolved.portalPlayground!,
      resolved.model!.playground!,
      resolved.notebookSeeds ?? [],
      resolved.notebookLab,
    ).lab!;
    // The notebook's settings and the URLs to register carry /showroom/, never the domain root.
    expect(lab.overrides["@freva-org/jupyterlite-climateclaw:plugin"]!.callbackPath).toBe(
      "/showroom/auth/callback/",
    );
    expect(lab.callbacks).toEqual({
      login: `${ORIGIN}/showroom/auth/callback/`,
      logout: `${ORIGIN}/showroom/auth/callback/`,
      legacy: `${ORIGIN}/showroom/notebook/freva-login-callback.html`,
    });
    const printed = describeAuthCallbacks(
      authCallbackEntries(undefined, {
        origin: ORIGIN,
        callbackPath: resolved.notebookLab!.authCallbackPath,
        basePath: resolved.notebookLab!.basePath,
      }),
    ).join("\n");
    expect(printed).toContain(`${ORIGIN}/showroom/auth/callback/`);
    expect(printed).not.toMatch(new RegExp(`${ORIGIN.replace(/\./g, "\\.")}/auth/`));

    const out = join(tempRoot("portal-nb-base-"), "site");
    const result = await buildFixture(root, out, { skipNotebook: true });
    expect(result.diagnostics.errors).toEqual([]);
    const deployment = result.playgroundDeployment!;
    expect(deployment.basePath).toBe("/showroom/");
    expect(deployment.callback?.path).toBe("/showroom/auth/callback/");
    expect(Object.keys(deployment.pathHeaders ?? {})).toContain("/showroom/auth/callback/");
    // Every listed file is in the artifact: no page link, no base-path URL taken for a file.
    for (const file of deployment.files) {
      expect(() => readFileSync(join(out, ...file.split("/")))).not.toThrow();
    }
    expect(deployment.files).not.toContain("notebook/lab/");
    const html = readFileSync(
      join(out, "playground-origin", "auth", "callback", "index.html"),
      "utf8",
    );
    expect(html).toContain('href="/showroom/notebook/lab/"');
    const readme = readFileSync(join(out, "playground-origin", "README.md"), "utf8");
    expect(readme).toContain("<playground-root>/showroom/index.html");
  }, 300_000);

  it("without an assistant, the notebook origin has no sign-in callback", async () => {
    const root = site();
    const plan = await planFor(root);
    const out = join(tempRoot("portal-nb-noauth-"), "site");
    const result = await buildFixture(root, out, { notebookDir: fakeSite(plan) });
    expect(result.diagnostics.errors).toEqual([]);
    expect(result.playgroundDeployment!.callback).toBeUndefined();
    expect(result.playgroundDeployment!.pathHeaders?.["/auth/callback/"]).toBeUndefined();
    expect(result.playgroundDeployment!.files.some((f) => f.includes("auth/callback"))).toBe(false);
  }, 300_000);
});
