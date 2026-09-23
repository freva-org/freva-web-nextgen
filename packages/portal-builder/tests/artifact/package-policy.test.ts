// The published policy and the sentence describing it, checked against each other from built
// bytes. Each half can be internally fine and still contradict the other: a help panel describing
// a normal Pyodide session beside a policy describing a curated deployment tells a visitor to run
// `await micropip.install("name")` in a build that has already decided the browser will refuse
// it, and they get `ValueError: Can't fetch metadata for …` for their trouble.
//
// So the check is not "is the help text nice". It is whether the page carries the SAME origins
// the header carries, whether there is no package index in either, and whether the parent's
// guarantee holds on the child origin too. All read from the artifact rather than the model,
// because a browser enforces the header on the file, not the object that produced it.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { writeConsumerSite } from "../helpers/consumer.js";
import { REFUSED_PACKAGE_ORIGINS } from "../../src/model/package-policy.js";
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

function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? listFiles(full, `${prefix}${name}/`)
      : [`${prefix}${name}`];
  });
}

const portalCsp = (out: string): Record<string, string> =>
  (
    JSON.parse(readFileSync(join(out, "host-policy.json"), "utf8")) as {
      csp: { portal: Record<string, string> };
    }
  ).csp.portal;

/** The playground configuration a page stamps for its own client code to read. */
function pageConfig(out: string, page: string): { packagePolicy: { origins: string[] } } {
  const html = readFileSync(join(out, page), "utf8");
  const match = /data-portal-python-playground="([^"]*)"/.exec(html);
  expect(match, "the page carries no playground configuration").toBeTruthy();
  const decoded = (match?.[1] ?? "")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'");
  return JSON.parse(decoded) as { packagePolicy: { origins: string[] } };
}

describe("1. the page and the header say the same thing", () => {
  it("stamps the resolved package policy, and every origin in it is in connect-src", async () => {
    const { out, result } = await build(
      {
        playground: {
          // Everything is actually USED here: freva-client installs the wheels, and an add-on is
          // configured, so all three origins are places this interpreter really fetches from.
          profile: "freva-client",
          addons: ["dask"],
          runtimeIndexUrl: "https://runtime.example.org/pyodide/",
          wheelhouseUrl: "https://wheels.example.org/python-wheels/",
          addonBaseUrl: "https://addons.example.org/python-addons/",
        },
        runnableDocs: true,
        pages: 1,
      },
      "portal-policy-agree-",
    );
    expect(result.diagnostics.errors).toEqual([]);

    const config = pageConfig(out, "docs/page-0/index.html");
    // The two PyPI hosts are here because the PROFILE puts them here: `freva-client` installs
    // its wheel with dependency resolution enabled, so micropip resolves against the index
    // during startup. The other three are the deployment's own configuration.
    expect(config.packagePolicy.origins).toEqual([
      "https://addons.example.org",
      "https://files.pythonhosted.org",
      "https://pypi.org",
      "https://runtime.example.org",
      "https://wheels.example.org",
    ]);

    // The agreement itself, not "connect-src looks sensible": every origin the page will tell a
    // visitor about has to be one the browser will permit.
    const connect = portalCsp(out)["connect-src"] ?? "";
    for (const origin of config.packagePolicy.origins) {
      expect(connect, `${origin} is advertised on the page but absent from connect-src`).toContain(
        origin,
      );
    }
  }, 300_000);

  it("permits nothing for an asset class this profile will never fetch", async () => {
    // A narrower policy than the configuration, deliberately. `xarray-zarr` does not install the
    // Freva wheels and this portal configures no add-ons, so neither directory is ever requested,
    // and an origin in `connect-src` that nothing fetches from is permission granted for no
    // reason. The policy follows what the interpreter will do, decided by the PROFILE and the
    // add-on list, not by which keys happen to be set.
    const { out, result } = await build(
      {
        playground: {
          profile: "xarray-zarr",
          runtimeIndexUrl: "https://runtime.example.org/pyodide/",
          wheelhouseUrl: "https://wheels.example.org/python-wheels/",
          addonBaseUrl: "https://addons.example.org/python-addons/",
        },
        runnableDocs: true,
        pages: 1,
      },
      "portal-policy-unused-",
    );
    expect(result.diagnostics.errors).toEqual([]);
    const config = pageConfig(out, "docs/page-0/index.html");
    expect(config.packagePolicy.origins).toEqual(["https://runtime.example.org"]);
    const connect = portalCsp(out)["connect-src"] ?? "";
    expect(connect).not.toContain("wheels.example.org");
    expect(connect).not.toContain("addons.example.org");
  }, 300_000);

  it("says nothing about a wheelhouse the deployment never configured", async () => {
    const { out } = await build(
      { playground: { profile: "minimal" }, runnableDocs: true, pages: 1 },
      "portal-policy-minimal-",
    );
    const config = pageConfig(out, "docs/page-0/index.html") as {
      packagePolicy: { origins: string[]; sources: Record<string, string> };
    };
    expect(config.packagePolicy.sources.wheelhouse).toBeUndefined();
    expect(config.packagePolicy.sources.addons).toBeUndefined();
    expect(config.packagePolicy.origins).toHaveLength(1);
  }, 300_000);
});

describe("2. a package index reaches a policy only when the profile needs one", () => {
  it("keeps a configured one out of the portal's own header", async () => {
    const { out } = await build(
      {
        playground: {
          profile: "freva-client",
          addons: ["dask"],
          ...HOSTED,
          connectOrigins: ["https://freva.example.org"],
        },
        runnableDocs: true,
        pages: 1,
      },
      "portal-policy-parent-",
    );
    const csp = portalCsp(out);
    const whole = Object.entries(csp)
      .map(([k, v]) => `${k} ${v}`)
      .join("; ");
    // `test.pypi.org` is the one no profile asks for, so it is the one that tells a configured
    // index from a required one: this deployment is on `freva-client`, whose own two hosts are
    // expected below, and nothing it CONFIGURES may add a third.
    expect(whole, "test.pypi.org is in the portal policy").not.toContain("https://test.pypi.org");
    expect(REFUSED_PACKAGE_ORIGINS).toContain("https://test.pypi.org");
    // Nor the loopholes that would make naming one unnecessary.
    expect(csp["connect-src"]).not.toContain("*");
    expect(csp["connect-src"]).not.toMatch(/(^|\s)https:(\s|$)/);
    // The service origin the deployment DID ask for is there, so this is not vacuously true.
    expect(csp["connect-src"]).toContain("https://freva.example.org");
  }, 300_000);

  it("names exactly the two the freva-client profile resolves against, and no more", async () => {
    // THE BLOCKER THIS EXISTS FOR. `freva-client` installs one derived wheel with dependency
    // resolution enabled, so a page whose `connect-src` names no index builds cleanly and then
    // fails at metadata lookup the first time a visitor starts the interpreter - a failure that
    // no build gate and no unit test can see, because both halves are individually correct.
    const { out, result } = await build(
      { playground: { profile: "freva-client", ...HOSTED }, runnableDocs: true, pages: 1 },
      "portal-policy-index-",
    );
    expect(result.diagnostics.errors).toEqual([]);
    const connect = portalCsp(out)["connect-src"] ?? "";
    expect(connect).toContain("https://pypi.org");
    expect(connect).toContain("https://files.pythonhosted.org");
    expect(connect).not.toContain("https://test.pypi.org");
  }, 300_000);

  it("names none of them for a profile that installs nothing from an index", async () => {
    const { out } = await build(
      { playground: { profile: "xarray-zarr" }, runnableDocs: true, pages: 1 },
      "portal-policy-noindex-",
    );
    const connect = portalCsp(out)["connect-src"] ?? "";
    for (const refused of REFUSED_PACKAGE_ORIGINS) {
      expect(connect, `${refused} is in a profile that needs no index`).not.toContain(refused);
    }
  }, 300_000);

  it("keeps them out of the separate origin's header as well", async () => {
    const { out } = await build({ python: true, playgroundOrigin: ORIGIN }, "portal-policy-child-");
    const deployment = JSON.parse(
      readFileSync(join(out, "playground-origin", "deploy.json"), "utf8"),
    ) as { headers: Record<string, string> };
    const csp = deployment.headers["Content-Security-Policy"] ?? "";
    for (const refused of REFUSED_PACKAGE_ORIGINS) {
      expect(csp, `${refused} is in the child policy`).not.toContain(refused);
    }
    // The child is where visitor Python runs, so this is the half that matters most: a parent
    // policy does not govern a fetch made from inside the frame.
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("connect-src *");
  }, 300_000);
});

describe("3. nothing executable, and no package source, is in the document", () => {
  it("puts no wheel URL and no install command in any attribute the page reads", async () => {
    const { out } = await build(
      {
        playground: {
          profile: "freva-client",
          addons: ["dask", "cartopy-natural-earth-110m"],
          wheelhouseUrl: "https://wheels.example.org/python-wheels/",
          addonBaseUrl: "https://wheels.example.org/python-addons/",
        },
        runnableDocs: true,
        pages: 1,
      },
      "portal-policy-dom-",
    );
    const html = readFileSync(join(out, "docs/page-0/index.html"), "utf8");
    // A content author has nowhere to put one, checked from the bytes. The page carries add-on
    // NAMES from a closed catalogue - a request for a prepared capability - and no URL, filename
    // or digest of any artefact: the URLs come from portal configuration and the digests are
    // compiled into the engine.
    expect(html).not.toMatch(/micropip\.install/);
    expect(html).not.toMatch(/\.whl\b/);
    // The index origins ARE in the page, in the resolved policy the help panel is rendered from,
    // because this profile reaches them - the page has to be able to say where its packages come
    // from. What must not be here is an artefact URL or an install command: the two hosts are
    // origins, with no path, no filename and no digest.
    expect(html).not.toMatch(/pythonhosted\.org\/[^"\s]/);
    expect(html).not.toMatch(/pypi\.org\/[^"\s]/);
    // The add-on names are there, so the absence above is not because the config is missing.
    expect(html).toContain("cartopy-natural-earth-110m");
  }, 300_000);

  it("ships no install advice in the client code either", async () => {
    const { out } = await build(
      { playground: { profile: "xarray-zarr" }, runnableDocs: true, pages: 1 },
      "portal-policy-code-",
    );
    const code = listFiles(out)
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFileSync(join(out, file), "utf8"))
      .join("\n");
    // What the bundle may CONTAIN and what the page may SAY are two questions. The install
    // example is real for an OPEN deployment, so its literal is in the client code of every
    // build - one component, two branches, and a minifier does not split a module by which
    // branch a portal takes - and asserting its absence from the bytes would assert that the
    // feature exists nowhere. What this build must not do is SHOW it, which is decided by the
    // resolved policy the artifact carries: no configured network mode resolves to `curated`,
    // and the panel's branch is on exactly that value.
    //
    // Matched on string literals, because a minifier rewrites identifiers and property access
    // but never the contents of a string.
    expect(code).toContain("This playground uses a curated Python environment");
    expect(code).toContain("a working STARTING environment, not a limit");
    expect(code).not.toContain("no subprocess and no disk");
    const config = listFiles(out)
      .filter((file) => file.endsWith(".html"))
      .map((file) => readFileSync(join(out, file), "utf8"))
      .join("\n");
    // HTML-escaped: the config travels in a `data-` attribute, so the quotes arrive as entities.
    expect(config).toContain("&quot;kind&quot;:&quot;curated&quot;");
    expect(config).not.toContain("&quot;kind&quot;:&quot;open&quot;");
    // This build performs no name-based install. `micropip.install` is shipped and used: it is
    // what the prepared loader runs, against explicit URLs and `emfs:` paths built from the
    // pinned catalogue. Every literal passed to a call must carry a scheme. The one bare name in
    // the bundle is the open branch's help row, an EXAMPLE FOR A READER TO TYPE rather than a
    // call, and it is matched as such.
    const EXAMPLE_ROW = 'await micropip.install("name")';
    for (const match of code.matchAll(/micropip\.install\(\s*(["'`])([^"'`\n]*)\1/g)) {
      const argument = match[2] ?? "";
      if (/^(https?|emfs):/.test(argument)) continue;
      const at = match.index ?? 0;
      expect(
        code.slice(Math.max(0, at - EXAMPLE_ROW.length), at + EXAMPLE_ROW.length + 8),
        `a name-based install survived: micropip.install("${argument}")`,
      ).toContain(EXAMPLE_ROW);
    }
    // What a RESTRICTED portal's reader is told, and the inspection call that works in both modes.
    expect(code).toContain("Installing packages by name from a public index is not enabled");
    expect(code).toContain("micropip.list()");
  }, 300_000);
});

describe("4. the separate playground origin carries the same requirement", () => {
  // THE HALF THAT MATTERS MOST in the two-origin topology: the Worker that runs the visitor's
  // Python is on the CHILD origin, under the CHILD's policy, and a parent policy does not
  // govern a fetch made from inside the frame. So the index has to be in both, or the profile
  // starts on a single-origin deployment and fails on the recommended one.
  it("names the index in the child's header for the freva-client profile", async () => {
    const { out, result } = await build(
      {
        // `profile` at this level is the BLOCK's, and the child artifact is built from the
        // block. The portal stanza beside it has to agree, which is what
        // `checkPlaygroundAgreement` enforces.
        python: true,
        profile: "freva-client",
        playgroundOrigin: ORIGIN,
        playground: { profile: "freva-client", playgroundOrigin: ORIGIN, ...HOSTED },
      },
      "portal-policy-child-index-",
    );
    expect(result.diagnostics.errors).toEqual([]);
    const deployment = JSON.parse(
      readFileSync(join(out, "playground-origin", "deploy.json"), "utf8"),
    ) as { headers: Record<string, string> };
    const csp = deployment.headers["Content-Security-Policy"] ?? "";
    expect(csp).toContain("https://pypi.org");
    expect(csp).toContain("https://files.pythonhosted.org");
    expect(csp).not.toContain("https://test.pypi.org");
  }, 300_000);
});
