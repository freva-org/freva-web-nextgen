// The portal-level playground, from the built artifact. Three questions, of which the third
// costs the most work to answer honestly: does a marked snippet get a run control, an identity
// and a digest; does a page that has one carry the configuration, the provider and the policy it
// needs; and does a portal that has none carry NOTHING - no module, no chunk, no Worker, no
// widening - including when the capability is switched on and simply unused.
//
// The third is checked from the bytes on disk rather than the model, because a guarantee about
// what a visitor can fetch is a guarantee about files.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { writeConsumerSite } from "../helpers/consumer.js";
import type { BuildResult } from "../../src/artifact/index.js";

/**
 * A deployment that HOSTS its playground assets elsewhere, one of the two supported shapes. Stated
 * explicitly because the other - letting the portal serve them - needs real, digest-checked bytes,
 * and these tests are about something else. A build naming neither is refused (FP1223): the
 * defaults resolve to directories beside the Pyodide CDN, which do not exist. See
 * `tests/artifact/python-materials.test.ts` for both shapes.
 */
const HOSTED = {
  wheelhouseUrl: "https://assets.example.org/freva-wheels/",
  addonBaseUrl: "https://assets.example.org/python-addons/",
};
/** The same, for a profile that needs no wheelhouse. */
const HOSTED_ADDONS = { addonBaseUrl: "https://assets.example.org/python-addons/" };

afterAll(cleanupFixtures);

async function build(
  options: Parameters<typeof writeConsumerSite>[0],
  prefix: string,
): Promise<{ out: string; result: BuildResult }> {
  const root = writeConsumerSite(options);
  const out = join(tempRoot(prefix), "site");
  return { out, result: await buildFixture(root, out) };
}

/** Every file in the artifact, artifact-relative. */
function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? listFiles(full, `${prefix}${name}/`)
      : [`${prefix}${name}`];
  });
}

/** The concatenated bytes of every script and stylesheet the artifact serves. */
function code(out: string): string {
  return listFiles(out)
    .filter((file) => file.endsWith(".js") || file.endsWith(".css"))
    .map((file) => readFileSync(join(out, file), "utf8"))
    .join("\n");
}

const policy = (out: string): Record<string, string> =>
  (
    JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8")) as {
      csp: { portal: Record<string, string> };
    }
  ).csp.portal;

describe("1. a documentation page with a runnable snippet", () => {
  it("draws Copy and Try in Python, and sends only a name and a digest", async () => {
    const { out, result } = await build(
      { playground: { profile: "xarray-zarr" }, runnableDocs: true, pages: 2 },
      "portal-run-docs-",
    );
    expect(result.diagnostics.errors).toEqual([]);
    const html = readFileSync(join(out, "docs/page-0/index.html"), "utf8");

    expect(html).toContain('class="portal-code-actions"');
    expect(html.indexOf("portal-code-copy")).toBeLessThan(html.indexOf("portal-code-run"));
    expect(html).toContain('data-portal-example="content:content/page-0.md#1"');
    expect(html).toMatch(/data-portal-digest="[0-9a-f]{64}"/);
    // The digest is over the author's exact bytes, and it is the one the page carries.
    const source = "import xarray as xr\nprint(xr.__version__)";
    const digest = createHash("sha256").update(source, "utf8").digest("hex");
    expect(html).toContain(`data-portal-digest="${digest}"`);
    // The run button carries no source of its own; the copy control has it, once. Three code
    // blocks on the page, three copy controls, one run control.
    expect(html.match(/data-portal-copy="/g)?.length).toBe(3);
    expect(html.match(/data-portal-run=/g)?.length).toBe(1);
  }, 300_000);

  it("carries the page's own playground configuration, and only on that page", async () => {
    const { out } = await build(
      {
        playground: { profile: "xarray-zarr", addons: ["dask"], ...HOSTED_ADDONS },
        runnableDocs: true,
        pages: 2,
      },
      "portal-run-config-",
    );
    const page = readFileSync(join(out, "docs/page-0/index.html"), "utf8");
    const config = JSON.parse(
      /data-portal-python-playground="([^"]*)"/
        .exec(page)![1]!
        .replaceAll("&quot;", '"')
        .replaceAll("&amp;", "&"),
    ) as { profile: string; addons: string[]; examples: { id: string; title: string }[] };
    expect(config.profile).toBe("xarray-zarr");
    expect(config.addons).toEqual(["dask"]);
    expect(config.examples).toHaveLength(1);
    expect(config.examples[0]?.title).toBe("quickstart.py");

    // The landing has no runnable prose in this build, so it carries no configuration at all.
    const landing = readFileSync(join(out, "index.html"), "utf8");
    expect(landing).not.toContain("data-portal-python-playground");
  }, 300_000);

  it("gives the page a policy that permits a Worker and WebAssembly", async () => {
    const { out } = await build(
      { playground: { profile: "xarray-zarr" }, runnableDocs: true, pages: 1 },
      "portal-run-csp-",
    );
    const csp = policy(out);
    expect(csp["script-src"]).toContain("'wasm-unsafe-eval'");
    expect(csp["worker-src"]).toContain("'self'");
    expect(csp["connect-src"]).toContain("https://cdn.jsdelivr.net");
    expect(csp["script-src"]).not.toContain("'unsafe-eval'");
  }, 300_000);

  it("permits exactly the configured origins, and nothing a snippet mentions", async () => {
    const { out } = await build(
      {
        playground: {
          profile: "freva-client",
          ...HOSTED,
          connectOrigins: ["https://freva.example.org", "https://auth.example.org"],
        },
        runnableDocs: true,
        pages: 1,
      },
      "portal-run-origins-",
    );
    const connect = policy(out)["connect-src"]!.split(" ");
    expect(connect).toContain("https://freva.example.org");
    expect(connect).toContain("https://auth.example.org");
    // The fixture's unmarked block names `https://data.example.org`, which is in the policy for
    // the DATA BROWSER's service - configuration. Nothing may get in by being mentioned in Python.
    expect(connect).not.toContain("https://naturalearth.s3.amazonaws.com");
    // The two PyPI hosts ARE here, and not because a snippet said so: this is the `freva-client`
    // profile, whose startup resolves its dependencies from the index. `test.pypi.org` is the
    // one nothing asks for, so it is the one that proves a mention cannot add an origin.
    expect(connect).toContain("https://files.pythonhosted.org");
    expect(connect).toContain("https://pypi.org");
    expect(connect).not.toContain("https://test.pypi.org");
  }, 300_000);
});

describe("2. runnable prose on a landing", () => {
  it("registers the landing's snippet and leaves the documentation pages alone", async () => {
    const { out, result } = await build(
      { playground: {}, runnableProse: true, pages: 2 },
      "portal-run-prose-",
    );
    expect(result.diagnostics.errors).toEqual([]);
    const landing = readFileSync(join(out, "index.html"), "utf8");
    expect(landing).toContain("data-portal-python-playground");
    expect(landing).toContain("data-portal-example=");
    const page = readFileSync(join(out, "docs/page-0/index.html"), "utf8");
    expect(page).not.toContain("data-portal-python-playground");
    expect(page).not.toContain("data-portal-run");
  }, 300_000);

  it("shares one playground with a Python-enabled dataset tree on the same page", async () => {
    const { out, result } = await build(
      {
        python: true,
        profile: "xarray-zarr",
        playground: { profile: "xarray-zarr" },
        runnableProse: true,
      },
      "portal-run-mixed-",
    );
    expect(result.diagnostics.errors).toEqual([]);
    const landing = readFileSync(join(out, "index.html"), "utf8");
    // Both providers are on the page…
    expect(landing).toContain("data-portal-python-playground");
    expect(landing).toContain("data-portal-dataset-tree-python");
    // …and the entry chains them in the order the coordinator needs: content, trees, prepare.
    // Matched on the provider's own selector, a string, which survives minification.
    expect(code(out)).toContain("button[data-portal-run]");
  }, 300_000);

  it("refuses a page whose two providers disagree about the interpreter", async () => {
    const { result } = await build(
      {
        python: true,
        profile: "minimal",
        playground: { profile: "xarray-zarr" },
        runnableProse: true,
      },
      "portal-run-disagree-",
    );
    const conflict = result.diagnostics.errors.filter((d) => d.code === "FP1215");
    expect(conflict.length).toBeGreaterThan(0);
    expect(conflict[0]?.message).toContain("profile");
    expect(conflict.map((d) => d.message).join(" ")).toContain("pythonPlayground");
  }, 300_000);
});

describe("3. absence, which is the guarantee", () => {
  // Strings that exist ONLY because a playground does. `freva-term` is not among them: the Data
  // Browser owns `@freva-org/freva-client-terminal` for its own console, so the terminal's class
  // names are here whether or not anything runs Python, and a fingerprint with two reasons to
  // match proves nothing.
  const FINGERPRINTS = [
    "portal-python-window",
    "portal-python-session",
    "freva-python-console",
    "button[data-portal-run]",
    "data-portal-python-playground",
  ];

  it("ships nothing of the playground when the capability is not configured", async () => {
    const { out, result } = await build({ runnableDocs: true, pages: 2 }, "portal-run-off-");
    // The marker parses and is not an error; it simply means nothing here.
    expect(result.diagnostics.errors).toEqual([]);
    const html = readFileSync(join(out, "docs/page-0/index.html"), "utf8");
    expect(html).toContain("portal-code-copy");
    expect(html).not.toContain("data-portal-run");
    expect(html).not.toContain("portal-code-actions");
    expect(html).not.toContain("data-portal-python-playground");

    const bytes = code(out);
    for (const fingerprint of FINGERPRINTS) expect(bytes).not.toContain(fingerprint);
    expect(listFiles(out).some((file) => file.includes("browser-python.worker"))).toBe(false);
    const csp = policy(out);
    expect(csp["worker-src"]).toBeUndefined();
    expect(csp["script-src"]).not.toContain("'wasm-unsafe-eval'");
  }, 300_000);

  it("ships nothing when the capability is configured and no page marks a block", async () => {
    const { out, result } = await build(
      { playground: { profile: "xarray-zarr", addons: ["dask"], ...HOSTED_ADDONS }, pages: 2 },
      "portal-run-unused-",
    );
    // A warning, because a configuration that changes nothing is worth saying out loud…
    expect(result.diagnostics.errors).toEqual([]);
    expect(result.diagnostics.items.map((d) => d.code)).toContain("FP1222");
    // …and nothing else. No module, no Worker, no policy, no add-on reference.
    const bytes = code(out);
    for (const fingerprint of FINGERPRINTS) expect(bytes).not.toContain(fingerprint);
    expect(listFiles(out).some((file) => file.includes("browser-python.worker"))).toBe(false);
    expect(policy(out)["worker-src"]).toBeUndefined();
    // No add-on was configured, so no page names one and no policy permits one.
    expect(readFileSync(join(out, "docs/page-0/index.html"), "utf8")).not.toContain("dask");
    expect(listFiles(out).some((file) => file.endsWith(".whl"))).toBe(false);
  }, 300_000);

  it("records the absence as evidence rather than merely leaving files out", async () => {
    const { out } = await build({ playground: {}, pages: 1 }, "portal-run-evidence-");
    const evidence = JSON.parse(readFileSync(join(out, "component-evidence.json"), "utf8")) as {
      components: { id: string; enabled: boolean; modules: string[] }[];
    };
    const python = evidence.components.find((c) => c.id === "python-playground");
    expect(python).toBeDefined();
    expect(python?.enabled).toBe(false);
    expect(python?.modules).toEqual([]);
  }, 300_000);

  it("leaves an add-on out of the artifact when it was not configured", async () => {
    const { out } = await build(
      {
        playground: { profile: "xarray-zarr", addons: ["dask"], ...HOSTED_ADDONS },
        runnableDocs: true,
        pages: 1,
      },
      "portal-run-one-addon-",
    );
    const page = readFileSync(join(out, "docs/page-0/index.html"), "utf8");
    // The page asks for Dask and not Natural Earth, and the add-on list is exact: no page, policy
    // or emitted asset acquires the other one. Not claimed: the interpreter's Worker carries the
    // pinned CATALOGUE - every add-on's file names and digests - whatever a portal configured,
    // because a digest has to travel with the code that checks it, so the Worker mentions
    // `ne_110m_coastline` in a portal that will never fetch it. Add-on-specific is everything with
    // an effect: what is configured, prepared, fetched, and permitted.
    expect(page).toContain("dask");
    expect(page).not.toContain("cartopy-natural-earth-110m");
    expect(policy(out)["connect-src"]).not.toContain("naturalearth");
    expect(listFiles(out).some((file) => file.includes("ne_110m"))).toBe(false);
    expect(listFiles(out).some((file) => file.endsWith(".whl"))).toBe(false);
  }, 300_000);
});

describe("4. a tree-only portal is untouched", () => {
  it("builds exactly as it did, with no content provider anywhere in it", async () => {
    const { out, result } = await build(
      { python: true, profile: "xarray-zarr", pages: 2 },
      "portal-run-tree-only-",
    );
    expect(result.diagnostics.errors).toEqual([]);
    const bytes = code(out);
    // The playground is there - it is a tree playground…
    expect(bytes).toContain("freva-python-console");
    // …and the runnable-content provider is not, because no page has a marked block.
    expect(bytes).not.toContain("button[data-portal-run]");
    expect(readFileSync(join(out, "index.html"), "utf8")).not.toContain(
      "data-portal-python-playground",
    );
    expect(existsSync(join(out, "docs/page-0/index.html"))).toBe(true);
    expect(readFileSync(join(out, "docs/page-0/index.html"), "utf8")).not.toContain(
      "data-portal-run",
    );
  }, 300_000);
});
