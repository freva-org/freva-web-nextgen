// What a JupyterLite site needs to carry the data panel: its data file and its settings override.
//
// One implementation for every site that prepares a notebook with the panel - the portal builder's
// `prepare-notebook` and a documentation site's own small script - so the digests, the recipes and
// the settings shape cannot drift between them. Hand the result to
// `@freva-org/jupyterlite-freva-kernel/prepare`'s `prepareNotebookSite({ lab: { ... } })`.
//
// No DOM, no JupyterLab: this module runs in Node at build time, synchronously, and never reaches
// the network. It is not part of the extension's browser bundle.

import { createHash } from "node:crypto";

import { TREE_RECIPES, runnableRecipes, type TreeRecipe } from "@freva-org/dataset-tree/recipes";

import { PANEL_DATA_SCHEMA, parsePanelData, type PanelData, type S3Config } from "./panel-data.js";

/** The settings id the panel reads (`overrides.json`). */
export const DATA_PANEL_PLUGIN = "@freva-org/jupyterlite-freva-data:plugin";

/** The panel's primary action: its button, and Ctrl/Cmd+Enter. */
export type DataPanelAction =
  | "open-in-notebook"
  | "insert"
  | "inspect"
  | "ask-climateclaw"
  | "copy-url"
  | "copy-code";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface CatalogNodeLike {
  id: string;
  examples?: { id: string; language: string; code: string; executable?: boolean }[];
  children?: CatalogNodeLike[];
}

const PYTHON = new Set(["python", "python3", "py"]);

export interface PanelDataInput {
  /** A stable name for the tree, e.g. the landing block it mirrors (`home-1`). */
  instanceId: string;
  /** A live archive: the same configuration as the page's `createS3Source`. */
  s3?: S3Config;
  /** Or a validated build-time catalogue (`dataset-tree-catalog-v1`). */
  catalog?: unknown;
  /** Site-relative path of a published search index (live archives only). */
  searchIndex?: string;
  searchResultLimit?: number;
  /** Node ids expanded at start. */
  expand?: readonly string[];
  /** The status badge; default `LIVE` for a live archive, `SNAPSHOT` otherwise. */
  statusLabel?: string;
  /**
   * The Python packages the notebook's kernel has (its profile's), which decides which recipes
   * are runnable. See `@freva-org/dataset-tree/recipes` `runnableRecipes`.
   */
  packages: readonly string[];
  /** Recipes to register; default the shared `TREE_RECIPES`. */
  recipes?: readonly TreeRecipe[];
}

/**
 * The panel's data file: the tree's source plus the examples and recipes registered with the
 * SHA-256 of their bytes. The panel hashes a snippet again before it puts it into a notebook and
 * refuses one whose bytes are not these. The result is validated with the panel's own parser.
 */
export function buildPanelData(input: PanelDataInput): PanelData {
  const mode = input.s3 ? "s3" : "snapshot";
  if (input.s3 && input.catalog !== undefined) {
    throw new Error("a data panel shows either a live archive (s3) or a catalogue, not both");
  }
  if (!input.s3 && input.catalog === undefined) {
    throw new Error("a data panel needs a live archive (s3) or a catalogue");
  }
  const found: { datasetId: string; exampleId: string; code: string }[] = [];
  const walk = (nodes: readonly CatalogNodeLike[] | undefined): void => {
    for (const node of nodes ?? []) {
      for (const example of node.examples ?? []) {
        if (example.executable !== true) continue;
        if (!PYTHON.has(example.language.trim().toLowerCase())) continue;
        found.push({ datasetId: node.id, exampleId: example.id, code: example.code });
      }
      walk(node.children);
    }
  };
  if (mode === "snapshot") walk((input.catalog as { roots?: CatalogNodeLike[] } | null)?.roots);
  const examples: PanelData["examples"] = [];
  for (const example of found) {
    examples.push({
      datasetId: example.datasetId,
      exampleId: example.exampleId,
      sha256: sha256Hex(example.code),
    });
  }
  examples.sort((a, b) =>
    `${a.datasetId}\u0000${a.exampleId}` < `${b.datasetId}\u0000${b.exampleId}` ? -1 : 1,
  );
  const source = input.recipes ?? TREE_RECIPES;
  const runnable = new Set(runnableRecipes(input.packages, source));
  const recipes: PanelData["recipes"] = [];
  if (mode === "s3") {
    for (const recipe of source) {
      recipes.push({
        id: recipe.id,
        label: recipe.label,
        ...(recipe.description ? { description: recipe.description } : {}),
        template: recipe.template,
        parameter: recipe.parameter,
        sha256: sha256Hex(recipe.template),
        runnable: runnable.has(recipe.id),
      });
    }
  }
  const data: PanelData = {
    schemaVersion: PANEL_DATA_SCHEMA,
    instanceId: input.instanceId,
    mode,
    ...(mode === "snapshot" ? { catalog: input.catalog } : {}),
    ...(input.s3 ? { s3: input.s3 } : {}),
    ...(input.searchIndex ? { searchIndex: input.searchIndex } : {}),
    ...(input.searchResultLimit !== undefined
      ? { searchResultLimit: input.searchResultLimit }
      : {}),
    expand: [...(input.expand ?? [])],
    statusLabel: input.statusLabel ?? (mode === "s3" ? "LIVE" : "SNAPSHOT"),
    examples,
    recipes,
  };
  // The panel will parse it the same way; failing here is failing at build time.
  parsePanelData(JSON.parse(JSON.stringify(data)));
  return data;
}

export interface DataPanelSiteInput {
  /** From `buildPanelData`. */
  data: PanelData;
  /** The site's name, shown in the launcher ("New <site> notebook"). */
  siteName: string;
  /** The panel's title; default "<siteName> data". */
  title?: string;
  /** An SVG for the panel's icon; sanitise it first. */
  iconSvg?: string;
  /** Kernel the panel opens notebooks with; default `freva-python`. */
  kernelName?: string;
  defaultAction?: DataPanelAction;
  /**
   * Seed notebooks the panel offers (`Example notebooks`, and `?example=<path>` in the URL), as the
   * site publishes them: `name` is the path under `files/` (e.g. `examples/01_first_map.ipynb`).
   */
  seedNotebooks?: readonly { name: string; text: string }[];
  /** One of the seeds, opened when the Lab starts. */
  startNotebook?: string;
  /** GridLook's 3D globe in Inspect (the site's policy must then frame it). */
  gridlook?: boolean;
  launcher?: Partial<{ newNotebook: boolean; browse: boolean; examples: boolean; ask: boolean }>;
}

export interface DataPanelSite {
  /** Settings overrides, keyed by plugin id: pass as `lab.overrides`. */
  overrides: Record<string, Record<string, unknown>>;
  /** Files the site must carry (the data file): pass in `lab.files`. */
  files: { path: string; text: string }[];
  /** The data file's site path and digest, as the settings name them. */
  dataPath: string;
  dataSha256: string;
}

const SEED_PATH = /^[A-Za-z0-9][\w ./-]*\.ipynb$/;

function seedTitle(text: string, name: string): string {
  try {
    const nb = JSON.parse(text) as { cells?: { cell_type?: string; source?: string | string[] }[] };
    const first = nb.cells?.find((c) => c.cell_type === "markdown");
    const source = Array.isArray(first?.source) ? first.source.join("") : (first?.source ?? "");
    const heading = /^#[ \t]+(\S.*)$/m.exec(source)?.[1]?.trim();
    if (heading) return heading.slice(0, 80);
  } catch {
    // The kernel's prepare step validates seeds; a title is a nicety.
  }
  const base = name.split("/").pop() ?? name;
  return base.replace(/\.ipynb$/, "");
}

/**
 * The panel's settings and data file for a site. The data file is content-addressed
 * (`freva-data/panel.<sha12>.json`) and its digest is in the settings, so a stale file is refused
 * by the panel rather than shown.
 */
export function dataPanelSite(input: DataPanelSiteInput): DataPanelSite {
  const text = `${JSON.stringify(input.data)}\n`;
  const dataSha256 = sha256Hex(text);
  const dataPath = `freva-data/panel.${dataSha256.slice(0, 12)}.json`;
  const seeds = input.seedNotebooks ?? [];
  for (const seed of seeds) {
    if (!SEED_PATH.test(seed.name) || seed.name.includes("..")) {
      throw new Error(`seed notebook path not accepted by the panel: ${seed.name}`);
    }
  }
  if (input.startNotebook && !seeds.some((seed) => seed.name === input.startNotebook)) {
    throw new Error(`the start notebook ${input.startNotebook} is not one of the seed notebooks`);
  }
  const launcher = {
    newNotebook: true,
    browse: true,
    examples: true,
    ask: false,
    ...input.launcher,
  };
  return {
    overrides: {
      [DATA_PANEL_PLUGIN]: {
        siteName: input.siteName,
        title: input.title ?? `${input.siteName} data`,
        iconSvg: input.iconSvg ?? "",
        dataUrl: dataPath,
        dataSha256,
        kernelName: input.kernelName ?? "freva-python",
        defaultAction: input.defaultAction ?? "open-in-notebook",
        seedNotebooks: seeds.map((seed) => ({
          path: seed.name,
          title: seedTitle(seed.text, seed.name),
        })),
        gridlook: input.gridlook === true,
        ...(input.startNotebook ? { startNotebook: input.startNotebook } : {}),
        launcher,
      },
    },
    files: [{ path: dataPath, text }],
    dataPath,
    dataSha256,
  };
}

/**
 * The prebuilt extension directory of this package, for `lab.extensions`. A `file:` URL; convert
 * it with `fileURLToPath` from `node:url`.
 */
export const DATA_PANEL_LABEXTENSION = new URL("../labextension/", import.meta.url);
