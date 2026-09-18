// snapshot/parse.ts - the gate between an untrusted JSON blob and the view: everything the tree
// renders in snapshot mode passes through here. The validator is closed (an unrecognised property
// is an error, never a silent drop), exhaustive (every problem in one pass) and positional (each
// diagnostic names the failing JSON pointer), because "invalid catalog" tells the person staring at
// a 4,000-line generated file nothing. It is hand-written, not a bundled JSON-Schema runtime: the
// package ships zero runtime dependencies, `schema/dataset-tree-catalog-v1.schema.json` is
// published beside it for build tooling, and `tests/schema-parity.test.ts` keeps the two in step.

import type {
  DatasetAccessExample,
  DatasetTreeAccess,
  DatasetTreeAvailability,
  DatasetTreeDetailField,
  DatasetTreeDetailValue,
  DatasetTreeLink,
  DatasetTreeMetric,
  DatasetTreeNode,
  DatasetTreeNodeKind,
} from "../types.js";

/** One thing wrong with the input, and exactly where. */
export interface DatasetTreeCatalogDiagnostic {
  /** RFC 6901 JSON pointer, e.g. `/roots/0/children/2/kind`. `""` is the document itself. */
  path: string;
  /** Stable machine-readable reason. */
  code:
    | "not-an-object"
    | "unknown-property"
    | "missing-property"
    | "invalid-type"
    | "invalid-value"
    | "empty-string"
    | "duplicate-id";
  message: string;
}

/** Thrown by {@link parseDatasetTreeCatalogV1}. Carries every diagnostic, not just the first. */
export class DatasetTreeCatalogError extends Error {
  readonly diagnostics: readonly DatasetTreeCatalogDiagnostic[];

  constructor(diagnostics: readonly DatasetTreeCatalogDiagnostic[]) {
    const head = diagnostics
      .slice(0, 5)
      .map((d) => `  ${d.path || "/"}: ${d.message}`)
      .join("\n");
    const rest = diagnostics.length > 5 ? `\n  … and ${diagnostics.length - 5} more` : "";
    super(`dataset-tree catalog is not valid (${diagnostics.length} problems):\n${head}${rest}`);
    this.name = "DatasetTreeCatalogError";
    this.diagnostics = diagnostics;
  }
}

/**
 * A catalog node: a {@link DatasetTreeNode} that may carry its children - and its examples - inline.
 * `examples` is a deployment's own code samples; the package ships none and hard-codes no Python.
 * In the catalogue rather than a per-host `accessExamples` callback, one document describes an
 * archive completely and one build can hash what it lets anybody run. `digest` is deliberately not
 * in the format: one a catalogue author typed is one nobody computed, so the build fills it in from
 * the source it reads, which is what makes it worth checking at the far end.
 */
export interface DatasetTreeCatalogNode extends DatasetTreeNode {
  readonly children?: readonly DatasetTreeCatalogNode[];
  readonly examples?: readonly DatasetAccessExample[];
}

/** The parsed, frozen catalog. */
export interface DatasetTreeCatalog {
  readonly schemaVersion: 1;
  /**
   * When the generator ran, ISO-8601. Optional and never invented - freshness is the one claim a
   * snapshot must not fake, so no generation time means a footer with no date, not a plausible one.
   */
  readonly generatedAt?: string;
  /** The public location the snapshot describes, e.g. an object-store endpoint. Text only. */
  readonly source?: string;
  readonly roots: readonly DatasetTreeCatalogNode[];
}

const KINDS: readonly DatasetTreeNodeKind[] = ["collection", "directory", "dataset", "file"];
const AVAILABILITY: readonly DatasetTreeAvailability[] = [
  "available",
  "planned",
  "restricted",
  "unavailable",
];

const NODE_PROPERTIES = new Set([
  "id",
  "kind",
  "name",
  "title",
  "path",
  "description",
  "hasChildren",
  "size",
  "mediaType",
  "modifiedAt",
  "availability",
  "availabilityNote",
  "access",
  "link",
  "metrics",
  "details",
  "inspect",
  "metadata",
  "examples",
  "children",
]);

const ACCESS_PROPERTIES = new Set(["label", "href", "value", "description"]);
// `digest` is absent on purpose, its absence enforced (see `DatasetTreeCatalogNode`): a catalogue
// carrying one would assert a hash it did not compute, which the closed check makes a build error.
const EXAMPLE_PROPERTIES = new Set([
  "id",
  "label",
  "language",
  "code",
  "description",
  "executable",
]);
const LINK_PROPERTIES = new Set(["href", "label"]);
const METRIC_PROPERTIES = new Set(["label", "value", "style"]);
const DETAIL_PROPERTIES = new Set(["label", "values"]);
const DETAIL_VALUE_PROPERTIES = new Set(["text", "value"]);
const METRIC_STYLES = ["pill", "plain"] as const;

/** RFC 6901 escaping, so a key containing `/` or `~` still produces a usable pointer. */
function pointer(base: string, key: string | number): string {
  const token = String(key).replace(/~/g, "~0").replace(/\//g, "~1");
  return `${base}/${token}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Collector {
  readonly diagnostics: DatasetTreeCatalogDiagnostic[] = [];

  add(path: string, code: DatasetTreeCatalogDiagnostic["code"], message: string): void {
    this.diagnostics.push({ path, code, message });
  }

  /** A required, non-empty string. */
  requiredString(container: Record<string, unknown>, path: string, key: string): string | null {
    const value = container[key];
    if (value === undefined) {
      this.add(pointer(path, key), "missing-property", `\`${key}\` is required`);
      return null;
    }
    if (typeof value !== "string") {
      this.add(pointer(path, key), "invalid-type", `\`${key}\` must be a string`);
      return null;
    }
    if (value.length === 0) {
      this.add(pointer(path, key), "empty-string", `\`${key}\` must not be empty`);
      return null;
    }
    return value;
  }

  optionalString(
    container: Record<string, unknown>,
    path: string,
    key: string,
  ): string | undefined {
    const value = container[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      this.add(pointer(path, key), "invalid-type", `\`${key}\` must be a string`);
      return undefined;
    }
    return value;
  }

  optionalBoolean(
    container: Record<string, unknown>,
    path: string,
    key: string,
  ): boolean | undefined {
    const value = container[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      this.add(pointer(path, key), "invalid-type", `\`${key}\` must be true or false`);
      return undefined;
    }
    return value;
  }

  /** A non-negative, finite number. Byte counts are the only numeric field in the format. */
  optionalSize(container: Record<string, unknown>, path: string, key: string): number | undefined {
    const value = container[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.add(pointer(path, key), "invalid-type", `\`${key}\` must be a finite number`);
      return undefined;
    }
    if (value < 0) {
      this.add(pointer(path, key), "invalid-value", `\`${key}\` must not be negative`);
      return undefined;
    }
    return value;
  }

  closed(container: Record<string, unknown>, path: string, allowed: ReadonlySet<string>): void {
    for (const key of Object.keys(container)) {
      if (allowed.has(key)) continue;
      // Reported rather than dropped: a typo'd `titel` that vanishes silently renders wrongly for
      // months, and an extension nobody validated is how a closed format stops being closed.
      this.add(pointer(path, key), "unknown-property", `unknown property \`${key}\``);
    }
  }
}

function parseAccess(
  collector: Collector,
  raw: unknown,
  path: string,
): readonly DatasetTreeAccess[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    collector.add(path, "invalid-type", "`access` must be an array");
    return undefined;
  }
  const out: DatasetTreeAccess[] = [];
  raw.forEach((entry, index) => {
    const entryPath = pointer(path, index);
    if (!isPlainObject(entry)) {
      collector.add(entryPath, "not-an-object", "each access entry must be an object");
      return;
    }
    collector.closed(entry, entryPath, ACCESS_PROPERTIES);
    const label = collector.requiredString(entry, entryPath, "label");
    if (label === null) return;
    const access: DatasetTreeAccess = { label };
    const href = collector.optionalString(entry, entryPath, "href");
    if (href !== undefined) (access as { href?: string }).href = href;
    const value = collector.optionalString(entry, entryPath, "value");
    if (value !== undefined) (access as { value?: string }).value = value;
    const description = collector.optionalString(entry, entryPath, "description");
    if (description !== undefined) (access as { description?: string }).description = description;
    out.push(Object.freeze(access));
  });
  return Object.freeze(out);
}

/**
 * A node's code samples. `id`, `label`, `language` and `code` are all required: an example a build
 * may register and a page may offer to run needs a stable name and an explicit language, and
 * deriving either - id from position, language from the tab label - would let a reordering edit
 * silently change which code a button runs. Ids are unique within a node, not across the catalogue;
 * two datasets both offering `python` is ordinary, and a global name pairs node id with example id.
 */
function parseExamples(
  collector: Collector,
  raw: unknown,
  path: string,
): readonly DatasetAccessExample[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    collector.add(path, "invalid-type", "`examples` must be an array");
    return undefined;
  }
  const out: DatasetAccessExample[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const entryPath = pointer(path, index);
    if (!isPlainObject(entry)) {
      collector.add(entryPath, "not-an-object", "each example must be an object");
      return;
    }
    collector.closed(entry, entryPath, EXAMPLE_PROPERTIES);
    const id = collector.requiredString(entry, entryPath, "id");
    const label = collector.requiredString(entry, entryPath, "label");
    const language = collector.requiredString(entry, entryPath, "language");
    const code = collector.requiredString(entry, entryPath, "code");
    if (id === null || label === null || language === null || code === null) return;
    if (seen.has(id)) {
      collector.add(
        pointer(entryPath, "id"),
        "duplicate-id",
        `example id \`${id}\` is used twice on this node`,
      );
      return;
    }
    seen.add(id);
    const example: Record<string, unknown> = { id, label, language, code };
    const description = collector.optionalString(entry, entryPath, "description");
    if (description !== undefined) example.description = description;
    const executable = collector.optionalBoolean(entry, entryPath, "executable");
    if (executable !== undefined) example.executable = executable;
    out.push(Object.freeze(example) as unknown as DatasetAccessExample);
  });
  return Object.freeze(out);
}

function parseLink(collector: Collector, raw: unknown, path: string): DatasetTreeLink | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    collector.add(path, "not-an-object", "`link` must be an object");
    return undefined;
  }
  collector.closed(raw, path, LINK_PROPERTIES);
  const href = collector.requiredString(raw, path, "href");
  if (href === null) return undefined;
  const link: DatasetTreeLink = { href };
  const label = collector.optionalString(raw, path, "label");
  if (label !== undefined) (link as { label?: string }).label = label;
  return Object.freeze(link);
}

function parseMetrics(
  collector: Collector,
  raw: unknown,
  path: string,
): readonly DatasetTreeMetric[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    collector.add(path, "invalid-type", "`metrics` must be an array");
    return undefined;
  }
  const out: DatasetTreeMetric[] = [];
  raw.forEach((entry, index) => {
    const entryPath = pointer(path, index);
    if (!isPlainObject(entry)) {
      collector.add(entryPath, "not-an-object", "each metric must be an object");
      return;
    }
    collector.closed(entry, entryPath, METRIC_PROPERTIES);
    const value = collector.requiredString(entry, entryPath, "value");
    if (value === null) return;
    const metric: DatasetTreeMetric = { value };
    const label = collector.optionalString(entry, entryPath, "label");
    if (label !== undefined) (metric as { label?: string }).label = label;
    const style = entry.style;
    if (style !== undefined) {
      if (typeof style !== "string" || !METRIC_STYLES.includes(style as "pill" | "plain")) {
        collector.add(
          pointer(entryPath, "style"),
          "invalid-value",
          `\`style\` must be one of ${METRIC_STYLES.join(", ")}`,
        );
      } else {
        (metric as { style?: "pill" | "plain" }).style = style as "pill" | "plain";
      }
    }
    out.push(Object.freeze(metric));
  });
  return Object.freeze(out);
}

function parseDetails(
  collector: Collector,
  raw: unknown,
  path: string,
): readonly DatasetTreeDetailField[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    collector.add(path, "invalid-type", "`details` must be an array");
    return undefined;
  }
  const out: DatasetTreeDetailField[] = [];
  raw.forEach((entry, index) => {
    const entryPath = pointer(path, index);
    if (!isPlainObject(entry)) {
      collector.add(entryPath, "not-an-object", "each detail field must be an object");
      return;
    }
    collector.closed(entry, entryPath, DETAIL_PROPERTIES);
    const label = collector.requiredString(entry, entryPath, "label");
    const valuesPath = pointer(entryPath, "values");
    const values: DatasetTreeDetailValue[] = [];
    if (entry.values === undefined) {
      collector.add(valuesPath, "missing-property", "`values` is required");
    } else if (!Array.isArray(entry.values)) {
      collector.add(valuesPath, "invalid-type", "`values` must be an array");
    } else {
      entry.values.forEach((value, i) => {
        const valuePath = pointer(valuesPath, i);
        if (!isPlainObject(value)) {
          collector.add(valuePath, "not-an-object", "each value must be an object");
          return;
        }
        collector.closed(value, valuePath, DETAIL_VALUE_PROPERTIES);
        const text = collector.requiredString(value, valuePath, "text");
        if (text === null) return;
        const detail: DatasetTreeDetailValue = { text };
        const emphasised = collector.optionalString(value, valuePath, "value");
        if (emphasised !== undefined) (detail as { value?: string }).value = emphasised;
        values.push(Object.freeze(detail));
      });
    }
    if (label === null) return;
    out.push(Object.freeze({ label, values: Object.freeze(values) }));
  });
  return Object.freeze(out);
}

function parseNode(
  collector: Collector,
  raw: unknown,
  path: string,
  seen: Map<string, string>,
): DatasetTreeCatalogNode | null {
  if (!isPlainObject(raw)) {
    collector.add(path, "not-an-object", "a node must be an object");
    return null;
  }
  collector.closed(raw, path, NODE_PROPERTIES);

  const id = collector.requiredString(raw, path, "id");
  const name = collector.requiredString(raw, path, "name");

  let kind: DatasetTreeNodeKind | null = null;
  const rawKind = raw.kind;
  if (rawKind === undefined) {
    collector.add(pointer(path, "kind"), "missing-property", "`kind` is required");
  } else if (typeof rawKind !== "string") {
    collector.add(pointer(path, "kind"), "invalid-type", "`kind` must be a string");
  } else if (!KINDS.includes(rawKind as DatasetTreeNodeKind)) {
    collector.add(
      pointer(path, "kind"),
      "invalid-value",
      `\`kind\` must be one of ${KINDS.join(", ")} (got ${JSON.stringify(rawKind)})`,
    );
  } else {
    kind = rawKind as DatasetTreeNodeKind;
  }

  if (id !== null) {
    const previous = seen.get(id);
    if (previous !== undefined) {
      // Identity is what expansion, focus restoration and snapshot diffing all key on. Two nodes
      // sharing one id is not a cosmetic problem; the second silently replaces the first.
      collector.add(
        pointer(path, "id"),
        "duplicate-id",
        `duplicate id ${JSON.stringify(id)} (first seen at ${previous})`,
      );
    } else {
      seen.set(id, path);
    }
  }

  let availability: DatasetTreeAvailability | undefined;
  const rawAvailability = raw.availability;
  if (rawAvailability !== undefined) {
    if (
      typeof rawAvailability !== "string" ||
      !AVAILABILITY.includes(rawAvailability as DatasetTreeAvailability)
    ) {
      collector.add(
        pointer(path, "availability"),
        "invalid-value",
        `\`availability\` must be one of ${AVAILABILITY.join(", ")}`,
      );
    } else {
      availability = rawAvailability as DatasetTreeAvailability;
    }
  }

  let metadata: Record<string, unknown> | undefined;
  if (raw.metadata !== undefined) {
    if (!isPlainObject(raw.metadata)) {
      collector.add(pointer(path, "metadata"), "invalid-type", "`metadata` must be an object");
    } else {
      metadata = raw.metadata;
    }
  }

  let children: DatasetTreeCatalogNode[] | undefined;
  if (raw.children !== undefined) {
    if (!Array.isArray(raw.children)) {
      collector.add(pointer(path, "children"), "invalid-type", "`children` must be an array");
    } else {
      const childPath = pointer(path, "children");
      children = [];
      raw.children.forEach((child, index) => {
        const parsed = parseNode(collector, child, pointer(childPath, index), seen);
        if (parsed) children!.push(parsed);
      });
    }
  }

  const title = collector.optionalString(raw, path, "title");
  const nodePath = collector.optionalString(raw, path, "path");
  const description = collector.optionalString(raw, path, "description");
  const mediaType = collector.optionalString(raw, path, "mediaType");
  const modifiedAt = collector.optionalString(raw, path, "modifiedAt");
  const availabilityNote = collector.optionalString(raw, path, "availabilityNote");
  const explicitHasChildren = collector.optionalBoolean(raw, path, "hasChildren");
  const size = collector.optionalSize(raw, path, "size");
  const access = parseAccess(collector, raw.access, pointer(path, "access"));
  const link = parseLink(collector, raw.link, pointer(path, "link"));
  const metrics = parseMetrics(collector, raw.metrics, pointer(path, "metrics"));
  const details = parseDetails(collector, raw.details, pointer(path, "details"));
  const examples = parseExamples(collector, raw.examples, pointer(path, "examples"));
  const inspect = collector.optionalString(raw, path, "inspect");

  if (id === null || name === null || kind === null) return null;

  // `hasChildren` defaults from the declaration, not the kind: `children: []` is knowably empty and
  // still opens to say so, while no `children` key means contents this snapshot does not describe.
  const hasChildren = explicitHasChildren ?? (children !== undefined ? true : undefined);

  const node: Record<string, unknown> = { id, kind, name };
  if (title !== undefined) node.title = title;
  if (nodePath !== undefined) node.path = nodePath;
  if (description !== undefined) node.description = description;
  if (hasChildren !== undefined) node.hasChildren = hasChildren;
  if (size !== undefined) node.size = size;
  if (mediaType !== undefined) node.mediaType = mediaType;
  if (modifiedAt !== undefined) node.modifiedAt = modifiedAt;
  if (availability !== undefined) node.availability = availability;
  if (availabilityNote !== undefined) node.availabilityNote = availabilityNote;
  if (access !== undefined) node.access = access;
  if (link !== undefined) node.link = link;
  if (metrics !== undefined) node.metrics = metrics;
  if (details !== undefined) node.details = details;
  if (examples !== undefined) node.examples = examples;
  if (inspect !== undefined) node.inspect = inspect;
  if (metadata !== undefined) node.metadata = Object.freeze({ ...metadata });
  if (children !== undefined) node.children = Object.freeze(children);

  return Object.freeze(node) as unknown as DatasetTreeCatalogNode;
}

/**
 * Validate an already-loaded value as a `dataset-tree-catalog-v1` document. Takes a JavaScript
 * value, not a URL or a string: fetching is the host's job, so a portal can inline the catalog,
 * read it from a build artifact or receive it from an API without this package owning a network
 * path to secure. Order is preserved as declared: same input, same tree, same order, same ids.
 *
 * @throws {DatasetTreeCatalogError} with every diagnostic found, if the value is not a valid
 * catalog.
 */
export function parseDatasetTreeCatalogV1(input: unknown): DatasetTreeCatalog {
  const collector = new Collector();

  if (!isPlainObject(input)) {
    throw new DatasetTreeCatalogError([
      { path: "", code: "not-an-object", message: "the catalog must be an object" },
    ]);
  }

  collector.closed(input, "", new Set(["schemaVersion", "generatedAt", "source", "roots"]));

  const version = input.schemaVersion;
  if (version === undefined) {
    collector.add("/schemaVersion", "missing-property", "`schemaVersion` is required");
  } else if (version !== 1) {
    collector.add(
      "/schemaVersion",
      "invalid-value",
      `this build understands \`schemaVersion: 1\` only (got ${JSON.stringify(version)})`,
    );
  }

  const roots: DatasetTreeCatalogNode[] = [];
  if (input.roots === undefined) {
    collector.add("/roots", "missing-property", "`roots` is required");
  } else if (!Array.isArray(input.roots)) {
    collector.add("/roots", "invalid-type", "`roots` must be an array");
  } else {
    const seen = new Map<string, string>();
    input.roots.forEach((raw, index) => {
      const parsed = parseNode(collector, raw, pointer("/roots", index), seen);
      if (parsed) roots.push(parsed);
    });
  }

  const generatedAt = collector.optionalString(input, "", "generatedAt");
  const sourceLabel = collector.optionalString(input, "", "source");

  if (collector.diagnostics.length > 0) throw new DatasetTreeCatalogError(collector.diagnostics);

  const document: Record<string, unknown> = { schemaVersion: 1 as const };
  if (generatedAt !== undefined) document.generatedAt = generatedAt;
  if (sourceLabel !== undefined) document.source = sourceLabel;
  document.roots = Object.freeze(roots);
  return Object.freeze(document) as unknown as DatasetTreeCatalog;
}
