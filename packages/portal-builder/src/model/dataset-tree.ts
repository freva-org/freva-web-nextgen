/**
 * The `dataset-tree` landing block's build-time half.
 *
 * The block shows a hierarchical archive - collections, directories, datasets, files - that a
 * visitor can open on the way in. Everything it shows is decided while the artifact is produced:
 * the catalogue is a project-owned file, read through the same containment anchor as every other
 * input, validated against the closed `dataset-tree-catalog-v1` contract published by
 * `@freva-org/dataset-tree`, and what survives is embedded in the page.
 *
 * Embedded rather than fetched: a catalogue emitted beside the page would put a request on the
 * critical path of a static document, need `connect-src` in the recorded policy, and add failure
 * modes - a 404, a slow response, a stale cache - that a build-time snapshot does not have. The
 * point of snapshot mode is that the page already has the answer.
 *
 * This file does not crawl an archive, talk to S3, or know that the package has an S3 adapter.
 * Producing a catalogue from a live store is a separate job with separate credentials and a
 * separate failure surface; this reads a file.
 */

import { readFileSync } from "node:fs";
import { parseDatasetTreeCatalogV1 } from "@freva-org/dataset-tree/snapshot";
import type { DatasetTreeCatalog, DatasetTreeCatalogNode } from "@freva-org/dataset-tree/snapshot";
import { DiagnosticBag } from "../diagnostics.js";
import { resolvePlaygroundSettings, type PlaygroundWhere } from "./python-playground.js";
import type {
  DatasetTreeBlockData,
  DatasetTreeS3Root,
  DatasetTreeS3Source,
  PlaygroundArtifactData,
  PlaygroundArtifactExample,
  PlaygroundSettings,
  PythonPlaygroundData,
  RegisteredExampleDigest,
} from "./types.js";
import type { RawDatasetTreePython, RawDatasetTreeS3 } from "../config/types.js";
import { sha256 } from "../util/package.js";
import { livePythonPlayground } from "./tree-recipes.js";

/**
 * The evidence registration for the block. Landing blocks are not components, so this is not in
 * `COMPONENT_REGISTRY`, but the absence rule is the same: a build with no `dataset-tree` block
 * carries a plan with `enabled: false`, and `FP1601`/`FP1602` fail the build if any module or
 * copied file below shows up in it anyway. That makes "no Dataset Tree bytes" a checked claim.
 */
export const DATASET_TREE_EVIDENCE = {
  id: "dataset-tree",
  kind: "dataset-tree" as const,
  ownedModuleRoots: [
    "pkg:npm/%40freva-org/dataset-tree",
    "builder:client/components/dataset-tree.ts",
    "builder:client/components/dataset-tree.css",
    "builder:client/components/dataset-tree-styles.ts",
    "builder:client/components/tree-maximize.ts",
    "builder:client/components/tree-sources.ts",
    "builder:client/components/tree-source-snapshot.ts",
    "builder:client/components/tree-source-s3.ts",
    "builder:client/components/tree-recipes.ts",
    // The recipe templates, as the data file both halves read. The build hashes these strings
    // and the page renders them, and two copies of a string whose digest is a security boundary
    // are not kept in step by hand - so there is one file, in a published directory, owned here
    // so the absence check accounts for it like any other module the block ships.
    "builder:schema/tree-recipes.json",
    // The in-page inspector, and the loader that is the only module naming it. Owned here rather
    // than left to the general lazy pool, because attribution is what makes a budget mean
    // anything: unowned, its 43,420 bytes of emitted code are charged to nobody and surface only
    // as an aggregate ceiling failing in a consumer's build. Owning it also makes the absence
    // claim real - a portal with no dataset-tree block must contain no inspector, and `FP1601`
    // checks that. The claim is about the tree's own loader (`tree-inspector-loader.ts`), the only
    // module in this package that names the inspector, not about the package being absent from
    // the artifact: `@freva-org/databrowser` declares `@freva-org/data-inspector` as an ordinary
    // dependency and imports it on first Inspect, with `inspectorUrl` as an explicit override, so
    // it can legitimately appear in a build with a Data Browser and no tree, charged there.
    "builder:client/components/tree-inspector.ts",
    "builder:client/components/tree-inspector-loader.ts",
  ],

  ownedStaticRoots: [] as string[],
  assetNamespaces: [] as string[],
  allowedSharedModules: [
    "builder:client/shell.ts",
    "builder:client/runtime.ts",
    // The inspector package, owned by neither feature - the same shape as the terminal above.
    // `@freva-org/databrowser` declares `@freva-org/data-inspector` as an ordinary dependency and
    // imports it on first Inspect, so a portal with a Data Browser and no dataset tree has it in
    // the graph legitimately; an ownership claim here would be `FP1601` against a disabled
    // component. Owning it in the Data Browser's plan would only move the failure to a portal with
    // a tree and no Data Browser. So neither owns it, both allow it, and what this plan owns is
    // the tree's own loader - the thing genuinely absent from a portal with no tree.
    "pkg:npm/%40freva-org/data-inspector",
    // The maximized sheet is a portal-owned overlay, so the tree reaches the layer manager too.
    "builder:client/layers.ts",
    // `python-bridge.ts` is shared, and owned by neither plan that reaches it. A documentation
    // page with a runnable snippet registers through it in a portal with no tree, and an owned
    // module of a disabled component is `FP1601`; it cannot belong to the playground either,
    // because the tree island imports it in every build, playground or not. So it is shared like
    // `shell.ts` and `layers.ts`: a registry that imports nothing and is a few hundred bytes.
    "builder:client/python-bridge.ts",
  ],
};

/**
 * The playground's own evidence registration, separate from the block's, because the two are
 * enabled separately. A portal may carry a dataset-tree block and no `python` stanza, and "this
 * build contains no interpreter" is then a checkable claim that one plan covering both could not
 * express. With the playground off, an interpreter module anywhere in the graph is `FP1601`.
 */
export const PYTHON_PLAYGROUND_EVIDENCE = {
  id: "python-playground",
  kind: "python-playground" as const,
  // The interpreter and this portal's own playground modules, and deliberately not the terminal
  // package: `@freva-org/freva-client-terminal` is also the Data Browser's, which ships a
  // freva-client terminal of its own, so "this build contains no terminal window" is not a claim
  // this plan can make. The claim it does make is that a portal which did not ask for a
  // playground contains no Python interpreter and none of the coordinator that would drive one.
  ownedModuleRoots: [
    "pkg:npm/%40freva-org/browser-python",
    "builder:client/components/python-playground.ts",
    "builder:client/components/python-chunks.ts",
    "builder:client/components/python-chunks-local.ts",
    "builder:client/components/python-chunks-framed.ts",
    "builder:client/playground-origin.ts",
    "builder:client/components/python-playground-styles.ts",
    "builder:client/components/python-ready.ts",
    // The runnable-code provider: emitted only for a portal that has a marked snippet, and owned
    // here rather than by the renderer because what it is FOR is the playground.
    "builder:client/components/code-run.ts",
  ],
  // The Python materials, when this build serves them itself. Owned here so the absence claim
  // covers the artifact's files as well as its module graph: a portal with no runnable Python
  // must contain no wheels and no add-on artefacts.
  ownedStaticRoots: ["freva-wheels", "python-addons"] as string[],
  // The Worker bundle, which the bundler emits beside the module graph rather than in it. Named
  // here so an interpreter left behind by a disabled playground fails the absence check and an
  // enabled one is charged its 130 kB against a budget. Matched by prefix: the emitted file
  // carries a content hash.
  ownedEmittedNames: ["browser-python.worker"],
  assetNamespaces: [] as string[],
  allowedSharedModules: [
    "builder:client/shell.ts",
    "builder:client/runtime.ts",
    // Shared with the dataset tree, and owned by neither - see the tree's own note on it.
    "builder:client/python-bridge.ts",
    // The layer manager is shared infrastructure, not this feature's own: `client/layers.ts`
    // decides what is on top of what for every portal-owned surface, and the maximized dataset
    // browser is one of them. Owned here, a portal with a tree and no playground would fail its
    // own absence check under `FP1601`.
    "builder:client/layers.ts",
    "builder:client/components/dataset-tree.ts",
  ],
};

/**
 * How much catalogue may be embedded in one page. The cost is paid by every visitor to the
 * landing, in the HTML itself, before anything is interactive. 512 KiB is roughly a few thousand
 * nodes of ordinary metadata - more than a landing-page browser wants - and a project needing
 * more has outgrown a snapshot and wants a live source.
 *
 * A constant rather than a content-profile key: the profile's digest is part of build identity,
 * so adding a key would change the identity of every artifact, including portals that never use
 * this block.
 */
export const MAX_CATALOG_BYTES = 512 * 1024;

/** How many catalogue problems are reported individually before the rest are summarised. */
const MAX_REPORTED_PROBLEMS = 20;

function walk(
  nodes: readonly DatasetTreeCatalogNode[],
  visit: (n: DatasetTreeCatalogNode) => void,
) {
  for (const node of nodes) {
    visit(node);
    if (node.children) walk(node.children, visit);
  }
}

/**
 * Read, validate and prepare one catalogue. Every failure is a diagnostic against the landing
 * file with a pointer, never an exception: a consumer with a malformed catalogue gets told which
 * node is wrong, not a stack trace. Returns undefined when the block cannot be built.
 */
export function loadDatasetTreeCatalog(options: {
  /** Absolute path of the catalogue file, already contained. */
  absolute: string;
  /** Source-root-relative path of the same file. */
  relative: string;
  /** The landing file that declared it, for diagnostics. */
  declaredIn: string;
  /** JSON pointer of the block within the landing document. */
  pointer: string;
  instanceId: string;
  expand: readonly string[];
  statusLabel: string | undefined;
  /** The block's `python` stanza, as written. Undefined and the block stays Copy-only. */
  python: RawDatasetTreePython | undefined;
  bag: DiagnosticBag;
}): { data: DatasetTreeBlockData; digest: string; bytes: number } | undefined {
  const { absolute, relative, declaredIn, pointer, bag } = options;
  const raw = readFileSync(absolute);

  if (raw.byteLength > MAX_CATALOG_BYTES) {
    bag.error(
      "FP1407",
      `The dataset-tree catalogue '${relative}' is ${raw.byteLength} bytes, over the ${MAX_CATALOG_BYTES}-byte embedding limit.`,
      {
        file: declaredIn,
        pointer: `${pointer}/catalog`,
        hint: "Publish a smaller catalogue, or serve this archive from a live source instead of a build-time snapshot.",
      },
    );
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    bag.error(
      "FP1101",
      `The dataset-tree catalogue '${relative}' is not valid JSON: ${String(err)}`,
      {
        file: declaredIn,
        pointer: `${pointer}/catalog`,
      },
    );
    return undefined;
  }

  let catalog: DatasetTreeCatalog;
  try {
    catalog = parseDatasetTreeCatalogV1(parsed);
  } catch (err) {
    // The package's error carries one entry per problem with an RFC 6901 pointer into the
    // catalogue. Reported as-is: they address the catalogue file, where the reader has to go.
    const problems = (err as { diagnostics?: { path: string; message: string }[] }).diagnostics;
    if (!problems) throw err;
    for (const problem of problems.slice(0, MAX_REPORTED_PROBLEMS)) {
      // The message says what is wrong; the file and pointer say where. Repeating the location in
      // the prose only makes the rendered diagnostic say it twice.
      bag.error("FP1104", `The dataset-tree catalogue is not valid: ${problem.message}.`, {
        file: relative,
        pointer: problem.path || "/",
      });
    }
    if (problems.length > MAX_REPORTED_PROBLEMS) {
      bag.error(
        "FP1104",
        `The dataset-tree catalogue has ${problems.length - MAX_REPORTED_PROBLEMS} further problems.`,
        { file: relative },
      );
    }
    return undefined;
  }

  const ids = new Set<string>();
  let nodeCount = 0;
  walk(catalog.roots, (node) => {
    nodeCount += 1;
    ids.add(node.id);
  });

  // An identifier that expands nothing is a typo with no symptom: the page renders, the branch
  // stays shut, and nobody finds out until someone asks why. It fails the build instead.
  const expandedIds: string[] = [];
  options.expand.forEach((id, index) => {
    if (!ids.has(id)) {
      bag.error(
        "FP1201",
        `The dataset-tree block expands '${id}', which is not a node in '${relative}'.`,
        { file: declaredIn, pointer: `${pointer}/expand/${index}` },
      );
      return;
    }
    expandedIds.push(id);
  });

  // The footer's two facts, taken from the catalogue and from nowhere else: when the generator
  // ran, and what it read. If the catalogue records neither, the pill stands alone - a snapshot
  // must never invent its own freshness, and neither a node count nor a note about how the portal
  // was compiled is a fact about the archive.
  const generatedAt = formatGeneratedAt(catalog.generatedAt);
  const sourceLabel = catalog.source;
  const python = resolvePythonPlayground(options.python, catalog, options.instanceId);
  // The sources travel only when there is a second origin to deploy them to. A same-origin
  // playground reads them out of the catalogue the page already carries, so collecting them here
  // would put a second copy in the model for nobody.
  const playgroundExamples = python?.playgroundOrigin
    ? collectPlaygroundExamples(catalog, options.instanceId)
    : undefined;

  return {
    data: {
      mode: "snapshot",
      instanceId: options.instanceId,
      // Re-serialised from the parsed document rather than copied from the file: the parser is
      // closed and builds each node's properties in a fixed order, so source whitespace and
      // property order cannot change the artifact and only recognised fields reach the page.
      catalogScriptJson: escapeJsonForScript(JSON.stringify(catalog)),
      source: relative,
      nodeCount,
      rootCount: catalog.roots.length,
      expandedIds,
      statusLabel: options.statusLabel ?? "SNAPSHOT",
      ...(generatedAt ? { generatedAt } : {}),
      ...(sourceLabel ? { sourceLabel } : {}),
      ...(python ? { python } : {}),
      ...(playgroundExamples ? { playgroundExamples } : {}),
    },
    digest: sha256(raw),
    bytes: raw.byteLength,
  };
}

/**
 * Language tags the playground will treat as Python. The same closed set the component uses,
 * spelled out again rather than imported, because this side decides what to *hash* and that
 * decision has to be readable where it is made. If the two disagree, the symptom is a button the
 * page draws and the build never registered, which the run path refuses loudly.
 */
const PYTHON_LANGUAGES = new Set(["python", "python3", "py"]);

/**
 * One segment of a composed identity, with the separator made impossible: percent-escaping `%`
 * and `/`, and nothing else. The composition below joins three segments with `/`, and an identity
 * is only an identity if two different triples cannot compose to one string - a catalogue whose
 * node is `a/b` and example is `c` must not collide with one whose node is `a` and example is
 * `b/c`. `%` first, always: escaping `/` first would then escape the `%` it just wrote.
 */
function segment(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("/", "%2F");
}

/**
 * The page-global name of one registered example: three parts, including the block instance. Node
 * ids are unique within a *catalogue* - the parser enforces that - and a page may carry two, so
 * without the instance two blocks over archives that both call a node `cmip6/tas` would mint the
 * same name, the later one winning the merge.
 */
export function composeExampleId(instanceId: string, nodeId: string, exampleId: string): string {
  return `${segment(instanceId)}/${segment(nodeId)}/${segment(exampleId)}`;
}

/**
 * Resolve a live S3 source, or report why it cannot be one.
 *
 * Checked here and not left to the browser: the endpoint parses, it is `https:` (or a loopback
 * `http:` for a development gateway), it carries no credentials and no query, and the roots name
 * buckets that could exist. Each is a configuration mistake whose only other symptom is a tree
 * that draws and then fails on first expansion, in someone else's browser, with a CORS message
 * naming none of it. Not checked, deliberately: whether the gateway is up, the buckets exist or
 * CORS is configured - a build that reached out for those would be a build that lists the
 * archive, which is what this mode exists not to do.
 */
export function resolveDatasetTreeS3(
  raw: RawDatasetTreeS3,
  where: { file: string; pointer: string },
  bag: DiagnosticBag,
): DatasetTreeS3Source | undefined {
  let url: URL;
  try {
    url = new URL(raw.endpoint);
  } catch {
    bag.error("FP1205", `The dataset-tree S3 endpoint '${raw.endpoint}' is not a URL.`, {
      file: where.file,
      pointer: `${where.pointer}/s3/endpoint`,
    });
    return undefined;
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    bag.error(
      "FP1205",
      `The dataset-tree S3 endpoint must be https (or http on a loopback host); got '${url.protocol}//${url.host}'.`,
      { file: where.file, pointer: `${where.pointer}/s3/endpoint` },
    );
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) {
    bag.error(
      "FP1210",
      "The dataset-tree S3 endpoint must carry no credentials, query or fragment.",
      {
        file: where.file,
        pointer: `${where.pointer}/s3/endpoint`,
        hint: "A gateway a browser reads is reached anonymously; a credential here would be published in the artifact.",
      },
    );
    return undefined;
  }

  const seen = new Set<string>();
  const roots: DatasetTreeS3Root[] = [];
  raw.roots.forEach((root, index) => {
    const prefix = root.prefix ?? "";
    // Both ends of the prefix, and both with the root's name in the message. Checked here rather
    // than by a schema pattern, where a failure inside the block union reports every other block
    // type and never the prefix. The trailing slash matters: `healpix/cmip6` and `healpix/cmip6/`
    // are different listings to S3, and the first silently returns `healpix/cmip6-old/` too.
    if (prefix.length > 0 && !prefix.endsWith("/")) {
      bag.error("FP1201", `The S3 root '${root.name}' has a prefix that does not end with '/'.`, {
        file: where.file,
        pointer: `${where.pointer}/s3/roots/${index}/prefix`,
        hint: "A prefix is a key prefix, and S3 matches it literally: 'a/b' also matches 'a/b-old/'.",
      });
      return;
    }
    if (prefix.startsWith("/")) {
      bag.error("FP1201", `The S3 root '${root.name}' has a prefix that starts with '/'.`, {
        file: where.file,
        pointer: `${where.pointer}/s3/roots/${index}/prefix`,
        hint: "Object keys have no leading separator; write 'healpix/cmip6/', not '/healpix/cmip6/'.",
      });
      return;
    }
    const id = root.id ?? `s3://${root.bucket}/${prefix}`;
    if (seen.has(id)) {
      bag.error("FP1201", `Two S3 roots resolve to the same identity '${id}'.`, {
        file: where.file,
        pointer: `${where.pointer}/s3/roots/${index}`,
        hint: "Give one of them an explicit `id`, or point them at different prefixes.",
      });
      return;
    }
    // A project link is a link, and it has to be one a browser may follow. Checked here rather
    // than by a schema pattern for the reason the endpoint is: a failure inside the block union
    // reports every other block type and never the field. `https:` only - an `http:` project page
    // on a portal served over TLS is a mixed-content warning at best, and a `javascript:` one is
    // the reason this is checked at all.
    if (root.link) {
      let href: URL | null = null;
      try {
        href = new URL(root.link.href);
      } catch {
        href = null;
      }
      if (!href || href.protocol !== "https:") {
        bag.error(
          "FP1205",
          `The S3 root '${root.name}' has a project link that is not an https URL.`,
          {
            file: where.file,
            pointer: `${where.pointer}/s3/roots/${index}/link/href`,
          },
        );
        return;
      }
    }
    seen.add(id);
    roots.push({
      ...(root.id ? { id: root.id } : {}),
      name: root.name,
      bucket: root.bucket,
      ...(prefix ? { prefix } : {}),
      ...(root.title ? { title: root.title } : {}),
      ...(root.description ? { description: root.description } : {}),
      ...(root.link
        ? { link: { href: root.link.href, ...(root.link.label ? { label: root.link.label } : {}) } }
        : {}),
      ...(root.planned ? { planned: root.planned } : {}),
    });
  });
  if (roots.length === 0) return undefined;

  return {
    // Normalised with a trailing slash removed, because the adapter joins onto it.
    endpoint: url.origin + url.pathname.replace(/\/$/, ""),
    origin: url.origin,
    style: raw.style ?? "path",
    roots,
    ...(raw.maxKeys !== undefined ? { maxKeys: raw.maxKeys } : {}),
    ...(raw.maxPages !== undefined ? { maxPages: raw.maxPages } : {}),
    ...(raw.requestTimeoutMs !== undefined ? { requestTimeoutMs: raw.requestTimeoutMs } : {}),
    ...(raw.retries !== undefined ? { retries: raw.retries } : {}),
    ...(raw.datasetSuffixes ? { datasetSuffixes: [...raw.datasetSuffixes] } : {}),
  };
}

/**
 * A live block's data, without a catalogue. `expand` is carried unchecked, and that is the honest
 * half of live mode: the identifiers are `s3://bucket/prefix/`, and the only way to verify one at
 * build time is to list the archive at build time.
 */
export function liveDatasetTreeBlock(options: {
  instanceId: string;
  s3: DatasetTreeS3Source;
  expand: readonly string[];
  statusLabel: string | undefined;
  python: RawDatasetTreePython | undefined;
  /**
   * The portal's own resolved playground, when this page has one, for the block to inherit. See
   * `livePythonPlayground`: a block's stanza cannot express the portal-wide fields, so without
   * this it would resolve to their defaults and disagree with the portal about one interpreter.
   */
  inherit?: PlaygroundSettings;
  file: string;
  pointer: string;
  bag: DiagnosticBag;
}): DatasetTreeBlockData {
  // A live block registers recipe templates, not per-node snippets. What the mechanism must
  // prevent is source composed in the page reaching an interpreter; what a reader needs is to run
  // the store in front of them. Registering the template satisfies both: the build hashes a fixed
  // recipe with one hole, and the store's identifier - a node id the source produced, checked in
  // the page against the configured endpoint and the declared roots - fills the hole. A name and
  // a digest still identify the program, and the parameter's character set cannot end the string
  // literal it lands in.
  const python = livePythonPlayground(
    options.python,
    options.instanceId,
    options.bag,
    { file: options.file, pointer: options.pointer },
    {
      endpoint: options.s3.endpoint,
      style: options.s3.style,
      roots: options.s3.roots.map((root) => ({
        bucket: root.bucket,
        ...(root.prefix ? { prefix: root.prefix } : {}),
      })),
    },
    options.inherit,
  );
  return {
    mode: "s3",
    instanceId: options.instanceId,
    catalogScriptJson: "",
    s3: options.s3,
    source: options.s3.endpoint,
    nodeCount: 0,
    rootCount: options.s3.roots.length,
    expandedIds: [...options.expand],
    statusLabel: options.statusLabel ?? "LIVE",
    sourceLabel: options.s3.endpoint,
    ...(python ? { python } : {}),
  };
}

/**
 * Register every runnable example in a catalogue: the example must be tagged as Python and say
 * `executable: true`. Nothing else is inspected here - not placeholders, not syntax - because
 * this is the build's half of the contract and its job is to answer "which snippets did I hash,
 * and to what". Whether one is offered to a visitor is the component's decision against the same
 * data, and it is strictly narrower: a registered example may still get no button, but an
 * unregistered one can never get one. Sorted, so one input produces one artifact whatever order
 * the walk found them in.
 */
export function registerCatalogExamples(
  catalog: DatasetTreeCatalog,
  instanceId: string,
): RegisteredExampleDigest[] {
  const out: RegisteredExampleDigest[] = [];
  walk(catalog.roots, (node) => {
    for (const example of node.examples ?? []) {
      if (example.executable !== true) continue;
      if (!PYTHON_LANGUAGES.has(example.language.trim().toLowerCase())) continue;
      out.push({
        id: composeExampleId(instanceId, node.id, example.id),
        datasetId: node.id,
        exampleId: example.id,
        // The digest is of the source alone, in UTF-8, exactly as embedded - not of a JSON
        // envelope around it, which would make the hash depend on how it was serialised. Bare
        // hex, without this repository's usual `sha256:` prefix: that prefix belongs to the input
        // manifest, while this value crosses into `@freva-org/browser-python`, whose registry
        // accepts a lowercase hex SHA-256 and refuses anything else as malformed.
        sha256: sha256(Buffer.from(example.code, "utf8")).replace(/^sha256:/, ""),
      });
    }
  });
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * The child artifact for the whole portal, or `undefined` when no landing asked for one.
 *
 * One origin per portal, because what is generated is a single deployable document with a single
 * merged manifest and a second origin would need a second one. Two landings naming different
 * origins is reported rather than resolved, for the same reason `FP1215` exists: a precedence
 * rule silently answers a question the author did not know they had asked.
 *
 * The examples of every Python-enabled block are merged, including blocks on other landings, so a
 * press anywhere in the portal names something the deployed child knows. Ids already carry the
 * block instance, so the merge cannot collide; that is checked rather than assumed.
 */
export function resolvePlaygroundArtifact(options: {
  blocks: readonly {
    pointer: string;
    file: string;
    python: PythonPlaygroundData;
    examples: readonly PlaygroundArtifactExample[];
    /** The storage origin this block's own examples read from, when it has a live source. */
    dataOrigin?: string;
  }[];
  hostOrigin: string;
  protocolVersion: number;
  runtimeIndexUrl: string;
  bag: DiagnosticBag;
}): PlaygroundArtifactData | undefined {
  const framed = options.blocks.filter((entry) => entry.python.playgroundOrigin);
  const first = framed[0];
  if (!first) return undefined;
  const origin = first.python.playgroundOrigin as string;
  // Add-ons and the credential setting travel with the manifest, not with the parent. The child
  // owns the interpreter, so it is the child that has to know what to prepare; the parent in a
  // framed deployment never builds one, so a page that disagreed with its own child about which
  // add-ons were active would produce a Try button whose behaviour depended on which of two
  // documents you read.
  const addons = [...first.python.addons].sort();
  const persistCredentials = first.python.persistCredentials;

  for (const entry of framed.slice(1)) {
    if (entry.python.playgroundOrigin === origin) continue;
    options.bag.error(
      "FP1216",
      `This portal generates one playground artifact, and the blocks name two origins: ` +
        `'${origin}' and '${entry.python.playgroundOrigin as string}'.`,
      {
        file: entry.file,
        pointer: `${entry.pointer}/python/playgroundOrigin`,
        hint: "Serve every playground from one origin, or split the portal.",
      },
    );
    return undefined;
  }

  const byId = new Map<string, PlaygroundArtifactExample>();
  for (const entry of framed) {
    for (const example of entry.examples) {
      const existing = byId.get(example.id);
      if (existing && existing.sha256 !== example.sha256) {
        options.bag.error(
          "FP1216",
          `Two registered examples share the identity '${example.id}' with different sources.`,
          { file: entry.file, pointer: entry.pointer },
        );
        return undefined;
      }
      byId.set(example.id, example);
    }
  }

  const dataOrigins = [
    ...new Set(framed.map((entry) => entry.dataOrigin).filter((o): o is string => Boolean(o))),
  ].sort();

  return {
    origin,
    hostOrigin: options.hostOrigin,
    ...(dataOrigins.length > 0 ? { dataOrigins } : {}),
    profile: first.python.profile,
    ...(first.python.initialSource ? { initialSource: first.python.initialSource } : {}),
    protocolVersion: options.protocolVersion,
    // The block's own mirror when it has one; the pinned default otherwise. The child's policy is
    // written from this, so a deployment that mirrors the runtime gets a policy naming its mirror.
    runtimeIndexUrl: first.python.runtimeIndexUrl ?? options.runtimeIndexUrl,
    ...(first.python.wheelhouseUrl ? { wheelhouseUrl: first.python.wheelhouseUrl } : {}),
    ...(first.python.addonBaseUrl ? { addonBaseUrl: first.python.addonBaseUrl } : {}),
    ...(addons.length > 0 ? { addons } : {}),
    ...(persistCredentials ? { persistCredentials: true } : {}),
    ...(first.python.connectOrigins.length > 0
      ? { connectOrigins: [...first.python.connectOrigins] }
      : {}),
    // The policy, resolved once for the portal and carried so the child's own CSP is written from
    // the same value the parent's is - including whether it is the open one.
    packageOrigins: [...first.python.packagePolicy.origins],
    ...(first.python.packagePolicy.anyHttpsOrigin ? { anyHttpsOrigin: true } : {}),
    examples: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/**
 * The same registration, with the *source*, for the separate-origin child artifact.
 *
 * A second function over the same walk rather than one function with a flag: the two outputs go
 * to two different places and one must never carry source, so a flag would be one mistaken
 * argument away from putting the Python on the parent page, and a reviewer could not tell from a
 * call site which shape came back. The digest is computed the same way in both, from the same
 * bytes, which is what makes the parent's request and the child's manifest agree.
 *
 * `title` is what the console prints on the divider: the catalogue's label when it has one, the
 * example's own id when it does not - never an empty string, which the registry refuses at load.
 */
export function collectPlaygroundExamples(
  catalog: DatasetTreeCatalog,
  instanceId: string,
): PlaygroundArtifactExample[] {
  const out: PlaygroundArtifactExample[] = [];
  walk(catalog.roots, (node) => {
    for (const example of node.examples ?? []) {
      if (example.executable !== true) continue;
      if (!PYTHON_LANGUAGES.has(example.language.trim().toLowerCase())) continue;
      out.push({
        id: composeExampleId(instanceId, node.id, example.id),
        datasetId: node.id,
        title: example.label?.trim() || example.id,
        source: example.code,
        sha256: sha256(Buffer.from(example.code, "utf8")).replace(/^sha256:/, ""),
      });
    }
  });
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * Resolve `dataset-tree.python` into what the page needs, or `undefined` for "off". Every default
 * costs nothing: no autostart, one session, no persistence beyond what the visitor asks for. A
 * portal that wants the interpreter warm, or two of them, says so.
 */
export function resolvePythonPlayground(
  raw: RawDatasetTreePython | undefined,
  catalog: DatasetTreeCatalog,
  instanceId: string,
  where: PlaygroundWhere = { file: "portal.yaml", pointer: "/landings" },
  bag: DiagnosticBag = new DiagnosticBag(),
): PythonPlaygroundData | undefined {
  // The block's own stanza carries no add-ons, wheelhouse or origin allowlist - see the raw
  // type - so the shared resolver fills those in as empty.
  const settings = resolvePlaygroundSettings(raw, where, bag);
  if (!settings) return undefined;
  return { ...settings, examples: registerCatalogExamples(catalog, instanceId) };
}

/**
 * Escape a JSON document for embedding in a `<script type="application/json">` data block.
 *
 * Only `<` needs escaping, and it is the one that matters: without it a catalogue containing
 * `</script>` in any string would end the element early and put the rest of the document into the
 * page as markup. U+2028 and U+2029 follow because they are valid unescaped inside a JSON string
 * and are line terminators to a JavaScript parser, so a document later read with `eval` rather
 * than `JSON.parse` cannot be broken by one either. The result is still valid JSON - an escaped
 * `<` is a `<` - so nothing on the reading side has to know.
 */
export function escapeJsonForScript(json: string): string {
  return json
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/**
 * A catalogue's `generatedAt` as `YYYY-MM-DD HH:MM UTC`. Always UTC, never the build machine's
 * locale: the value is a fact about an archive, and two people comparing notes across time zones
 * should read the same string. An unparseable value is dropped rather than printed - a footer
 * saying `Invalid Date` beside a SNAPSHOT pill is worse than one saying nothing.
 */
function formatGeneratedAt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())}` +
    ` ${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())} UTC`
  );
}
