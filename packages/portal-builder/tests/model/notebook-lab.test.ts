// The notebook's assistant (ClimateClaw) and data panel: the configuration, its diagnostics, what
// `prepare-notebook` is asked to build, the notebook's policy and the playground identity.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  INVENTORY,
  INVENTORY_SCHEMA,
  LITE_CORE_VERSION,
  pinnedRequirements,
} from "@freva-org/jupyterlite-freva-kernel/prepare";
import { cleanupFixtures, tempRoot, write } from "../helpers/fixture.js";
import { writeConsumerSite, RUNNABLE } from "../helpers/consumer.js";
import { resolveModel } from "../../src/model/resolve.js";
import {
  AI_DISABLED_EXTENSIONS,
  LAB_DISABLED_EXTENSIONS,
  checkNotebookSite,
  labSiteOptions,
  notebookPolicy,
  planNotebook,
} from "../../src/model/notebook.js";
import { playgroundIdentity } from "../../src/model/python-playground.js";
import { hostPolicy } from "../../src/artifact/manifests.js";
import { generateEntryModule, projectRuntime } from "../../src/artifact/runtime-projection.js";

afterAll(cleanupFixtures);

const ORIGIN = "https://py.example.org";
const HOST = "https://freva.example.org";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>';
const SEED = JSON.stringify({
  cells: [{ cell_type: "markdown", metadata: {}, source: ["# ERA5 walkthrough\n"] }],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});

function site(
  notebookYaml: string,
  options: {
    s3?: boolean;
    files?: Record<string, string>;
    origin?: string;
    blocks?: string;
    runnableDocs?: boolean;
  } = {},
) {
  const origin = options.origin ?? ORIGIN;
  const root = writeConsumerSite({
    python: true,
    playgroundOrigin: origin,
    ...(options.s3 ? { s3: true } : {}),
    playground: {
      profile: "xarray-zarr",
      playgroundOrigin: origin,
      extraYaml: `  notebook:\n${notebookYaml}`,
    },
    runnableDocs: options.runnableDocs ?? true,
  });
  for (const [path, text] of Object.entries(options.files ?? {})) write(root, path, text);
  if (options.blocks) {
    const landing = join(root, "landings", "home.yaml");
    const text = readFileSync(landing, "utf8");
    writeFileSync(landing, `${text.endsWith("\n") ? text : `${text}\n`}${options.blocks}`);
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

const ASSISTANT =
  "    assistant:\n" +
  "      climateclaw:\n" +
  `        host: ${HOST}\n` +
  "        defaultModel: gpt-test\n" +
  "        runAndFixModel: gpt-fast\n" +
  "        scopeNote: Answer about this portal's data.\n" +
  "        examples:\n" +
  "          - title: Global mean\n" +
  "            prompt: Compute the global mean of tas.\n";

const PANEL =
  "    dataPanel:\n" +
  "      tree: home-2\n" +
  "      icon: ./assets/panel.svg\n" +
  "      seedNotebooks:\n" +
  "        - ./notebooks/era5.ipynb\n";

describe("the notebook's assistant and data panel", () => {
  it("plans a trimmed Lab site with jupyterlite-ai, ClimateClaw and the panel", async () => {
    const root = site(`    enabled: true\n${ASSISTANT}${PANEL}`, {
      files: { "assets/panel.svg": ICON, "notebooks/era5.ipynb": SEED },
    });
    const resolved = await resolve(root);
    expect(resolved.diagnostics.errors).toEqual([]);
    const plan = planNotebook(
      resolved.portalPlayground!,
      resolved.model!.playground!,
      resolved.notebookSeeds ?? [],
      resolved.notebookLab,
    );
    const lab = plan.lab!;
    expect(lab.packages).toEqual([
      "@freva-org/jupyterlite-climateclaw",
      "@freva-org/jupyterlite-freva-data",
    ]);
    expect(lab.jupyterliteAi).toBe(true);
    expect(lab.disabledExtensions).toEqual([...LAB_DISABLED_EXTENSIONS, ...AI_DISABLED_EXTENSIONS]);
    // ClimateClaw's own chat panel replaces jupyterlite-ai's; the portal names itself (no logo).
    expect(lab.disabledExtensions).toContain("@jupyterlite/ai:chat");
    // No "@jupyternaut-frontend" on "@": the chats answer without a mention.
    expect(lab.disabledExtensions).toContain("@jupyternaut/persona:mention");
    expect(lab.disabledExtensions).toContain("@jupyterlite/application-extension:logo");
    // The shared callback at the notebook origin's root, for sign-in and sign-out; the old page
    // stays during the migration.
    expect(lab.callbacks).toEqual({
      login: `${ORIGIN}/auth/callback/`,
      logout: `${ORIGIN}/auth/callback/`,
      legacy: `${ORIGIN}/notebook/freva-login-callback.html`,
    });

    const cc = lab.overrides["@freva-org/jupyterlite-climateclaw:plugin"]!;
    expect(cc).toEqual({
      host: HOST,
      authBaseUrl: `${HOST}/api/freva-nextgen/auth/v2`,
      // Origin-relative: resolved against the notebook's own origin, no host in the settings.
      callbackPath: "/auth/callback/",
      defaultModel: "gpt-test",
      runAndFixModel: "gpt-fast",
      scopeNote: "Answer about this portal's data.",
      examples: [{ title: "Global mean", prompt: "Compute the global mean of tas." }],
      hideCodeByDefault: false,
    });
    expect(lab.overrides["@jupyternaut/persona:settings-model"]).toMatchObject({
      providers: [{ id: "climateclaw", provider: "climateclaw", model: "gpt-test" }],
      defaultProvider: "climateclaw",
      toolsEnabled: false,
      useSameProviderForChatAndCompleter: false,
    });
    // No credential anywhere in the overrides.
    expect(JSON.stringify(lab.overrides)).not.toMatch(
      /"(?:access_?token|refresh_?token|apiKey|password|bearer)"/i,
    );
    expect(JSON.stringify(lab.overrides)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);

    const panel = lab.overrides["@freva-org/jupyterlite-freva-data:plugin"]!;
    expect(panel.title).toBe(`${resolved.model!.site.title} data`);
    expect(String(panel.iconSvg)).toContain("<svg");
    expect(panel.seedNotebooks).toEqual([
      { path: "examples/era5.ipynb", title: "ERA5 walkthrough" },
    ]);
    expect(panel.launcher).toEqual({ newNotebook: true, browse: true, examples: true, ask: true });
    expect(plan.seeds.map((s) => s.name)).toContain("examples/era5.ipynb");

    const dataFile = lab.files.find((f) => f.path === panel.dataUrl)!;
    expect(panel.dataSha256).toBe(sha(dataFile.text));
    const data = JSON.parse(dataFile.text);
    expect(data).toMatchObject({ schemaVersion: 1, instanceId: "home-2", mode: "snapshot" });
    // Only executable Python examples are registered, each with the digest of its exact bytes.
    expect(data.examples.length).toBeGreaterThan(0);
    for (const example of data.examples) {
      expect(["python", "template"]).toContain(example.exampleId);
      if (example.exampleId === "python") expect(example.sha256).toBe(sha(RUNNABLE));
    }
    expect(data.examples.some((e: { exampleId: string }) => e.exampleId === "cli")).toBe(false);

    const options = labSiteOptions(lab);
    expect(options.requirements).toMatch(/jupyterlite-ai-requirements\.txt$/);
    expect(options.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "freva-login-callback.html",
        "freva-login-callback.js",
        panel.dataUrl,
      ]),
    );

    const csp = await notebookPolicy(resolved.model!.playground!, resolved.notebookLab);
    expect(csp).toMatch(new RegExp(`connect-src [^;]*${HOST.replace(/\./g, "\\.")}`));
    expect(csp).toMatch(/img-src 'self' data: blob:/);
    // No viewer unless the panel opts in: nothing may be framed.
    expect(panel.gridlook).toBe(false);
    expect(csp).not.toContain("frame-src");
  });

  it("shows figures ClimateClaw's code saved: the host, or its preview origin, for images", async () => {
    const plain = await resolve(site(`    enabled: true\n${ASSISTANT}`));
    const hostCsp = await notebookPolicy(plain.model!.playground!, plain.notebookLab);
    const imgOf = (csp: string) => csp.split("; ").find((d) => d.startsWith("img-src"));
    expect(imgOf(hostCsp)).toBe(`img-src 'self' data: blob: attachment: ${new URL(HOST).origin}`);
    const other = await resolve(
      site(`    enabled: true\n${ASSISTANT}        previewOrigin: https://gems.example.org\n`),
    );
    expect(other.diagnostics.errors).toEqual([]);
    const csp = await notebookPolicy(other.model!.playground!, other.notebookLab);
    expect(imgOf(csp)).toBe("img-src 'self' data: blob: attachment: https://gems.example.org");
    expect(csp).toMatch(/connect-src [^;]*https:\/\/gems\.example\.org/);
    // ClimateClaw knows it too: a figure from elsewhere is linked, never a broken picture.
    const otherLab = planNotebook(
      other.portalPlayground!,
      other.model!.playground!,
      other.notebookSeeds ?? [],
      other.notebookLab,
    ).lab!;
    expect(otherLab.overrides["@freva-org/jupyterlite-climateclaw:plugin"]!.previewOrigin).toBe(
      "https://gems.example.org",
    );
    // An origin only: a path or another scheme is refused.
    const bad = await resolve(
      site(
        `    enabled: true\n${ASSISTANT}        previewOrigin: https://gems.example.org/static\n`,
      ),
    );
    expect(bad.diagnostics.errors.length).toBeGreaterThan(0);
  });

  it("opens a start notebook: published like a seed, named in the panel's settings", async () => {
    const start = `${PANEL}      startNotebook: ./notebooks/start.ipynb\n`;
    const root = site(`    enabled: true\n${ASSISTANT}${start}`, {
      files: {
        "assets/panel.svg": ICON,
        "notebooks/era5.ipynb": SEED,
        "notebooks/start.ipynb": SEED.replace("ERA5 walkthrough", "Start here"),
      },
    });
    const resolved = await resolve(root);
    expect(resolved.diagnostics.errors).toEqual([]);
    const plan = planNotebook(
      resolved.portalPlayground!,
      resolved.model!.playground!,
      resolved.notebookSeeds ?? [],
      resolved.notebookLab,
    );
    expect(plan.seeds.map((seed) => seed.name)).toContain("examples/start.ipynb");
    const panel = plan.lab!.overrides["@freva-org/jupyterlite-freva-data:plugin"]!;
    expect(panel.startNotebook).toBe("examples/start.ipynb");
    expect((panel.seedNotebooks as Array<{ path: string }>).map((n) => n.path)).toContain(
      "examples/start.ipynb",
    );
    // The same file listed as an example too: published once.
    const both = site(
      `    enabled: true\n${ASSISTANT}${PANEL}      startNotebook: ./notebooks/era5.ipynb\n`,
      { files: { "assets/panel.svg": ICON, "notebooks/era5.ipynb": SEED } },
    );
    const again = await resolve(both);
    expect(again.diagnostics.errors).toEqual([]);
    const seeds = planNotebook(
      again.portalPlayground!,
      again.model!.playground!,
      again.notebookSeeds ?? [],
      again.notebookLab,
    ).seeds.filter((seed) => seed.name === "examples/era5.ipynb");
    expect(seeds).toHaveLength(1);
  });

  it("frames GridLook, and only GridLook, when the panel opts in", async () => {
    const root = site(
      `    enabled: true\n    dataPanel:\n      tree: home-2\n      gridlook: true\n`,
    );
    const resolved = await resolve(root);
    expect(resolved.diagnostics.errors).toEqual([]);
    const lab = planNotebook(
      resolved.portalPlayground!,
      resolved.model!.playground!,
      [],
      resolved.notebookLab,
    ).lab!;
    expect(lab.overrides["@freva-org/jupyterlite-freva-data:plugin"]!.gridlook).toBe(true);
    const csp = await notebookPolicy(resolved.model!.playground!, resolved.notebookLab);
    expect(csp.split("; ").filter((d) => d.startsWith("frame-src"))).toEqual([
      "frame-src https://gridlook.pages.dev",
    ]);
    expect(csp).toContain("frame-ancestors 'none'");
    // The portal's own tree offers the globe too: its Inspect is told, and the portal frames it.
    const tree = resolved.model!.landings[0]!.blocks.find((b) => b.datasetTree)!.datasetTree!;
    expect(tree.gridlook).toBe(true);
    const portal = (
      hostPolicy({ model: resolved.model!, evidence: {} as never, files: [], rstUsed: false }) as {
        csp: { portal: Record<string, string> };
      }
    ).csp.portal;
    expect(portal["frame-src"]).toContain("https://gridlook.pages.dev");

    // Without the switch: neither the tree nor the portal's policy offers GridLook.
    const off = await resolve(site(`    enabled: true\n    dataPanel:\n      tree: home-2\n`));
    const offTree = off.model!.landings[0]!.blocks.find((b) => b.datasetTree)!.datasetTree!;
    expect(offTree.gridlook).toBeUndefined();
    const offPortal = (
      hostPolicy({ model: off.model!, evidence: {} as never, files: [], rstUsed: false }) as {
        csp: { portal: Record<string, string> };
      }
    ).csp.portal;
    expect(offPortal["frame-src"] ?? "").not.toContain("gridlook");
  });

  it("refuses to reuse a site whose jupyterlite-ai wheels are not the pinned ones", async () => {
    const root = site(`    enabled: true\n${ASSISTANT}`);
    const resolved = await resolve(root);
    const plan = planNotebook(
      resolved.portalPlayground!,
      resolved.model!.playground!,
      resolved.notebookSeeds ?? [],
      resolved.notebookLab,
    );
    const pins = pinnedRequirements(labSiteOptions(plan.lab!).requirements);
    const wheelProblem = async (extensionWheels: typeof pins) => {
      const dir = tempRoot("portal-nb-wheels-");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "jupyter-lite.json"), JSON.stringify({ "jupyter-config-data": {} }));
      writeFileSync(
        join(dir, INVENTORY),
        JSON.stringify({
          schemaVersion: INVENTORY_SCHEMA,
          jupyterliteCore: LITE_CORE_VERSION,
          requirements: pinnedRequirements(),
          apps: ["lab", "notebooks", "tree"],
          extensionWheels,
          seeds: [],
          settingsSha256: plan.settingsSha256,
          files: [],
        }),
      );
      const { problems } = await checkNotebookSite(dir, plan);
      return problems.some((p) => /extension wheels are not the pinned ones/.test(p));
    };
    expect(await wheelProblem(pins)).toBe(false);
    expect(await wheelProblem(pins.slice(1))).toBe(true);
    const [first, ...rest] = pins;
    expect(await wheelProblem([{ ...first!, version: "0.0.1" }, ...rest])).toBe(true);
  });

  it("copies a live tree's search index and registers the recipes by template", async () => {
    const root = site(`    enabled: true\n    dataPanel:\n      tree: home-2\n`, { s3: true });
    const resolved = await resolve(root);
    expect(resolved.diagnostics.errors).toEqual([]);
    const lab = planNotebook(
      resolved.portalPlayground!,
      resolved.model!.playground!,
      [],
      resolved.notebookLab,
    ).lab!;
    expect(lab.packages).toEqual(["@freva-org/jupyterlite-freva-data"]);
    expect(lab.jupyterliteAi).toBe(false);
    expect(lab.disabledExtensions).toEqual([...LAB_DISABLED_EXTENSIONS]);
    const panel = lab.overrides["@freva-org/jupyterlite-freva-data:plugin"]!;
    expect(panel.launcher).toMatchObject({ ask: false });
    const data = JSON.parse(lab.files.find((f) => f.path === panel.dataUrl)!.text);
    expect(data.mode).toBe("s3");
    expect(data.s3.endpoint).toBe("https://objects.example.org");
    for (const recipe of data.recipes) expect(recipe.sha256).toBe(sha(recipe.template));
    const csp = await notebookPolicy(resolved.model!.playground!, resolved.notebookLab);
    expect(csp).toContain("https://objects.example.org");
  });

  it("requires the notebook, an HTTPS host and an auth API on it (FP1236)", async () => {
    const off = await resolve(site(`    enabled: false\n${ASSISTANT}`));
    expect(off.diagnostics.errors.find((d) => d.code === "FP1236")?.pointer).toBe(
      "/pythonPlayground/notebook/assistant",
    );
    const otherAuth = await resolve(
      site(
        `    enabled: true\n${ASSISTANT}        authBaseUrl: https://auth.example.net/api/freva-nextgen/auth/v2\n`,
      ),
    );
    const error = otherAuth.diagnostics.errors.find((d) => d.code === "FP1236");
    expect(error?.pointer).toBe("/pythonPlayground/notebook/assistant/climateclaw/authBaseUrl");
    expect(error?.file).toBe("portal.yaml");
  });

  it("takes a loopback host only for a local notebook (FP1236)", async () => {
    const LOCAL = "http://localhost:4322";
    const MOCK = "http://127.0.0.1:4330";
    const local = await resolve(
      site(`    enabled: true\n${ASSISTANT.replace(HOST, MOCK)}`, { origin: LOCAL }),
    );
    expect(local.diagnostics.errors).toEqual([]);
    expect(local.notebookLab?.assistant?.host).toBe(MOCK);
    const csp = await notebookPolicy(local.model!.playground!, local.notebookLab);
    expect(csp).toMatch(new RegExp(`connect-src [^;]*${MOCK.replace(/\./g, "\\.")}`));

    const published = await resolve(site(`    enabled: true\n${ASSISTANT.replace(HOST, MOCK)}`));
    const error = published.diagnostics.errors.find((d) => d.code === "FP1236");
    expect(error?.pointer).toBe("/pythonPlayground/notebook/assistant/climateclaw/host");
    expect(error?.message).toMatch(/local development only/);

    const plain = await resolve(
      site(`    enabled: true\n${ASSISTANT.replace(HOST, "http://freva.example.org")}`, {
        origin: LOCAL,
      }),
    );
    // Plain http to anything but loopback is refused by the schema itself.
    expect(plain.diagnostics.errors.find((d) => d.code === "FP1104")?.pointer).toBe(
      "/pythonPlayground/notebook/assistant/climateclaw/host",
    );
  });

  it("passes the identity provider's issuer to the sign-in (RFC 9207)", async () => {
    const ISSUER = "https://keycloak.example.org/realms/Freva";
    const resolved = await resolve(
      site(`    enabled: true\n${ASSISTANT}        expectedIssuer: ${ISSUER}\n`),
    );
    expect(resolved.diagnostics.errors).toEqual([]);
    const lab = planNotebook(
      resolved.portalPlayground!,
      resolved.model!.playground!,
      [],
      resolved.notebookLab,
    ).lab!;
    expect(lab.overrides["@freva-org/jupyterlite-climateclaw:plugin"]).toMatchObject({
      expectedIssuer: ISSUER,
    });
    const without = await resolve(site(`    enabled: true\n${ASSISTANT}`));
    expect(playgroundIdentity(without.portalPlayground!).notebookAssistant).not.toBe(
      playgroundIdentity(resolved.portalPlayground!).notebookAssistant,
    );
    const plain = await resolve(
      site(`    enabled: true\n${ASSISTANT}        expectedIssuer: http://keycloak.example.org\n`),
    );
    expect(plain.diagnostics.errors.some((d) => d.code === "FP1104")).toBe(true);
  });

  it("links a landing to the notebook's Lab or file list", async () => {
    const blocks =
      "  - type: links\n" +
      "    heading: The notebook\n" +
      "    items:\n" +
      "      - label: Ask ClimateClaw in a notebook\n" +
      "        notebook: lab\n" +
      "      - label: Your notebooks\n" +
      "        notebook: files\n";
    const resolved = await resolve(site(`    enabled: true\n${ASSISTANT}`, { blocks }));
    expect(resolved.diagnostics.errors).toEqual([]);
    const block = resolved
      .model!.landings[0]!.blocks.flatMap((b) => (b.type === "links" ? [b] : []))
      .at(0)!;
    expect(block.actions!.map((a) => [a.href, a.external])).toEqual([
      [`${ORIGIN}/notebook/lab/index.html`, true],
      [`${ORIGIN}/notebook/tree/index.html`, true],
    ]);

    // No Lab without the assistant or the panel, and no notebook link without the notebook.
    const noLab = await resolve(site("    enabled: true\n", { blocks }));
    expect(noLab.diagnostics.errors.find((d) => d.code === "FP1201")?.message).toMatch(
      /no Lab interface/,
    );
    const off = await resolve(site("    enabled: false\n", { blocks }));
    expect(off.diagnostics.errors.find((d) => d.code === "FP1201")?.message).toMatch(
      /notebook is not enabled/,
    );
  });

  it("frames the notebook in a landing block, and lets only the portal frame it", async () => {
    const blocks = "  - type: notebook\n    heading: Try it in a notebook\n";
    const root = site(`    enabled: true\n${ASSISTANT}`, { blocks, runnableDocs: false });
    const resolved = await resolve(root);
    expect(resolved.diagnostics.errors).toEqual([]);
    const model = resolved.model!;
    const block = model.landings[0]!.blocks.find((b) => b.type === "notebook")!;
    expect(block).toMatchObject({
      heading: "Try it in a notebook",
      notebook: { origin: ORIGIN, src: `${ORIGIN}/notebook/lab/index.html`, view: "lab" },
    });
    // The window is named like the notebook's own tab, unless the block names it.
    expect(block.notebook!.title).toBe(`${model.site.title} Playground`);
    const named = await resolve(
      site(`    enabled: true\n${ASSISTANT}`, {
        blocks: `${blocks}    title: Splash zone\n`,
        runnableDocs: false,
      }),
    );
    expect(
      named.model!.landings[0]!.blocks.find((b) => b.type === "notebook")!.notebook!.title,
    ).toBe("Splash zone");
    // The portal may frame the playground origin; the entry imports the Maximize only now.
    const policy = hostPolicy({ model, evidence: {} as never, files: [], rstUsed: false }) as {
      csp: { portal: Record<string, string> };
    };
    expect(policy.csp.portal["frame-src"]).toContain(ORIGIN);
    expect(projectRuntime(model).notebook).toBe(true);
    expect(generateEntryModule(model)).toContain("mountNotebookEmbeds()");
    // The notebook: framed by the portal's own origin and nobody else; a top-level page without.
    const framed = await notebookPolicy(model.playground!, resolved.notebookLab, true);
    expect(framed).toContain(`frame-ancestors ${model.playground!.hostOrigin}`);
    expect(framed).not.toContain("frame-ancestors 'none'");
    const alone = await notebookPolicy(model.playground!, resolved.notebookLab);
    expect(alone).toContain("frame-ancestors 'none'");

    // Without a notebook block: no Maximize in the entry.
    const plain = await resolve(site(`    enabled: true\n${ASSISTANT}`, { runnableDocs: false }));
    expect(projectRuntime(plain.model!).notebook).toBeUndefined();
    expect(generateEntryModule(plain.model!)).not.toContain("notebook-embed");
  });

  it("shows the file list without a Lab, and nothing without the notebook (FP1201)", async () => {
    const files = "  - type: notebook\n    view: files\n";
    const plain = await resolve(site("    enabled: true\n", { blocks: files }));
    expect(plain.diagnostics.errors).toEqual([]);
    expect(plain.model!.landings[0]!.blocks.find((b) => b.type === "notebook")?.notebook?.src).toBe(
      `${ORIGIN}/notebook/tree/index.html`,
    );
    const lab = await resolve(site("    enabled: true\n", { blocks: "  - type: notebook\n" }));
    expect(lab.diagnostics.errors.find((d) => d.code === "FP1201")?.message).toMatch(
      /no Lab interface/,
    );
    const off = await resolve(site("    enabled: false\n", { blocks: files }));
    expect(off.diagnostics.errors.find((d) => d.code === "FP1201")?.message).toMatch(
      /notebook is not enabled/,
    );
    expect(off.model?.landings[0]?.blocks.some((b) => b.type === "notebook") ?? false).toBe(false);
  });

  it("refuses a panel naming no dataset-tree block, with the known ones (FP1237)", async () => {
    const resolved = await resolve(site(`    enabled: true\n    dataPanel:\n      tree: home-9\n`));
    const error = resolved.diagnostics.errors.find((d) => d.code === "FP1237");
    expect(error?.pointer).toBe("/pythonPlayground/notebook/dataPanel/tree");
    expect(error?.hint).toContain("home-2");
  });

  it("refuses an icon that is not a safe SVG (FP1402)", async () => {
    const resolved = await resolve(
      site(
        `    enabled: true\n    dataPanel:\n      tree: home-2\n      icon: ./assets/panel.svg\n`,
        {
          files: { "assets/panel.svg": "<svg><script>alert(1)</script></svg>" },
        },
      ),
    );
    expect(resolved.notebookLab?.dataPanel?.iconSvg ?? "").not.toContain("script");
  });

  it("is part of the playground identity (FP1215)", async () => {
    const resolved = await resolve(site(`    enabled: true\n${ASSISTANT}`));
    const identity = playgroundIdentity(resolved.portalPlayground!);
    expect(identity.notebookAssistant).toMatch(/^[0-9a-f]{16}$/);
    expect(identity.notebookDataPanel).toBeNull();
    const other = await resolve(
      site(`    enabled: true\n${ASSISTANT.replace("gpt-test", "gpt-other")}`),
    );
    expect(playgroundIdentity(other.portalPlayground!).notebookAssistant).not.toBe(
      identity.notebookAssistant,
    );
  });
});
