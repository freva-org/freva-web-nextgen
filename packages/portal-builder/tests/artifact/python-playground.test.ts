// The `dataset-tree.python` playground. Enabling it ships a WebAssembly interpreter, a terminal
// window, jQuery, jQuery Terminal and Prism on the strength of two lines of YAML, so the largest
// question is whether a portal that did not ask for it contains none of it, checked against built
// output rather than asserted. The rest is what the build owes the page when it IS asked for: a
// closed schema, a digest per runnable snippet computed from the bytes the build read, and a
// decision that reaches the generated entry as a literal import rather than a runtime flag.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  REPO_ROOT,
  cleanupFixtures,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { registerCatalogExamples, resolvePythonPlayground } from "../../src/model/dataset-tree.js";
import { projectRuntime, generateEntryModule } from "../../src/artifact/runtime-projection.js";
import { parseDatasetTreeCatalogV1 } from "@freva-org/dataset-tree/snapshot";

afterAll(cleanupFixtures);

const PKG = join(REPO_ROOT, "packages", "portal-builder");

/**
 * Traces only the playground can leave. String literals and DOM attribute names, never function
 * names: the bundler renames those, so a test looking for `createPythonPlayground` passes on a
 * build that shipped the whole interpreter under a mangled name. Each is asserted PRESENT in an
 * enabled build below - a fingerprint in no output proves nothing about output lacking it.
 */
const FINGERPRINTS = [
  "portal-python-window",
  "portal-python-session",
  "freva-python-console",
  "freva-term",
];

const OPEN = 'import xarray as xr\n\nds = xr.open_zarr("s3://freva/tas")\nprint(ds)\n';
const TEMPLATE = 'xr.open_zarr("<YOUR-BUCKET>/tas")\n';

const CATALOG = JSON.stringify({
  schemaVersion: 1,
  roots: [
    {
      id: "cmip6",
      kind: "collection",
      name: "CMIP6",
      children: [
        {
          id: "cmip6/tas",
          kind: "dataset",
          name: "tas",
          path: "s3://freva/tas",
          examples: [
            {
              id: "python",
              label: "Python",
              language: "python",
              code: OPEN,
              executable: true,
            },
            { id: "cli", label: "CLI", language: "shell", code: "s5cmd cp s3://freva/tas ." },
            {
              // Python, executable, registered - and a template, which the COMPONENT refuses.
              id: "token",
              label: "Python (token)",
              language: "python",
              code: TEMPLATE,
              executable: true,
            },
            {
              // Python and not marked executable: the build must not register it at all.
              id: "fragment",
              label: "Fragment",
              language: "python",
              code: "ds.tas.mean()",
            },
          ],
        },
      ],
    },
  ],
});

const sha256 = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

function landing(blockYaml: string): string {
  return `schemaVersion: 1
title: Test Site
blocks:
  - type: hero
    heading: Hello
${blockYaml}`;
}

const PLAIN_BLOCK = `  - type: dataset-tree
    catalog: ../data/archive.json
`;

const PYTHON_BLOCK = `  - type: dataset-tree
    catalog: ../data/archive.json
    python:
      enabled: true
      profile: xarray-zarr
      autostart: never
      maxSessions: 2
      initialSource: |
        print("Python is ready")
      terminal:
        style: freva-client-terminal
        osControls: auto
        alwaysOnTop: true
        rememberAppearance: true
`;

function site(block: string): string {
  const root = tempRoot("portal-py-");
  writeSite(root, { landing: landing(block) });
  write(root, "data/archive.json", CATALOG);
  return root;
}

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

interface Built {
  out: string;
  files: string[];
  html: string;
  code: string;
  evidence: {
    components: { id: string; kind: string; enabled: boolean; modules: string[] }[];
  };
}

async function build(root: string, prefix: string): Promise<Built> {
  const out = join(tempRoot(prefix), "site");
  const result = await buildFixture(root, out);
  expect(result.diagnostics.errors).toEqual([]);
  const files = tree(out);
  const code = files
    .filter((f) => f.endsWith(".js") || f.endsWith(".css"))
    .map((f) => readFileSync(join(out, ...f.split("/")), "utf8"))
    .join("\n");
  return {
    out,
    files,
    html: readFileSync(join(out, "index.html"), "utf8"),
    code,
    evidence: JSON.parse(
      readFileSync(join(out, "component-evidence.json"), "utf8"),
    ) as Built["evidence"],
  };
}

// the schema

describe("the python stanza's schema", () => {
  const schema = JSON.parse(readFileSync(join(PKG, "schema", "landing.schema.json"), "utf8")) as {
    $defs: Record<string, { properties?: Record<string, unknown>; additionalProperties?: boolean }>;
  };

  it("is a closed member of the dataset-tree block", () => {
    const python = schema.$defs.blockDatasetTree?.properties?.python as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(python).toBeTruthy();
    expect(python.additionalProperties).toBe(false);
    expect(python.required).toEqual(["enabled"]);
    expect(Object.keys(python.properties).sort()).toEqual([
      "autostart",
      "enabled",
      "initialSource",
      "maxSessions",
      "network",
      "playgroundOrigin",
      "profile",
      "runtimeIndexUrl",
      "terminal",
    ]);
  });

  it("caps sessions at two, in the schema and not only in the code", () => {
    const max = (
      schema.$defs.blockDatasetTree?.properties?.python as {
        properties: { maxSessions: { maximum: number; minimum: number } };
      }
    ).properties.maxSessions;
    expect(max.maximum).toBe(2);
    expect(max.minimum).toBe(1);
  });

  it("refuses a playground origin that is not an exact origin", async () => {
    for (const origin of ["*", "https://play.test/embed", "http://play.test", "play.test"]) {
      const root = site(`  - type: dataset-tree
    catalog: ../data/archive.json
    python:
      enabled: true
      playgroundOrigin: ${JSON.stringify(origin)}
`);
      const result = await resolveFixture(root);
      expect(result.diagnostics.errors.length, origin).toBeGreaterThan(0);
    }
  });

  it("refuses an unknown key rather than ignoring it", async () => {
    const root = site(`  - type: dataset-tree
    catalog: ../data/archive.json
    python:
      enabled: true
      sandbox: false
`);
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors.length).toBeGreaterThan(0);
  });
});

// registration

describe("what the build registers", () => {
  const catalog = parseDatasetTreeCatalogV1(JSON.parse(CATALOG));

  it("registers only the examples that are Python AND marked executable", () => {
    const registered = registerCatalogExamples(catalog, "home-2");
    expect(registered.map((e) => e.id)).toEqual([
      "home-2/cmip6%2Ftas/python",
      "home-2/cmip6%2Ftas/token",
    ]);
    // The shell example and the un-marked fragment are absent: an unregistered example can never
    // grow a run control, whatever the page later thinks.
    expect(registered.some((e) => e.id.endsWith("/cli"))).toBe(false);
    expect(registered.some((e) => e.id.endsWith("/fragment"))).toBe(false);
  });

  it("hashes the SOURCE, in UTF-8, and not a JSON envelope around it", () => {
    const registered = registerCatalogExamples(catalog, "home-2");
    const open = registered.find((e) => e.id === "home-2/cmip6%2Ftas/python");
    expect(open?.sha256).toBe(sha256(OPEN));
    expect(open?.datasetId).toBe("cmip6/tas");
  });

  it("registers a template too - refusing one is the component's job, not the build's", () => {
    // The build's question is "which snippets did I hash". Whether a particular one is offered is
    // decided against the same data by the component, and is strictly narrower.
    const registered = registerCatalogExamples(catalog, "home-2");
    expect(registered.find((e) => e.id === "home-2/cmip6%2Ftas/token")?.sha256).toBe(
      sha256(TEMPLATE),
    );
  });

  it("sorts by id, so one input produces one artifact", () => {
    const ids = registerCatalogExamples(catalog, "home-2").map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("resolves defaults that cost nothing, and honours what was written", () => {
    expect(resolvePythonPlayground(undefined, catalog, "home-2")).toBeUndefined();
    expect(resolvePythonPlayground({ enabled: false }, catalog, "home-2")).toBeUndefined();

    const bare = resolvePythonPlayground({ enabled: true }, catalog, "home-2");
    expect(bare).toMatchObject({
      profile: "minimal",
      autostart: "never",
      maxSessions: 2,
      terminal: { osControls: "auto", alwaysOnTop: true, rememberAppearance: true },
    });
    expect(bare?.initialSource).toBeUndefined();
    expect(bare?.playgroundOrigin).toBeUndefined();

    const full = resolvePythonPlayground(
      {
        enabled: true,
        profile: "xarray-zarr",
        autostart: "after-interactive",
        maxSessions: 1,
        initialSource: "print(1)",
        playgroundOrigin: "https://play.test",
        terminal: { osControls: "linux", alwaysOnTop: false, rememberAppearance: false },
      },
      catalog,
      "home-2",
    );
    expect(full).toMatchObject({
      profile: "xarray-zarr",
      autostart: "after-interactive",
      maxSessions: 1,
      initialSource: "print(1)",
      playgroundOrigin: "https://play.test",
      terminal: { osControls: "linux", alwaysOnTop: false, rememberAppearance: false },
    });
  });
});

// the projection

describe("the generated entry", () => {
  const model = (python: boolean) =>
    ({
      site: { id: "s", basePath: "/" },
      theme: {},
      chrome: { footer: {} },
      enabledComponents: [],
      landings: [
        {
          blocks: [
            {
              type: "dataset-tree",
              datasetTree: {
                instanceId: "home-1",
                ...(python
                  ? {
                      python: {
                        profile: "minimal",
                        autostart: "never",
                        maxSessions: 2,
                        terminal: {
                          osControls: "auto",
                          alwaysOnTop: true,
                          rememberAppearance: true,
                        },
                        examples: [],
                      },
                    }
                  : {}),
              },
            },
          ],
        },
      ],
    }) as unknown as Parameters<typeof projectRuntime>[0];

  it("names the playground only when a block asked for one", () => {
    expect(projectRuntime(model(false)).pythonPlayground).toBeUndefined();
    // `framed` is part of the projection because it decides which chunk loader the entry imports,
    // and an import is decided when the entry is written rather than when a visitor presses.
    expect(projectRuntime(model(true)).pythonPlayground).toEqual({
      instances: ["home-1"],
      framed: false,
      // No page of this portal has a runnable code block, so the entry names no content provider.
      content: false,
    });
  });

  it("imports the playground module literally, or not at all", () => {
    const without = generateEntryModule(model(false));
    expect(without).toContain("dataset-tree.ts");
    expect(without).not.toContain("python-ready.ts");
    expect(without).not.toContain("preparePythonPlayground");

    const with_ = generateEntryModule(model(true));
    expect(with_).toContain("python-ready.ts");
    // Chained on the mount's promise, not called beside it. `preparePythonPlayground` reads the
    // register the island fills and returns silently when empty, so calling it before every block
    // has mounted gives a Try control that renders and does nothing - and the mount is
    // asynchronous, because a live S3 block's adapter arrives through an import of its own.
    expect(with_).toContain(".then(() => preparePythonPlayground(loadLocalChunks));");
  });
});

// built output

describe("a portal that did not ask for a playground", () => {
  it("contains no interpreter, no terminal, and no trace of either", async () => {
    const built = await build(site(PLAIN_BLOCK), "portal-py-off-");
    for (const fingerprint of FINGERPRINTS) {
      expect(built.code, `the disabled build contains ${fingerprint}`).not.toContain(fingerprint);
    }
    // …and the tree it DID ask for is there, so this is a real absence rather than a build that
    // produced nothing.
    expect(built.code).toContain("dataset-tree__row");
    expect(built.html).not.toContain("data-portal-dataset-tree-python");
  });

  it("records the absence as evidence, separately from the tree's", async () => {
    const built = await build(site(PLAIN_BLOCK), "portal-py-off2-");
    const tree = built.evidence.components.find((c) => c.kind === "dataset-tree");
    const python = built.evidence.components.find((c) => c.kind === "python-playground");
    expect(tree?.enabled).toBe(true);
    expect(python?.enabled).toBe(false);
    expect(python?.modules ?? []).toEqual([]);
  });
});

describe("a portal that asked for one", () => {
  it("carries the configuration and the digests on the block, and the sources only once", async () => {
    const built = await build(site(PYTHON_BLOCK), "portal-py-on-");
    const match = /data-portal-dataset-tree-python="([^"]*)"/.exec(built.html);
    expect(match, "the block carries no python configuration").toBeTruthy();
    const encoded = match?.[1] ?? "";
    const config = JSON.parse(encoded.replaceAll("&quot;", '"').replaceAll("&#34;", '"')) as {
      profile: string;
      maxSessions: number;
      initialSource: string;
      examples: { id: string; sha256: string }[];
    };
    expect(config.profile).toBe("xarray-zarr");
    expect(config.maxSessions).toBe(2);
    expect(config.initialSource).toContain("Python is ready");
    // `home-1`: the landing is `home` and the dataset-tree block is its second entry.
    expect(config.examples.map((e) => e.id)).toEqual([
      "home-1/cmip6%2Ftas/python",
      "home-1/cmip6%2Ftas/token",
    ]);
    expect(config.examples.find((e) => e.id === "home-1/cmip6%2Ftas/python")?.sha256).toBe(
      sha256(OPEN),
    );

    // The SOURCE appears once, in the catalogue, not again in the configuration: the page has
    // every snippet already, and a second copy carrying a digest doubles the document for nothing.
    expect(JSON.stringify(config)).not.toContain("open_zarr");
  });

  it("ships the playground, and attributes it to its own evidence plan", async () => {
    const built = await build(site(PYTHON_BLOCK), "portal-py-on2-");
    for (const fingerprint of FINGERPRINTS) {
      expect(built.code, `the enabled build is missing ${fingerprint}`).toContain(fingerprint);
    }
    const python = built.evidence.components.find((c) => c.kind === "python-playground");
    expect(python?.enabled).toBe(true);
    expect(python?.modules.length ?? 0).toBeGreaterThan(0);
  });

  it("widens the policy exactly as far as an interpreter needs, and no further", async () => {
    const built = await build(site(PYTHON_BLOCK), "portal-py-csp-");
    const policy = JSON.parse(readFileSync(join(built.out, "host-policy.json"), "utf8")) as {
      csp: { portal: Record<string, string> };
    };
    const portal = policy.csp.portal;
    // WebAssembly compilation, and NOT `unsafe-eval`: the two are different permissions and only
    // one of them is an interpreter.
    expect(portal["script-src"]).toContain("'wasm-unsafe-eval'");
    expect(portal["script-src"]).not.toContain("'unsafe-eval'");
    expect(portal["script-src"]).toContain("https://cdn.jsdelivr.net");
    expect(portal["connect-src"]).toContain("https://cdn.jsdelivr.net");
    expect(portal["worker-src"]).toBe("'self'");
    // The console's surface builds its own markup with style attributes. `style-src` itself stays
    // `'self'`, so an injected `<style>` element or a remote stylesheet is still refused.
    expect(portal["style-src-attr"]).toContain("'unsafe-inline'");
    expect(portal["style-src"]).not.toContain("'unsafe-inline'");
    // Nothing was framed, so nothing may be.
    expect(portal["frame-src"]).toBeUndefined();
  });

  it("leaves the policy alone when the block did not ask for a playground", async () => {
    const built = await build(site(PLAIN_BLOCK), "portal-py-csp-off-");
    const policy = JSON.parse(readFileSync(join(built.out, "host-policy.json"), "utf8")) as {
      csp: { portal: Record<string, string> };
    };
    const portal = policy.csp.portal;
    expect(portal["script-src"]).not.toContain("wasm-unsafe-eval");
    expect(portal["script-src"]).not.toContain("jsdelivr");
    expect(portal["connect-src"]).not.toContain("jsdelivr");
    // `default-src 'none'` already denies these by fallback; a directive that is not there is not
    // a permission that was granted and then narrowed.
    expect(portal["worker-src"]).toBeUndefined();
    expect(portal["media-src"]).toBeUndefined();
    expect(portal["style-src-attr"]).toBeUndefined();
  });

  it("asks only for a frame when the interpreter has its own origin", async () => {
    const built = await build(
      site(`  - type: dataset-tree
    catalog: ../data/archive.json
    python:
      enabled: true
      playgroundOrigin: https://play.example.org
`),
      "portal-py-framed-",
    );
    const policy = JSON.parse(readFileSync(join(built.out, "host-policy.json"), "utf8")) as {
      csp: { portal: Record<string, string> };
    };
    const portal = policy.csp.portal;
    expect(portal["frame-src"]).toContain("https://play.example.org");
    // And nothing else: the PORTAL does not run the interpreter, so its policy has no reason to
    // permit WebAssembly, a Worker or a CDN, and widening both policies is the worst of the two.
    expect(portal["script-src"]).not.toContain("wasm-unsafe-eval");
    expect(portal["worker-src"]).toBeUndefined();
    expect(portal["connect-src"]).not.toContain("jsdelivr");
  });

  it("keeps the interpreter out of the entry chunk", async () => {
    // The point of the bridge: a visitor who never presses the button must not download jQuery
    // Terminal, so the console cannot be reachable by a static path from the entry every visitor runs.
    const built = await build(site(PYTHON_BLOCK), "portal-py-on3-");
    const scripts = [...built.html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(scripts.length, "the page loads no script at all").toBeGreaterThan(0);
    for (const src of scripts) {
      const file = src.replace(/^\//, "");
      const source = readFileSync(join(built.out, ...file.split("/")), "utf8");
      expect(source, `${file} carries the console`).not.toContain("freva-python-console");
      expect(source, `${file} carries jQuery Terminal`).not.toContain("jquery.terminal");
    }
    // …and the console IS in the artifact, in a chunk nobody loads until it is asked for.
    expect(built.code).toContain("freva-python-console");
  });
});
