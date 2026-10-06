// What the panel's actions do with a node, as pure functions: which snippets may go into a
// notebook, the notebook itself, the URL, and the question for ClimateClaw.
//
// A snippet goes into a notebook only if it is a complete, executable Python example (the
// dataset tree's own "Try in Python" rule) AND its bytes hash to the digest the site's build
// registered. For a live archive, the registered thing is the recipe template; the store is a
// parameter validated against the configured endpoint and roots before it fills the one hole.

import {
  isPythonLanguage,
  tryPythonEligible,
  type DatasetAccessExample,
  type DatasetTreeNode,
} from "@freva-org/dataset-tree";

import type { PanelData, Recipe, S3Config } from "./panel-data.js";

export interface Snippet {
  label: string;
  code: string;
  description?: string;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Live-archive recipes: the same rules as portal-builder's client/components/tree-recipes.ts.

const SAFE_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/;
export const STORE_PLACEHOLDER = "{{STORE}}";

export interface StoreBinding {
  s3Path: string;
  httpsUrl: string;
}

export function bindStore(
  s3Path: unknown,
  config: Pick<S3Config, "endpoint" | "style" | "roots">,
): StoreBinding | null {
  if (typeof s3Path !== "string" || !s3Path.startsWith("s3://")) return null;
  const rest = s3Path.slice("s3://".length);
  const slash = rest.indexOf("/");
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const key = slash === -1 ? "" : rest.slice(slash + 1);
  if (!bucket) return null;
  const root = config.roots.find((r) => r.bucket === bucket && key.startsWith(r.prefix ?? ""));
  if (!root || !SAFE_SEGMENT.test(bucket) || !SAFE_SEGMENT.test(key) || key.includes("..")) {
    return null;
  }
  let base: URL;
  try {
    base = new URL(config.endpoint);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  if (config.style === "virtual-host") {
    base.hostname = `${bucket}.${base.hostname}`;
    base.pathname = `${base.pathname.replace(/\/$/, "")}/${key}`;
  } else {
    base.pathname = `${base.pathname.replace(/\/$/, "")}/${bucket}/${key}`;
  }
  return { s3Path, httpsUrl: base.toString() };
}

/**
 * A value as the body of a Python string literal, which is where every hole sits: inserted
 * literally (a replacement callback, so `$&` and the like stay text), quotes, backslashes and
 * control characters escaped.
 */
export function pythonStringBody(value: string): string {
  let out = "";
  for (const c of value) {
    const code = c.charCodeAt(0);
    if (c === "\\" || c === '"' || c === "'") out += `\\${c}`;
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += c;
  }
  return out;
}

export function renderRecipe(recipe: Recipe, binding: StoreBinding, endpoint: string): string {
  const value =
    recipe.parameter === "https-url"
      ? binding.httpsUrl
      : `/${binding.s3Path.slice("s3://".length)}`;
  // One pass, so neither value is read for the other's hole.
  return recipe.template.replace(/\{\{(STORE|ENDPOINT)\}\}/g, (_, hole: string) =>
    pythonStringBody(hole === "STORE" ? value : endpoint),
  );
}

// examples per node

interface CatalogNodeLike {
  id: string;
  examples?: readonly DatasetAccessExample[];
  children?: readonly CatalogNodeLike[];
}

/** Catalogue examples by node id. */
export function catalogExamples(catalog: unknown): Map<string, DatasetAccessExample[]> {
  const out = new Map<string, DatasetAccessExample[]>();
  const walk = (nodes: readonly CatalogNodeLike[] | undefined) => {
    for (const node of nodes ?? []) {
      if (node.examples?.length) out.set(node.id, [...node.examples]);
      walk(node.children);
    }
  };
  walk((catalog as { roots?: readonly CatalogNodeLike[] } | null)?.roots);
  return out;
}

/** Everything the panel knows about a node's examples, and how to check them. */
export class ExampleIndex {
  private readonly byNode: Map<string, DatasetAccessExample[]>;
  private readonly registered: Map<string, string>;

  constructor(private readonly data: PanelData) {
    this.byNode = data.mode === "snapshot" ? catalogExamples(data.catalog) : new Map();
    this.registered = new Map(
      data.examples.map((e) => [`${e.datasetId}\u0000${e.exampleId}`, e.sha256] as const),
    );
  }

  /** The examples the tree shows for a node, each with the registered digest when there is one. */
  accessExamples(node: DatasetTreeNode): DatasetAccessExample[] {
    if (this.data.mode === "snapshot") {
      return (this.byNode.get(node.id) ?? []).map((example) => {
        const digest = this.registered.get(`${node.id}\u0000${example.id}`);
        return digest ? { ...example, digest } : { ...example };
      });
    }
    const s3 = this.data.s3;
    if (!s3 || node.kind !== "dataset") return [];
    const binding = bindStore(node.path, s3);
    if (!binding) return [];
    return this.data.recipes.map((recipe) => ({
      id: `recipe:${recipe.id}`,
      label: recipe.label,
      language: "python",
      ...(recipe.description ? { description: recipe.description } : {}),
      code: renderRecipe(recipe, binding, s3.endpoint),
      ...(recipe.runnable ? { digest: recipe.sha256, executable: true } : {}),
    }));
  }

  /**
   * The snippets that may go into a notebook: executable Python, no placeholder, a registered
   * digest, and bytes (catalogue code, or the recipe template) that hash to it.
   */
  async eligibleSnippets(node: DatasetTreeNode): Promise<Snippet[]> {
    const out: Snippet[] = [];
    const rule = { onTry: () => undefined };
    for (const example of this.accessExamples(node)) {
      if (!tryPythonEligible(example, rule)) continue;
      const hashed =
        this.data.mode === "snapshot"
          ? example.code
          : this.data.recipes.find((r) => `recipe:${r.id}` === example.id)?.template;
      if (hashed === undefined || (await sha256Hex(hashed)) !== example.digest) continue;
      out.push({
        label: example.label,
        code: example.code,
        ...(example.description ? { description: example.description } : {}),
      });
    }
    return out;
  }

  /** Python examples for Copy code when none is eligible: still only Python. */
  pythonExamples(node: DatasetTreeNode): Snippet[] {
    return this.accessExamples(node)
      .filter((e) => isPythonLanguage(e.language))
      .map((e) => ({ label: e.label, code: e.code }));
  }

  /** The node's HTTPS address: the store over the gateway, or the catalogue's inspect URL. */
  url(node: DatasetTreeNode): string | null {
    if (this.data.mode === "s3" && this.data.s3) {
      const binding = bindStore(node.path, this.data.s3);
      if (binding) return binding.httpsUrl;
    }
    for (const candidate of [node.inspect, node.path, node.link?.href]) {
      if (typeof candidate === "string" && /^https?:\/\//.test(candidate)) return candidate;
    }
    return null;
  }
}

// notebooks and cells

export interface CellJSON {
  cell_type: "markdown" | "code";
  source: string;
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: null;
}

export function displayName(node: DatasetTreeNode): string {
  return node.kind === "dataset" || node.kind === "file" ? node.name : node.title || node.name;
}

function markdownEscape(text: string): string {
  return text.replace(/([\\`*_[\]#<>])/g, "\\$1");
}

/**
 * A registered example's code as a notebook cell shows it best: a closing `print(name)` becomes
 * `name`, so Jupyter shows the object's rich view (xarray's HTML) rather than its text. Only for
 * notebook cells - an example also runs as a file (Try in Python, a copied script), where a bare
 * name prints nothing, so the example itself keeps its `print`.
 */
export function notebookCode(code: string): string {
  const lines = code.replace(/\n+$/, "").split("\n");
  const last = /^print\(\s*([A-Za-z_]\w*)\s*\)\s*$/.exec(lines.at(-1) ?? "");
  if (last) lines[lines.length - 1] = last[1]!;
  return lines.join("\n");
}

export function codeCells(snippets: Snippet[], node: DatasetTreeNode): CellJSON[] {
  return snippets.map((s) => ({
    cell_type: "code",
    source: notebookCode(s.code),
    metadata: { freva: { dataset: node.id, example: s.label } },
    outputs: [],
    execution_count: null,
  }));
}

export function notebookFor(
  node: DatasetTreeNode,
  snippets: Snippet[],
  options: { url: string | null; siteName: string; kernelName: string; kernelDisplayName: string },
): Record<string, unknown> {
  const lines = [`# ${markdownEscape(displayName(node))}`];
  if (node.title && node.title !== node.name) lines.push("", markdownEscape(node.title));
  if (node.description) lines.push("", markdownEscape(node.description));
  if (options.url) lines.push("", `\`${options.url.replace(/`/g, "")}\``);
  lines.push(
    "",
    snippets.length
      ? `_Access examples from the ${markdownEscape(options.siteName)} catalogue, each checked against the site's registered digest._`
      : `_No registered Python access example for this dataset._`,
  );
  const header: CellJSON = { cell_type: "markdown", source: lines.join("\n"), metadata: {} };
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        name: options.kernelName,
        display_name: options.kernelDisplayName,
        language: "python",
      },
      language_info: { name: "python" },
    },
    cells: [header, ...codeCells(snippets, node)].map((cell, i) => ({ ...cell, id: `cell-${i}` })),
  };
}

/** A file name for a node's notebook: its name, made safe. */
export function notebookBaseName(node: DatasetTreeNode): string {
  const base = displayName(node)
    .replace(/\.(zarr|nc|nc4|grib2?|h5|hdf5)$/i, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/^[.\s_-]+|[\s_-]+$/g, "")
    .slice(0, 64);
  return base || "dataset";
}

/** The question and context handed to `climateclaw:ask`. */
export function askFor(
  node: DatasetTreeNode,
  url: string | null,
  siteName: string,
): { prompt: string; context: string } {
  const facts: string[] = [`Dataset: ${displayName(node)}`];
  if (node.title && node.title !== node.name) facts.push(`Title: ${node.title}`);
  if (url) facts.push(`URL: ${url}`);
  if (node.path && node.path !== url) facts.push(`Path: ${node.path}`);
  if (node.description) facts.push(`Description: ${node.description}`);
  for (const metric of node.metrics ?? []) {
    facts.push(`${metric.label ?? "Metric"}: ${metric.value}`);
  }
  for (const detail of node.details ?? []) {
    facts.push(`${detail.label}: ${detail.values.map((v) => v.text).join(", ")}`);
  }
  if (typeof node.size === "number") facts.push(`Size: ${node.size} bytes`);
  return {
    prompt: `Help me open and explore this dataset from the ${siteName} data catalogue in Python.`,
    context: facts.join("\n"),
  };
}
