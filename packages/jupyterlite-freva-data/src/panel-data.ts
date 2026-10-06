// The panel's data file, written by the site's prepare step (`portal-builder prepare-notebook`):
// the tree's source - the same configuration as the portal's dataset-tree block - and the
// examples and recipes the build registered with their SHA-256. A snippet reaches a notebook only
// if its bytes hash to the registered digest.

export const PANEL_DATA_SCHEMA = 1;

export interface S3Config {
  endpoint: string;
  origin: string;
  style: "path" | "virtual-host";
  roots: Array<{
    id?: string;
    name: string;
    bucket: string;
    prefix?: string;
    title?: string;
    description?: string;
    link?: { href: string; label?: string };
    planned?: string;
  }>;
  maxKeys?: number;
  maxPages?: number;
  requestTimeoutMs?: number;
  retries?: number;
  datasetSuffixes?: string[];
}

/** One catalogue example the build registered: (node, example) and the digest of its code. */
export interface RegisteredExample {
  datasetId: string;
  exampleId: string;
  sha256: string;
}

/** One live-archive recipe: a template with one hole, the digest of the template. */
export interface Recipe {
  id: string;
  label: string;
  description?: string;
  template: string;
  parameter: "https-url" | "s3-path";
  sha256: string;
  /** Whether the site's interpreter profile can run it (it imports nothing missing). */
  runnable: boolean;
}

export interface PanelData {
  schemaVersion: typeof PANEL_DATA_SCHEMA;
  /** The landing block this tree comes from, `<landing>-<index>`. */
  instanceId: string;
  mode: "snapshot" | "s3";
  /** The validated catalogue (snapshot mode). */
  catalog?: unknown;
  s3?: S3Config;
  /** Same-origin URL of the search index, relative to the site root (s3 mode). */
  searchIndex?: string;
  searchResultLimit?: number;
  expand: string[];
  statusLabel: string;
  examples: RegisteredExample[];
  recipes: Recipe[];
}

const HEX64 = /^[0-9a-f]{64}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Validate the file's shape; throws with the first problem. The catalogue is parsed later. */
export function parsePanelData(raw: unknown): PanelData {
  if (!isObject(raw)) throw new Error("the panel data is not an object");
  if (raw.schemaVersion !== PANEL_DATA_SCHEMA) throw new Error("unknown panel data version");
  const mode = raw.mode;
  if (mode !== "snapshot" && mode !== "s3") throw new Error("mode must be snapshot or s3");
  if (mode === "snapshot" && raw.catalog === undefined)
    throw new Error("a snapshot needs a catalog");
  let s3: S3Config | undefined;
  if (mode === "s3") {
    const cfg = raw.s3;
    if (!isObject(cfg) || typeof cfg.endpoint !== "string" || !Array.isArray(cfg.roots)) {
      throw new Error("an s3 tree needs an endpoint and roots");
    }
    const endpoint = new URL(cfg.endpoint);
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      throw new Error("the endpoint must be http(s)");
    }
    s3 = cfg as unknown as S3Config;
  }
  const examples = (Array.isArray(raw.examples) ? raw.examples : [])
    .filter(isObject)
    .filter(
      (e) =>
        typeof e.datasetId === "string" &&
        typeof e.exampleId === "string" &&
        typeof e.sha256 === "string" &&
        HEX64.test(e.sha256),
    )
    .map((e) => ({
      datasetId: e.datasetId as string,
      exampleId: e.exampleId as string,
      sha256: e.sha256 as string,
    }));
  const recipes = (Array.isArray(raw.recipes) ? raw.recipes : [])
    .filter(isObject)
    .filter(
      (r) =>
        typeof r.id === "string" &&
        typeof r.label === "string" &&
        typeof r.template === "string" &&
        (r.parameter === "https-url" || r.parameter === "s3-path") &&
        typeof r.sha256 === "string" &&
        HEX64.test(r.sha256),
    )
    .map((r) => ({
      id: r.id as string,
      label: r.label as string,
      ...(typeof r.description === "string" ? { description: r.description } : {}),
      template: r.template as string,
      parameter: r.parameter as Recipe["parameter"],
      sha256: r.sha256 as string,
      runnable: r.runnable === true,
    }));
  const searchIndex =
    typeof raw.searchIndex === "string" && /^[A-Za-z0-9._/-]+\.json$/.test(raw.searchIndex)
      ? raw.searchIndex
      : undefined;
  return {
    schemaVersion: PANEL_DATA_SCHEMA,
    instanceId: typeof raw.instanceId === "string" ? raw.instanceId : "",
    mode,
    ...(mode === "snapshot" ? { catalog: raw.catalog } : {}),
    ...(s3 ? { s3 } : {}),
    ...(searchIndex ? { searchIndex } : {}),
    ...(typeof raw.searchResultLimit === "number"
      ? { searchResultLimit: raw.searchResultLimit }
      : {}),
    expand: strings(raw.expand),
    statusLabel:
      typeof raw.statusLabel === "string" ? raw.statusLabel : mode === "s3" ? "LIVE" : "SNAPSHOT",
    examples,
    recipes,
  };
}
