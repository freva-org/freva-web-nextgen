/**
 * The seam between a dataset tree and a Python playground, with no Python in it.
 *
 * The tree island is loaded by every portal that has a dataset-tree block. The playground - the
 * terminal window, the console, jQuery, Prism, the interpreter - must be loaded only by a portal
 * that asked for one, which the generated entry expresses as a literal import. A dynamic import
 * is still a graph edge, so a tree island holding the `import()` would make the bundler emit that
 * chunk for every portal with a tree. So neither side imports the other: both import this, which
 * is a registry and two functions and pulls in nothing. A press goes in one end; whether anything
 * comes out the other depends on whether the build imported the module that installs a handler.
 */

/** What the build computed for one runnable example. Structural: nothing heavy is imported. */
export interface RegisteredExampleDigest {
  /**
   * What a run request names. `<block instance>/<node id>/<example id>` for a dataset-tree
   * example, each segment percent-escaped by the build; `content:<escaped source path>#<code-block
   * occurrence>` for a snippet in a document. Two schemes, one namespace, both injective - all the
   * coordinator needs, since it resolves a name against a registry rather than parsing it.
   */
  id: string;
  /** The node the example belongs to, unescaped. Absent for a snippet in a document. */
  datasetId?: string;
  /**
   * The example's own id within that node, unescaped. The island finds this entry by (node,
   * example) from the catalogue it is already reading and takes `id` from here rather than
   * composing one, so the escaping has one implementation and the page cannot disagree with the
   * build about what a snippet is called.
   */
  exampleId?: string;
  sha256: string;
  /**
   * The divider title, for an example the page cannot name from a catalogue it is reading. A label
   * and nothing else: it is never handed to the interpreter.
   */
  title?: string;
}

export interface PythonPlaygroundConfig {
  profile: string;
  autostart: "never" | "after-interactive" | "immediately";
  maxSessions: number;
  initialSource?: string;
  playgroundOrigin?: string;
  /** A self-hosted Pyodide directory, when the deployment does not use the pinned CDN. */
  runtimeIndexUrl?: string;
  /** Where the Freva client's wheels are served from, for the `freva-client` profile. */
  wheelhouseUrl?: string;
  /** Where the curated add-ons' pinned artefacts are served from. */
  addonBaseUrl?: string;
  /** Curated add-ons to prepare, validated at build time against a closed catalogue. */
  addons: string[];
  /**
   * The subset of `addons` whose absence must not stop the interpreter. Validated at build time:
   * every entry is one the interpreter can drop without leaving a half-changed session.
   */
  optionalAddons: string[];
  /** Exactly the origins the interpreter may reach. Recorded in the page's policy, not read here. */
  connectOrigins: string[];
  /** Whether a Freva refresh token survives a reload. False unless the deployment asked. */
  persistCredentials: boolean;
  /** How much of the network the visitor's Python may reach. `"origins"` unless configured. */
  network: "origins" | "https";
  /**
   * Where packages may come from, as the BUILD resolved it - the same value that wrote this page's
   * `connect-src`. The package help panel is rendered from it, so the two cannot disagree.
   */
  packagePolicy: {
    kind: "curated" | "open";
    /** True exactly when `kind` is `"open"`: the page's `connect-src` carries the `https:` scheme. */
    anyHttpsOrigin: boolean;
    /** True when a public package index is reachable - because the profile needs one, or open. */
    packageIndex: boolean;
    origins: string[];
    sources: { runtime: string; wheelhouse?: string; addons?: string };
  };
  terminal: {
    osControls: "auto" | "mac" | "windows" | "linux";
    alwaysOnTop: boolean;
    rememberAppearance: boolean;
  };
  examples: RegisteredExampleDigest[];
  /**
   * Recipe ids this build's profile can actually execute. A live archive has no build-time
   * catalogue, so its snippets are TEMPLATES the build registered and the page fills in with a
   * validated store identifier. Every template is shown, because a reader may want to copy one
   * into an environment that has the packages; only the ones listed here get a run control,
   * because a button that opens a terminal to print `ModuleNotFoundError` is worse than no button.
   */
  recipes?: string[];
  /**
   * `recipe id -> sha256 of its TEMPLATE`, as the build computed it. The digest is over the
   * template rather than the rendered snippet - the recipe is what was registered and the store is
   * a parameter - which keeps the source/digest contract intact for stores nobody could hash.
   */
  recipeDigests?: Record<string, string>;
  /** The archive a recipe's store parameter must belong to. Checked by the runner too. */
  store?: {
    endpoint: string;
    style: "path" | "virtual-host";
    roots: { bucket: string; prefix?: string }[];
  };
}

/** One snippet a page can run: the title for its divider, and its source. */
export interface ExampleSource {
  title: string;
  source: string;
}

/** A press, exactly as `@freva-org/dataset-tree` reports it. A name and a digest; never source. */
export interface TryPythonRequest {
  exampleId: string;
  digest: string;
  datasetId?: string;
}

/**
 * What a launcher needs to know about the playground, and nothing more. The launcher is drawn by
 * the light entry, which exists before the coordinator is loaded and cannot read its variables.
 */
export interface PlaygroundState {
  /** The window is on screen. */
  shown: boolean;
  minimized: boolean;
  /** How many interpreters exist, and how many this page allows. */
  sessions: number;
  maxSessions: number;
  /** How many of them have finished starting. */
  started: number;
  /** One line a person can read: what it is doing, or why it is not. */
  status: string;
}

/**
 * How a provider turns a registered TEMPLATE into the program that will actually run.
 *
 * A dataset tree's access recipes have one hole in them - the store - and a live archive's stores
 * are discovered in the browser, so no build could have hashed a snippet for one. The tree
 * supplies this; runnable documentation does not, because a snippet in a document is already the
 * program. It lives on the PROVIDER rather than in the coordinator, which keeps a documentation
 * page from shipping the tree's recipe table: a coordinator naming `tree-recipes.js` puts an
 * S3-store binder in the graph of every portal with a runnable code block, tree or no tree.
 *
 * Returns the source to run, or `null` to refuse - the security boundary, and the only thing it
 * may do with a value it does not recognise.
 */
export type ExampleBinder = (
  request: TryPythonRequest,
  example: ExampleSource,
) => ExampleSource | null;

/** One provider that declared a playground: a dataset-tree block, or a page's runnable snippets. */
export interface PythonBlock {
  /** The element a failure is reported next to. The provider's own, never a guessed selector. */
  host: HTMLElement;
  config: PythonPlaygroundConfig;
  /** Registered example id -> its source. Read from what the page already contains. */
  sources: Map<string, ExampleSource>;
  /** Present only for a provider whose examples are templates. See {@link ExampleBinder}. */
  bind?: ExampleBinder;
}

const blocks: PythonBlock[] = [];
let handler: ((request: TryPythonRequest) => void) | null = null;

/** Called by the tree island for each block whose configuration carries a playground. */
export function registerPythonBlock(block: PythonBlock): void {
  blocks.push(block);
}

/** Every registered block, in document order. Read by whatever installs the handler. */
export function pythonBlocks(): readonly PythonBlock[] {
  return blocks;
}

/**
 * Install the thing that actually runs an example. Exactly one handler: a second call replaces the
 * first rather than adding to it, because two handlers would mean two windows for one press.
 */
export function onTryPython(next: (request: TryPythonRequest) => void): void {
  handler = next;
}

/**
 * Report a press. With no handler installed this does nothing, deliberately and silently: the
 * build did not ask for a playground, so the tree drew no run control and nothing can have pressed
 * it. There is no queue, because a press nobody can serve is not work to be caught up on.
 */
export function tryPython(request: TryPythonRequest): void {
  handler?.(request);
}

/** For tests: forget every registration, so one page's blocks are not another's. */
export function resetPythonBridge(): void {
  blocks.length = 0;
  handler = null;
}
