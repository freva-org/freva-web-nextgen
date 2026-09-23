// A site fixture whose three components can be toggled independently, used by the enablement
// matrix and by the artifact tests.

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalizeRoot } from "../../src/config/paths.js";
import { PACKAGE_ROOT } from "../../src/util/package.js";
import { buildSite, type BuildResult } from "../../src/artifact/index.js";
import { LOGO_SVG, tempRoot, write } from "./fixture.js";
import { planPythonMaterials, pythonMaterialsCacheKey } from "../../src/model/python-materials.js";

export interface MatrixOptions {
  databrowser: boolean;
  stac: boolean;
  auth: boolean;
  canonicalUrl?: string;
  /** A deployment's main colour, when the test is about what is derived from it. */
  accent?: string;
  /**
   * What the configuration says about the footer badge. Omitted means no `badge` key at all - the
   * case that matters most, because a file without one must still come out with a badge on it.
   */
  badge?: "off" | "auto" | "standard" | "kind-only" | "enabled";
  /** A footer that is switched off entirely. */
  footer?: boolean;
  /** Theme preset. Defaults to `default`; the budget test uses this to reach the largest build. */
  theme?: string;
  /** Add a `dataset-tree` block, with a small catalogue written beside the landing. */
  datasetTree?: boolean;
  /**
   * Extra YAML under the STAC component's `options:`, already indented six spaces. Most callers
   * want the component's defaults; a test about one option states it here rather than writing a
   * second whole site.
   */
  stacOptions?: string;
}

/** The `badge:` block each case writes, or nothing at all. */
const BADGE_YAML: Record<string, string> = {
  unset: "",
  off: "\n    badge:\n      enabled: false",
  auto: "\n    badge:\n      quality: auto",
  standard: "\n    badge:\n      quality: standard",
  // `kind` spelled out and nothing else, which is valid on its own.
  "kind-only": "\n    badge:\n      kind: freva",
  enabled: "\n    badge:\n      enabled: true",
};

export function writeMatrixSite(options: MatrixOptions): string {
  const root = tempRoot("portal-matrix-");
  write(root, "assets/logo.svg", LOGO_SVG);
  write(root, "assets/favicon.svg", LOGO_SVG);
  write(
    root,
    "content/guide.md",
    "---\ntitle: Guide\n---\n\nA page that exists whatever is enabled.\n",
  );
  write(
    root,
    "landings/home.yaml",
    `schemaVersion: 1
title: Matrix Site
blocks:
  - type: hero
    heading: Matrix
  - type: component-search
    component: data
    placeholder: Search
  - type: component-link
    component: catalog
    label: Catalog
${
  options.datasetTree
    ? "  - type: dataset-tree\n    catalog: ../data/archive.json\n    heading: Browse\n"
    : ""
}`,
  );
  if (options.datasetTree) {
    write(
      root,
      "data/archive.json",
      JSON.stringify({
        schemaVersion: 1,
        roots: [
          {
            id: "a",
            kind: "collection",
            name: "A",
            children: [{ id: "a/one", kind: "dataset", name: "one", size: 1024 }],
          },
        ],
      }),
    );
  }
  write(
    root,
    "portal.yaml",
    `schemaVersion: 1
site:
  id: matrix-site
  title: Matrix Site
  language: en
  canonicalUrl: ${options.canonicalUrl ?? "https://portal.example.org/"}
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
theme:
  preset: ${options.theme ?? "default"}${options.accent ? `\n  tokens:\n    colorAccent: "${options.accent}"` : ""}
chrome:
  footer:
    enabled: ${options.footer ?? true}${BADGE_YAML[options.badge ?? "unset"]}
rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
landings:
  home:
    path: /
    source: ./landings/home.yaml
services:
  dataApi:
    kind: databrowser
    baseUrl: https://data.example.org/api
    authentication: optional
  publicCatalog:
    kind: stac
    catalogUrl: https://catalog.example.org/stac/
  authBroker:
    kind: auth
    baseUrl: https://auth.example.org/v2
components:
  data:
    kind: databrowser
    enabled: ${options.databrowser}
    service: dataApi
    route: /data/
  catalog:
    kind: stac-browser
    enabled: ${options.stac}
    service: publicCatalog
    route: /catalog/${options.stacOptions ? `\n    options:\n${options.stacOptions}` : ""}
  login:
    kind: auth
    enabled: ${options.auth}
    service: authBroker
navigation:
  header:
    - landing: home
      label: Home
    - component: data
      label: Data
    - component: catalog
      label: Catalog
`,
  );
  return root;
}

/**
 * Prepared STAC materials for the suite, or nothing. A build consumes the directory it is given;
 * this is the SUITE's answer to the same question and a test-only convenience -
 * `FREVA_PORTAL_STAC_MATERIALS` for CI that prepared them somewhere, otherwise the sibling
 * workspace for a developer who ran the preparation locally. With none, the tests that need them
 * skip, so a checkout that has never fetched and compiled a third-party application still has a
 * passing suite.
 */
export function preparedStacMaterials(): string | undefined {
  const fromEnvironment = process.env.FREVA_PORTAL_STAC_MATERIALS;
  if (fromEnvironment && existsSync(join(fromEnvironment, "materials.json")))
    return fromEnvironment;
  const sibling = resolve(PACKAGE_ROOT, "..", "stac-browser", "materials");
  return existsSync(join(sibling, "materials.json")) ? sibling : undefined;
}

/** True when the suite can build a portal with the stac-browser component enabled. */
export const STAC_MATERIALS = preparedStacMaterials();

// A prepared Python materials directory, built ON DEMAND from the add-on preparer, on the same
// terms as the STAC materials above: a build that incorporates materials must be tested against
// REAL bytes, because the mechanism is digest verification and invented files verify nothing. So
// the add-on directory is prepared once, from the browser-python package's own `.addons` cache
// that the browser suites already use, laid out the way `prepare-playground` lays it out.
//
// DELIBERATELY ADD-ONS ONLY. The Freva wheelhouse has to DERIVE a browser build of
// `freva-client`, which needs the network and is not byte-reproducible across environments, while
// add-on artefacts are plain downloads with recorded digests. So the incorporation tests use an
// `xarray-zarr` portal with the `dask` add-on and no wheelhouse; the wheelhouse path is covered
// by the explicit-URL tests and by the real Waterpark build. Undefined when the artefacts are
// unavailable and cannot be fetched, so a checkout with no network has a passing suite.

/** The configuration the shared test materials are prepared for. Both add-ons; no wheelhouse. */
export const PYTHON_MATERIALS_PLAN = {
  profile: "xarray-zarr",
  addons: ["cartopy-natural-earth-110m", "dask"],
  optionalAddons: [],
} as const;

export function preparedPythonMaterials(): string | undefined {
  const fromEnvironment = process.env.FREVA_PORTAL_PYTHON_MATERIALS;
  if (fromEnvironment && existsSync(join(fromEnvironment, "PYTHON-MATERIALS.json")))
    return fromEnvironment;
  const cache = resolve(PACKAGE_ROOT, "..", "browser-python", ".addons");
  if (!existsSync(join(cache, "MANIFEST.json"))) return undefined;

  // Laid out as `prepare-playground` lays it out and RECORDED with the same cache key, so the
  // verification path under test is the real one rather than a relaxed variant.
  const out = join(tempRoot("portal-python-materials-"), "materials");
  mkdirSync(join(out, "python-addons"), { recursive: true });
  cpSync(cache, join(out, "python-addons"), { recursive: true });
  // BOTH add-ons, because that is what the shared `.addons` cache holds and a materials directory
  // is verified against the plan EXACTLY: a directory carrying an add-on the plan did not ask for
  // is rejected, so a portal cannot inherit a capability from a cache it shares.
  const plan = planPythonMaterials(PYTHON_MATERIALS_PLAN as never);
  writeFileSync(
    join(out, "PYTHON-MATERIALS.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        preparedBy: "tests/helpers/site.ts",
        preparedAt: new Date(0).toISOString(),
        cacheKey: pythonMaterialsCacheKey(plan),
        profile: plan.profile,
        addons: plan.addons,
        optionalAddons: plan.optionalAddons,
        runtime: plan.runtime,
        files: plan.files,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return out;
}

/** True when the suite can build a portal that incorporates Python materials. */
export const PYTHON_MATERIALS = preparedPythonMaterials();

export async function buildFixture(
  root: string,
  outDir: string,
  options: { pythonMaterials?: string } = {},
): Promise<BuildResult> {
  return buildSite({
    sourceRoot: canonicalizeRoot(root),
    configPath: join(root, "portal.yaml"),
    outDir,
    quiet: true,
    release: true,
    sourceDateEpoch: 1_760_000_000,
    ...(STAC_MATERIALS ? { stacMaterialsDir: STAC_MATERIALS } : {}),
    ...(options.pythonMaterials ? { pythonMaterialsDir: options.pythonMaterials } : {}),
  });
}
