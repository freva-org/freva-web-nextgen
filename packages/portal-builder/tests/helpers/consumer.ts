// A consumer-shaped portal: what a real deployment looks like, rather than what a unit test
// needs. Every other fixture in the suite is minimal on purpose, because a test reads more easily
// as one document than as a diff against a shared site. That is right for behaviour and wrong for
// SIZE: a dataset-tree stylesheet goes unnoticed while no fixture has a dataset tree, and the
// Python playground's chunks go unnoticed while no fixture enables one.
//
// So this one is shaped like a deployment: two components, a documentation tree with prose, code
// and mathematics, a themed preset, a catalogue with several collections, and optionally the
// Python playground. It is not any particular portal's configuration - calling a local fixture by
// a deployment's name is how a suite starts reporting somebody else's acceptance.

import { LOGO_SVG, tempRoot, write } from "./fixture.js";

export interface ConsumerOptions {
  /** Enable `dataset-tree.python` on the block. */
  python?: boolean;
  /** `autostart`, when Python is enabled. */
  autostart?: "never" | "after-interactive" | "immediately";
  /** Interpreter profile. `xarray-zarr` is what makes a live archive's HTTP recipe runnable. */
  profile?: "minimal" | "xarray-zarr" | "freva-client";
  /** Run the interpreter on its own origin instead of the portal's. */
  playgroundOrigin?: string;
  /** A self-hosted Pyodide directory, instead of the pinned CDN. Ends with a slash. */
  runtimeIndexUrl?: string;
  /** How many documentation pages to write. More pages, more syntax-highlighting CSS. */
  pages?: number;
  /**
   * Browse a live S3 gateway instead of a build-time catalogue: the shape a real archive uses,
   * and the one the size budget has to be measured against, because a live block reaches the S3
   * adapter, the access recipes and the in-page data inspector and a snapshot catalogue reaches
   * none of them. The roots are declared, so nothing is fetched at build time.
   */
  s3?: boolean;
  /** A second dataset-tree block, for the multiple-block tests. */
  secondBlock?: boolean;
  /**
   * The portal-level `pythonPlayground` stanza, and the marked snippets that give it meaning.
   * `playground` writes the stanza, `runnableDocs` marks a block on each documentation page, and
   * `runnableProse` marks one in the landing's prose block. Separate, because a stanza with
   * nothing marked must ship no interpreter at all.
   */
  playground?: {
    profile?: "minimal" | "xarray-zarr" | "freva-client";
    addons?: string[];
    autostart?: "never" | "after-interactive" | "immediately";
    maxSessions?: number;
    initialSource?: string;
    playgroundOrigin?: string;
    runtimeIndexUrl?: string;
    wheelhouseUrl?: string;
    addonBaseUrl?: string;
    connectOrigins?: string[];
    persistCredentials?: boolean;
  };
  runnableDocs?: boolean;
  runnableProse?: boolean;
  /** YAML for the second block's `python` stanza, already indented six spaces. */
  secondBlockPython?: string;
  /** Node ids in the second catalogue. Defaults to the SAME ids as the first. */
  secondBlockNodeId?: string;
  theme?: string;
}

/** A runnable snippet with no blanks in it, and a companion that is not Python. */
export const RUNNABLE =
  'import xarray as xr\n\nds = xr.open_zarr("https://data.example.org/tas.zarr")\nprint(ds)\n';
export const SHELL = "s5cmd cp s3://example/tas.zarr .\n";
/** The form a real catalogue uses for a snippet the reader has to complete. */
export const TEMPLATED = 'xr.open_zarr("https://data.example.org/<dataset>.zarr")\n';

export function catalogue(prefix = "cmip6", collections = 6, datasets = 5): unknown {
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-06T10:00:00Z",
    source: "https://data.example.org",
    roots: Array.from({ length: collections }, (_, i) => ({
      id: `${prefix}/c${i}`,
      kind: "collection",
      name: `collection-${i}`,
      title: `Collection ${i}`,
      description: "Model output, published as Zarr stores.",
      children: Array.from({ length: datasets }, (_, j) => ({
        id: `${prefix}/c${i}/d${j}`,
        kind: "dataset",
        name: `ds${j}.zarr`,
        path: `https://data.example.org/${prefix}/c${i}/ds${j}.zarr`,
        size: 1024 * (j + 1),
        availability: "available",
        examples: [
          {
            id: "python",
            label: "Python",
            language: "python",
            description: "Open the store directly.",
            code: RUNNABLE,
            executable: true,
          },
          { id: "cli", label: "CLI", language: "shell", code: SHELL },
          {
            id: "template",
            label: "Python (template)",
            language: "python",
            code: TEMPLATED,
            executable: true,
          },
        ],
      })),
    })),
  };
}

const PAGE = (name: string, runnable = false): string =>
  `---\ntitle: ${name}\n---\n\n# ${name}\n\nProse a reader is here for.\n\n` +
  (runnable
    ? '```python try-in-python title="quickstart.py"\nimport xarray as xr\nprint(xr.__version__)\n```\n\n'
    : "") +
  "```python\nimport xarray as xr\n\nds = xr.open_zarr(URL)\n```\n\n" +
  "```bash\ns5cmd ls s3://example/\n```\n\n" +
  "$$ \\int_0^1 x^2 \\, dx = \\tfrac{1}{3} $$\n\n" +
  ":::note\nAn admonition, because a real page has them.\n:::\n\n" +
  "| Column | Meaning |\n| --- | --- |\n| `tas` | Near-surface air temperature |\n";

/**
 * Where the block's rows come from: a catalogue file, or a declared live archive. The roots below
 * are the shape a deployment declares - a bucket, a prefix, a title, a project page and one
 * collection that is announced rather than browsable. No request is made for any of them at build
 * time or in a test: a live block lists when a row is expanded, in a browser.
 */
function treeSourceYaml(options: ConsumerOptions): string {
  if (!options.s3) return "    catalog: ../data/archive.json\n";
  return (
    `    s3:\n` +
    `      endpoint: https://objects.example.org\n` +
    `      style: path\n` +
    `      roots:\n` +
    `        - name: cmip6\n` +
    `          bucket: cmip6\n` +
    `          prefix: healpix/cmip6/\n` +
    `          title: CMIP6\n` +
    `          description: Coupled Model Intercomparison Project Phase 6\n` +
    `          link:\n` +
    `            href: https://wcrp-cmip.org/cmip-phase-6-cmip6\n` +
    `            label: Project page\n` +
    `        - name: cordex\n` +
    `          bucket: cordex\n` +
    `          prefix: healpix/cordex/\n` +
    `          title: CORDEX\n` +
    `          description: Coordinated Regional Climate Downscaling Experiment\n` +
    `        - name: xspies\n` +
    `          bucket: xspies\n` +
    `          title: XSpies\n` +
    `          description: km scale flagship ICON simulations\n` +
    `          planned: coming soon\n`
  );
}

/** The portal-level stanza, written only when the test asked for it. */
function playgroundYaml(options: ConsumerOptions): string {
  const playground = options.playground;
  if (!playground) return "";
  const list = (name: string, values: string[] | undefined): string =>
    values && values.length > 0
      ? `  ${name}:\n${values.map((value) => `    - ${value}\n`).join("")}`
      : "";
  return (
    `pythonPlayground:\n` +
    `  enabled: true\n` +
    `  profile: ${playground.profile ?? "minimal"}\n` +
    list("addons", playground.addons) +
    `  autostart: ${playground.autostart ?? "never"}\n` +
    `  maxSessions: ${playground.maxSessions ?? 2}\n` +
    (playground.initialSource ? `  initialSource: |\n    ${playground.initialSource}\n` : "") +
    (playground.playgroundOrigin ? `  playgroundOrigin: ${playground.playgroundOrigin}\n` : "") +
    (playground.runtimeIndexUrl ? `  runtimeIndexUrl: ${playground.runtimeIndexUrl}\n` : "") +
    (playground.wheelhouseUrl ? `  wheelhouseUrl: ${playground.wheelhouseUrl}\n` : "") +
    (playground.addonBaseUrl ? `  addonBaseUrl: ${playground.addonBaseUrl}\n` : "") +
    list("connectOrigins", playground.connectOrigins) +
    (playground.persistCredentials ? `  persistCredentials: true\n` : "") +
    `  terminal:\n` +
    `    style: freva-client-terminal\n` +
    `    osControls: auto\n` +
    `    alwaysOnTop: true\n` +
    `    rememberAppearance: true\n`
  );
}

function pythonYaml(options: ConsumerOptions): string {
  if (!options.python) return "";
  return (
    `    python:\n` +
    `      enabled: true\n` +
    `      profile: ${options.profile ?? "minimal"}\n` +
    `      autostart: ${options.autostart ?? "never"}\n` +
    `      maxSessions: 2\n` +
    (options.playgroundOrigin ? `      playgroundOrigin: ${options.playgroundOrigin}\n` : "") +
    (options.runtimeIndexUrl ? `      runtimeIndexUrl: ${options.runtimeIndexUrl}\n` : "") +
    `      terminal:\n` +
    `        style: freva-client-terminal\n` +
    `        osControls: auto\n` +
    `        alwaysOnTop: true\n` +
    `        rememberAppearance: true\n`
  );
}

export function writeConsumerSite(options: ConsumerOptions = {}): string {
  const root = tempRoot("portal-consumer-");
  write(root, "assets/logo.svg", LOGO_SVG);
  write(root, "assets/favicon.svg", LOGO_SVG);
  write(root, "data/archive.json", JSON.stringify(catalogue(), null, 2));
  if (options.secondBlock) {
    write(
      root,
      "data/second.json",
      JSON.stringify(catalogue(options.secondBlockNodeId ?? "cmip6", 2, 2), null, 2),
    );
  }
  for (let i = 0; i < (options.pages ?? 6); i += 1) {
    write(root, `content/page-${i}.md`, PAGE(`Page ${i}`, options.runnableDocs === true));
  }
  if (options.runnableProse) {
    write(
      root,
      "prose/intro.md",
      "Prose on the landing page, with something to run in it.\n\n" +
        "```python try-in-python\nprint('from the landing page')\n```\n",
    );
  }

  write(
    root,
    "landings/home.yaml",
    `schemaVersion: 1
title: Consumer Portal
blocks:
  - type: hero
    heading: Find and use the data
    summary: One archive, browsable from the landing page.
  - type: component-search
    component: data
    placeholder: Search datasets
${options.runnableProse ? "  - type: prose\n    source: ../prose/intro.md\n" : ""}  - type: dataset-tree
${treeSourceYaml(options)}    heading: Browse the archive
    summary: Expand a collection.
${pythonYaml(options)}${
      options.secondBlock
        ? `  - type: dataset-tree
    catalog: ../data/second.json
    heading: A second archive
${options.secondBlockPython ?? pythonYaml(options)}`
        : ""
    }`,
  );

  write(
    root,
    "portal.yaml",
    `schemaVersion: 1
site:
  id: consumer-portal
  title: Consumer Portal
  language: en
  canonicalUrl: https://portal.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
theme:
  preset: ${options.theme ?? "waterpark"}
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
  authBroker:
    kind: auth
    baseUrl: https://auth.example.org/v2
components:
  data:
    kind: databrowser
    enabled: true
    service: dataApi
    route: /data/
  login:
    kind: auth
    enabled: true
    service: authBroker
navigation:
  header:
    - landing: home
      label: Home
    - component: data
      label: Data
${playgroundYaml(options)}`,
  );
  return root;
}
