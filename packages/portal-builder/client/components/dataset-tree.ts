/**
 * The portal's adapter for `@freva-org/dataset-tree`.
 *
 * Everything the tree *is* - the rows, the expansion, the filter, the keyboard model, the
 * accessible tree semantics - belongs to that package. This file does three portal-shaped things:
 * it finds the block hosts the build put on the page, hands each one the catalogue validated and
 * embedded beside it, and reports a failure in the page rather than in the console, because a
 * visitor cannot read a console and a maintainer cannot see a component that never appeared.
 *
 * NO NETWORK in snapshot mode: the source is `createSnapshotSource` over a catalogue already in
 * the document, and the S3 adapter the package also publishes is not imported by this file or
 * anything it imports, so a portal cannot acquire an object-store client by enabling a landing
 * block. `@freva-org/dataset-tree/snapshot` is a separate entry point from
 * `@freva-org/dataset-tree/s3` so that this is a fact about the bundle rather than a promise.
 */

import { mountDatasetTree } from "@freva-org/dataset-tree";
import "./dataset-tree.css";
import type {
  DatasetAccessExample,
  DatasetTreeNode,
  DatasetTreeSource,
  TryPythonEvent,
} from "@freva-org/dataset-tree";
import type { DatasetTreeCatalog, DatasetTreeCatalogNode } from "@freva-org/dataset-tree/snapshot";
import { adoptTreeStyles } from "./dataset-tree-styles.js";
import { createTreeMaximize } from "./tree-maximize.js";
import type { TreeLoaders, TreeS3Config } from "./tree-sources.js";
import type { InspectorLoader } from "./tree-inspector-loader.js";
import { STORE_PLACEHOLDER, TREE_RECIPES, bindStore, renderRecipe } from "./tree-recipes.js";
import {
  registerPythonBlock,
  tryPython,
  type ExampleSource,
  type PythonPlaygroundConfig,
} from "../python-bridge.js";

/** What the renderer stamps on each host. Read once, never written. */
interface HostData {
  expand: string[];
  statusLabel: string;
  /** The catalogue's own generation time, already formatted by the build. */
  generatedAt: string | undefined;
  /** The catalogue's own public source, e.g. an endpoint. */
  sourceLabel: string | undefined;
}

function readJsonBlock(host: Element): unknown {
  const script = host.querySelector("script[data-portal-dataset-tree-catalog]");
  if (!script) throw new Error("the catalogue data block is missing");
  return JSON.parse(script.textContent ?? "");
}

/**
 * The block's `python` stanza, as the build wrote it into the page.
 *
 * Returns `undefined` for a block that did not ask for one, and for a block whose attribute is
 * unreadable - a malformed configuration must leave the tree exactly as it was rather than
 * producing half a playground.
 */
function readPythonConfig(host: HTMLElement): PythonPlaygroundConfig | undefined {
  const raw = host.dataset.portalDatasetTreePython;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as PythonPlaygroundConfig;
    if (!parsed || !Array.isArray(parsed.examples)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Every example in the catalogue, keyed by the id a run request will name.
 *
 * `<node id>::<example id>`, composed here and in the build the same way. Example ids are unique
 * only within a node - two datasets both calling theirs `python` is ordinary - so the node's id is
 * what makes the name unambiguous.
 */
function collectExamples(
  catalog: DatasetTreeCatalog,
): Map<string, { node: string; example: DatasetAccessExample }> {
  const out = new Map<string, { node: string; example: DatasetAccessExample }>();
  const walk = (nodes: readonly DatasetTreeCatalogNode[]): void => {
    for (const node of nodes) {
      for (const example of node.examples ?? []) {
        out.set(localKey(node.id, example.id), { node: node.id, example });
      }
      if (node.children) walk(node.children);
    }
  };
  walk(catalog.roots);
  return out;
}

/**
 * A key for THIS page's own bookkeeping, and nothing else. It never crosses a boundary and is never
 * rendered, so it can use a separator no identifier can contain rather than an escaping scheme. The
 * name a run request carries is the build's - see `RegisteredExampleDigest.id`.
 */
function localKey(nodeId: string, exampleId: string): string {
  return `${nodeId}\u0000${exampleId}`;
}

function readHostData(host: HTMLElement): HostData {
  let expand: string[] = [];
  const raw = host.dataset.portalDatasetTreeExpand;
  if (raw) {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) expand = parsed.filter((v): v is string => typeof v === "string");
  }
  return {
    expand,
    statusLabel: host.dataset.portalDatasetTreeStatus ?? "SNAPSHOT",
    generatedAt: host.dataset.portalDatasetTreeGenerated || undefined,
    sourceLabel: host.dataset.portalDatasetTreeSource || undefined,
  };
}

/**
 * The failure surface. Built with `textContent`, like everything else that touches
 * catalogue-derived values: the message carries an error string, and an error string is data. It
 * replaces the host's contents so the embedded data block goes with it.
 */
function reportFailure(host: HTMLElement, error: unknown): void {
  const note = document.createElement("p");
  note.className = "portal-note portal-dataset-tree-failed";
  note.textContent = `The dataset browser could not start: ${
    error instanceof Error ? error.message : String(error)
  }`;
  host.replaceChildren(note);
}

/**
 * The catalogue's own examples, and the digests the build computed for them. Separate from the
 * mount path because a live block has no catalogue and therefore none of this.
 */
function snapshotAccessExamples(
  catalog: DatasetTreeCatalog,
  python: PythonPlaygroundConfig | undefined,
  host: HTMLElement,
): ((node: DatasetTreeNode) => readonly DatasetAccessExample[]) | undefined {
  // The catalogue's examples are CONTENT, and are rendered whether or not anything can run them. A
  // portal with the playground switched off still shows every snippet with its Copy control - that
  // is what "Copy-only" means - and switching the playground on adds a digest to the ones the build
  // registered, which is what lets the tree offer a run control beside them.
  const catalogExamples = collectExamples(catalog);
  // By (node, example), because that is what the catalogue gives the island and what the build
  // recorded beside each digest. Composing the registered name here too would be a second
  // implementation of the escaping, and an identity may have only one.
  const registered = new Map(
    (python?.examples ?? [])
      // A catalogue example always has both; a documentation snippet has neither, and this map is
      // keyed by (node, example) - so an entry with no node is simply not one of these.
      .filter((e) => e.datasetId !== undefined && e.exampleId !== undefined)
      .map((e) => [localKey(e.datasetId!, e.exampleId!), e] as const),
  );
  const sources = new Map<string, ExampleSource>();
  for (const [key, entry] of catalogExamples) {
    const record = registered.get(key);
    if (!record) continue;
    sources.set(record.id, { title: entry.example.label, source: entry.example.code });
  }
  if (python) registerPythonBlock({ host, config: python, sources });
  if (catalogExamples.size === 0) return undefined;

  return (node: DatasetTreeNode): readonly DatasetAccessExample[] => {
    const examples: DatasetAccessExample[] = [];
    for (const [key, entry] of catalogExamples) {
      if (entry.node !== node.id) continue;
      const record = registered.get(key);
      examples.push({
        ...entry.example,
        // The BUILD's name when there is one, so what the tree reports is what this page can
        // resolve. An unregistered example keeps its catalogue-local id: it can never grow a run
        // control, so its name never has to be unique beyond its node.
        ...(record ? { id: record.id, digest: record.sha256 } : {}),
      });
    }
    return examples;
  };
}

/**
 * "How to access", for a node this build never saw.
 *
 * TWO ROUTES AND NO PROGRAM. A live node is a path the visitor just discovered, so what can be
 * offered about it is what its address IS: the `s3://` URI a client takes, and the `https://` URL
 * the same object answers on through the gateway - both the node's own `path` rearranged. No
 * Python is written here: the playground runs snippets this build hashed, by name, and a program
 * composed in the browser for a path the build never saw is what registered examples exist to
 * close off.
 */
function liveAccessExamples(
  config: TreeS3Config | null,
  python: PythonPlaygroundConfig | undefined,
): ((node: DatasetTreeNode) => readonly DatasetAccessExample[]) | undefined {
  if (!config) return undefined;
  const runnable = new Set(python?.recipes ?? []);
  return (node: DatasetTreeNode): readonly DatasetAccessExample[] => {
    // A STORE, and nothing else: no details on a directory. Every node the adapter produces has an
    // `s3://` path, so answering for all of them gives a collection and an ordinary folder each an
    // access panel, a details toggle and the selected-row treatment. A folder has no recipe - the
    // thing a reader opens is the store inside it, and the folder's own address is the names
    // already on screen.
    if (node.kind !== "dataset") return [];
    const binding = bindStore(node.path, config);
    if (!binding) return [];
    return TREE_RECIPES.map((recipe) => {
      const example: DatasetAccessExample = {
        id: `recipe:${recipe.id}`,
        label: recipe.label,
        language: "python",
        // Spread, not assigned: a recipe without prose must not acquire an empty one, and under
        // `exactOptionalPropertyTypes` an explicit `undefined` is not the same as an absent key.
        ...(recipe.description ? { description: recipe.description } : {}),
        code: renderRecipe(recipe, binding, config.endpoint),
      };
      // The DIGEST is what turns a snippet into something the page may run, and it is attached only
      // to a recipe whose imports the configured profile carries: a recipe that would open a
      // terminal to print `ModuleNotFoundError` is shown, copyable, and has no run control. The
      // digest is the BUILD's, over the template rather than over this rendered string - the store
      // is a parameter, the recipe is what was registered and hashed.
      const digest = python?.recipeDigests?.[recipe.id];
      if (digest && runnable.has(recipe.id)) {
        (example as { digest?: string; executable?: boolean }).digest = digest;
        // `executable` is the CATALOGUE's word for "this is meant to be run", and the component
        // requires it alongside the digest. A live recipe has no catalogue entry to carry it, so it
        // is set here, under the same condition that attached the digest.
        (example as { executable?: boolean }).executable = true;
      }
      return example;
    });
  };
}

/** The live source's configuration, as the build wrote it onto the block. */
function readS3Config(host: HTMLElement): TreeS3Config | null {
  const raw = host.dataset.portalDatasetTreeS3;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TreeS3Config;
    return parsed && Array.isArray(parsed.roots) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Open an inspector for a node, without knowing what one is.
 *
 * The event first, and this portal's own inspector only if nobody took it. A deployment that mounts
 * its own listens on the block (or any ancestor - the event bubbles) and calls `preventDefault()`.
 * Neither `@freva-org/dataset-tree` nor this file knows about a particular portal's inspector.
 */
async function openInspector(
  host: HTMLElement,
  node: DatasetTreeNode,
  loader: InspectorLoader | undefined,
): Promise<void> {
  const event = new CustomEvent("portal:dataset-inspect", {
    bubbles: true,
    cancelable: true,
    detail: { node, inspect: node.inspect },
  });
  const proceed = host.dispatchEvent(event);
  if (!proceed) return;
  if (typeof node.inspect !== "string") return;
  // NO URL FALLBACK to `window.open(node.inspect)`. The URL is the store's own HTTPS location, and
  // a `.zarr/` prefix served over HTTP is an XML listing document, so a reader who pressed Inspect
  // would be handed a page of markup describing object keys - worse than a dead control, because
  // it looks like the feature working. Either the portal has an inspector or the control is not
  // drawn, and the component arranges the second half by drawing `Inspect` only with a handler.
  if (!loader) {
    reportFailure(
      host,
      new Error(
        "This portal has no data inspector wired, so the store cannot be opened here. " +
          "That is a build-time integration gap rather than something the archive did.",
      ),
    );
    return;
  }
  await loader({ url: node.inspect });
}

/**
 * A listing the adapter cut short, said in the page. Reaching `maxPages` means the prefix has more
 * entries than a tree is the right tool for, and a visitor who is not told will read a partial
 * listing as a complete one.
 */
function reportTruncation(
  host: HTMLElement,
  info: { bucket: string; prefix: string; pages: number },
): void {
  const note = document.createElement("p");
  note.className = "portal-note portal-dataset-tree-truncated";
  note.setAttribute("role", "status");
  note.textContent =
    `Only the first ${info.pages} pages of s3://${info.bucket}/${info.prefix} were listed. ` +
    "Narrow the prefix to see the rest.";
  host.append(note);
}

/**
 * Mount every dataset-tree block on the page.
 *
 * Idempotent by marker: the generated entry runs once per document, but a view transition or a
 * re-render may call this again, and mounting a second tree into a host that already has one leaves
 * the first one's listeners attached to detached nodes.
 */
export function mountDatasetTreeBlocks(loaders: TreeLoaders = {}): Promise<void> {
  const hosts = document.querySelectorAll<HTMLElement>("[data-portal-dataset-tree]");
  // Before the first block draws anything, and not at all on a page that has no block: the
  // package's stylesheet is adopted here rather than linked from every page's head.
  if (hosts.length > 0) adoptTreeStyles();
  const mounted: Promise<void>[] = [];
  for (const host of hosts) {
    if (host.dataset.portalDatasetTreeMounted === "yes") continue;
    host.dataset.portalDatasetTreeMounted = "yes";
    mounted.push(mountOne(host, loaders).catch((error: unknown) => reportFailure(host, error)));
  }
  wireExpandControls();
  // A promise that SETTLES rather than one that succeeds. The caller is the generated entry, which
  // prepares the Python playground once every block has registered itself; a block that failed to
  // mount has still finished, and one broken block must not leave the launcher unbuilt for the rest
  // of the page. Each mount reports its own failure in its own host.
  return Promise.all(mounted).then(() => undefined);
}

/**
 * One block, from whichever source the build gave it.
 *
 * Asynchronous only because the LIVE source's adapter arrives through a dynamic import - a
 * snapshot block resolves on the first tick and draws in the same frame it always did.
 */
async function mountOne(host: HTMLElement, loaders: TreeLoaders): Promise<void> {
  const data = readHostData(host);
  const mode = host.dataset.portalDatasetTreeMode === "s3" ? "s3" : "snapshot";

  let source: DatasetTreeSource;
  let catalog: DatasetTreeCatalog | null = null;
  let truncated: { bucket: string; prefix: string; pages: number } | null = null;

  if (mode === "s3") {
    if (!loaders.s3) throw new Error("this build has no live dataset-tree source");
    const config = readS3Config(host);
    if (!config) throw new Error("the live source configuration is missing or unreadable");
    host.replaceChildren();
    source = await loaders.s3(config, (info) => {
      truncated = info;
    });
  } else {
    if (!loaders.snapshot) throw new Error("this build has no snapshot dataset-tree source");
    const loaded = await loaders.snapshot(readJsonBlock(host));
    // The data block has served its purpose. Dropping it also drops the second copy of the
    // catalogue that would otherwise sit in the DOM for the life of the page.
    host.replaceChildren();
    source = loaded.source;
    catalog = loaded.catalog as DatasetTreeCatalog;
  }

  // The Python half, assembled only when the build asked for one. `accessExamples` is where the
  // catalogue's own examples meet the digests the build computed: the tree gets an example carrying
  // a composed id and a digest, and offers a run control only for the ones that pass its own five
  // checks.
  const python = readPythonConfig(host);
  const accessExamples = catalog
    ? snapshotAccessExamples(catalog, python, host)
    : liveAccessExamples(readS3Config(host), python);
  // A LIVE block registers its recipe TEMPLATES, once, as the sources this page may run. The tree
  // sends a name, a digest and the store's own node id; the runner looks the name up here, checks
  // the digest against the build's, and substitutes the store into the template it holds - so the
  // program that reaches the interpreter is the one the build hashed and the archive path is a
  // parameter, never source composed in the page.
  if (!catalog && python) {
    const sources = new Map<string, ExampleSource>();
    for (const recipe of TREE_RECIPES) {
      sources.set(`recipe:${recipe.id}`, { title: recipe.label, source: recipe.template });
    }
    // The binder travels WITH the block, because the recipe table is the tree's and not the
    // coordinator's: in the runner it would ship an S3-store binder into every portal with a
    // runnable code block and no dataset tree, which the artifact's own absence check refuses.
    //
    // The rule it enforces: a value that is not an `s3://` identifier under one of the declared
    // roots, in a character set with no quote, backslash or control character, produces no program.
    const store = python.store;
    registerPythonBlock({
      host,
      config: python,
      sources,
      bind: (request, example) => {
        if (!example.source.includes(STORE_PLACEHOLDER)) return example;
        if (!store) return null;
        const binding = bindStore(request.datasetId, store);
        if (!binding) return null;
        const id = request.exampleId;
        const recipeId = id.startsWith("recipe:") ? id.slice("recipe:".length) : id;
        const recipe = TREE_RECIPES.find((candidate) => candidate.id === recipeId);
        if (!recipe) return null;
        return { title: example.title, source: renderRecipe(recipe, binding, store.endpoint) };
      },
    });
  }

  // THE MAXIMIZE CONTROL MOVES INTO THE TREE'S OWN TOOLBAR. Left in the block's header row it
  // gives a visitor two bars a heading's height apart, two of whose controls act on the same
  // panel. The package publishes `toolbarExtras` for exactly this, so the button becomes one of
  // the panel's controls without this file naming a class inside the component. It is the SAME
  // NODE the server rendered, moved rather than recreated - its label, its `aria-expanded` and
  // the listener `wireExpandControls` attaches all travel with it - so a build whose island never
  // runs still has a button in the markup rather than a missing one.
  const panel = host.closest<HTMLElement>("[data-portal-tree-panel]");
  const expandControl = panel?.querySelector<HTMLElement>("[data-portal-tree-expand]");

  mountDatasetTree(host, {
    source,
    ...(expandControl ? { toolbarExtras: [expandControl] } : {}),
    initialExpandedIds: data.expand,
    // ONE label override: the badge on a collection that has been announced but has nothing in it
    // yet. The package's default is the generic word because its vocabulary is not any one
    // deployment's; for a portal browsing an object store "no data yet" reads as a schedule rather
    // than a fault. Lowercase and unpunctuated on purpose - it sits in a list of eleven rows and
    // must not be the loudest thing in it.
    labels: { emptyBadge: "no data yet" },
    ...(accessExamples ? { accessExamples } : {}),
    // THE INSPECTOR, wired generically or not at all. A node's `inspect` is an absolute `https:`
    // URL the source supplied, and the package draws the control only when the node has one AND a
    // consumer supplied this, so supplying it ALWAYS is what keeps `inspect` from being dead data.
    // What it does is deliberately not this package's business: it dispatches a cancelable
    // `portal:dataset-inspect` event on the block and proceeds only if nobody called
    // `preventDefault()`. A deployment that mounts its own inspector listens for the event; one
    // that mounts nothing gets a handler that says so out loud rather than opening a storage URL.
    onInspect: (node) => openInspector(host, node, loaders.inspector),
    ...(python
      ? {
          python: {
            enabled: true,
            // Reported through the bridge, which holds no playground of its own. This island must
            // not name the coordinator even in a dynamic `import()`: that is still an edge in the
            // module graph, and the bundler would emit the interpreter's chunk for every portal
            // with a tree. The bridge keeps "has a tree" and "has an interpreter" separate claims.
            onTry: (event: TryPythonEvent) => tryPython(event),
          },
        }
      : {}),
    // The footer states what the source recorded, and nothing else: `snapshot` for a catalogue,
    // `live` for a gateway. The tone is the source's nature rather than a word a deployment picked,
    // because "how old is this" has a different answer for each.
    status: {
      tone: mode === "s3" ? "live" : "snapshot",
      label: data.statusLabel,
      ...(data.generatedAt ? { detail: data.generatedAt } : {}),
      ...(data.sourceLabel ? { code: data.sourceLabel } : {}),
    },
  });

  if (truncated) reportTruncation(host, truncated);
  if (expandControl) settleBlockBar(panel);
}

/**
 * What is left of the block's header row once its control has moved into the panel.
 *
 * A heading and a summary, or nothing at all - and when it is nothing, the row goes with it. The
 * bar carries a `min-height` so a control that grows on hover cannot reflow the line, and on an
 * empty div that is 34px of blank page above the panel. `hidden` rather than a class, so the row is
 * out of the accessibility tree as well as off the screen. The attribute is what the stylesheet
 * reads where there IS a heading: the row no longer holds a control, so it reserves no height.
 */
function settleBlockBar(panel: HTMLElement | null | undefined): void {
  const bar = panel?.querySelector<HTMLElement>(".portal-dataset-tree-bar");
  if (!bar) return;
  bar.dataset.portalTreeBar = "text";
  const head = bar.querySelector<HTMLElement>(".portal-dataset-tree-head");
  if (head && head.children.length === 0) bar.hidden = true;
}

/**
 * The maximize control: the block becomes the screen, and Escape brings it back.
 *
 * The tree is NOT re-mounted - `createTreeMaximize` relocates the block's own node into the
 * portal's overlay root - so every branch the visitor had opened, the node they had chosen and
 * the tree's scroll position survive. Re-mounting would throw all three away, which is what makes
 * a maximize control feel broken.
 *
 * THE LABEL NEVER SAYS "COLLAPSE": the tree's own toolbar has an `Expand all` / `Collapse` pair
 * for its branches, so a second `Collapse` beside it would be two controls with the same word,
 * one collapsing branches and one leaving full screen. It reads `Maximize` / `Exit full screen`.
 *
 * Three ways out, because a full-screen surface with one way out is a trap: the button, Escape
 * and the browser Back button. Back is wired through a history entry, so a visitor who maximized
 * the tree and reached for Back gets the page they were on - the one case where taking over
 * history is right, because a maximized workspace is a place rather than a menu.
 */
function wireExpandControls(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-portal-tree-expand]");
  for (const button of buttons) {
    const panel = button.closest<HTMLElement>("[data-portal-tree-panel]");
    if (!panel || button.dataset.portalTreeWired === "yes") continue;
    button.dataset.portalTreeWired = "yes";
    const text = button.querySelector<HTMLElement>(".portal-tree-expand-text");

    // WHERE THE CONTROL LIVES DEPENDS ON WHAT IT IS FOR. In the page it is one of the panel's
    // controls, so it stands in the toolbar beside `Collapse all`. Full screen it is the way OUT
    // of a surface that has taken over the screen, and the corner is where every full-screen
    // viewer, video player and lightbox puts that. So it moves, and it moves BACK: `slot` is
    // remembered as a parent plus a next sibling rather than as an index, because the toolbar's
    // contents are the component's business, and `insertBefore(node, null)` appends, which is
    // right when the control was last in the row.
    let slot: { parent: Node; before: Node | null } | null = null;
    const header = panel.querySelector<HTMLElement>(".portal-dataset-tree-bar");

    const sheet = createTreeMaximize(panel, {
      onChange: (on) => {
        button.setAttribute("aria-expanded", String(on));
        const label = on ? "Exit full screen" : "Maximize";
        if (text) text.textContent = label;
        // The accessible name follows the visible one; a glyph-only control whose name went stale
        // is worse than one that never had a label.
        button.setAttribute("aria-label", on ? label : "Maximize the dataset browser");

        if (on && header) {
          slot = { parent: button.parentNode!, before: button.nextSibling };
          // The header row is hidden on a block that configured neither a heading nor a summary,
          // where it would be an empty band above the panel. In the sheet it has a job again, so it
          // comes back, and it goes away again on the way out.
          if (header.hidden) {
            header.hidden = false;
            header.dataset.portalTreeBarRevealed = "yes";
          }
          header.append(button);
        } else if (!on && slot) {
          // MOVING A FOCUSED ELEMENT BLURS IT, so the focus is put back after the move.
          // `createTreeMaximize` restores the focus to this control and THEN reports the change,
          // which is right for a control that has not moved. This one has: taking it out of the
          // sheet's header drops it from the document for an instant and the focus lands on
          // `<body>`, leaving a visitor who pressed Escape at the top of the page.
          const hadFocus = document.activeElement === button;
          slot.parent.insertBefore(button, slot.before);
          if (hadFocus) button.focus();
          slot = null;
          if (header?.dataset.portalTreeBarRevealed === "yes") {
            header.hidden = true;
            delete header.dataset.portalTreeBarRevealed;
          }
        }
      },
    });

    const collapse = (fromPop: boolean): void => {
      if (!sheet.isOpen()) return;
      sheet.close();
      // Only unwind history when we are not already being unwound BY it.
      if (!fromPop && history.state?.portalTreeExpanded) history.back();
    };

    button.addEventListener("click", () => {
      if (sheet.isOpen()) {
        collapse(false);
        return;
      }
      sheet.open();
      history.pushState({ portalTreeExpanded: true }, "");
    });

    document.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape") collapse(false);
    });
    // A click outside the sheet is handled by the BACKDROP, a real element under the sheet rather
    // than a pseudo-element that can be seen and not clicked, so nothing here tests containment.
    window.addEventListener("popstate", () => collapse(true));
  }
}
