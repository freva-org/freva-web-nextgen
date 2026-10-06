// The notebook on the playground origin: what `prepare-notebook` builds it from, and how a build
// checks that a prepared site is the one this configuration needs.
//
// Everything here is derived from the resolved configuration - the session policy, the child
// playground's resolved artefact locations and its registered examples - so the notebook's
// kernels, its seed notebooks and its Content-Security-Policy cannot disagree with the playground
// they sit beside.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { canonicalJson, describeSetup, type SessionSetup } from "@freva-org/browser-python/session";
import type * as KernelCspModule from "@freva-org/jupyterlite-freva-kernel/csp";
import type * as KernelPrepareModule from "@freva-org/jupyterlite-freva-kernel/prepare";
import type { NotebookInventory } from "@freva-org/jupyterlite-freva-kernel/prepare";
import { sessionPolicyOf, starterRuns } from "./python-playground.js";
import { PROFILE_PACKAGES } from "./tree-recipes.js";
import { TREE_RECIPES, runnableRecipes } from "./recipe-templates.js";
import type {
  DatasetTreeBlockData,
  NotebookAssistantSettings,
  NotebookDataPanelSettings,
  PlaygroundArtifactData,
  PlaygroundSettings,
} from "./types.js";

/** Where the notebook is served on the playground origin, and kept in the artifact. */
export const NOTEBOOK_PATH = "notebook";
export const NOTEBOOK_ARTIFACT_DIR = `playground-origin/${NOTEBOOK_PATH}`;

/**
 * Where an example's seed notebook lives in the site. The portal's window opens the same path
 * (`client/notebook-paths.ts`); a test keeps them equal.
 */
export function notebookSeedPath(digest: string): string {
  return `examples/example-${digest.slice(0, 12)}.ipynb`;
}

export interface NotebookPlan {
  /** The kernel extension's settings (`litePluginSettings`), as `prepare-notebook` writes them. */
  settings: Record<string, unknown>;
  seeds: { name: string; text: string }[];
  /** SHA-256 of the settings exactly as the inventory records them. */
  settingsSha256: string;
  /** The trimmed JupyterLab interface, with the assistant and/or the data panel. */
  lab?: LabPlan;
  /** The app's name: the portal's, "<site title> Playground". */
  appName?: string;
  /** The portal's favicon, as the notebook's tab icon. */
  favicon?: { path: string; bytes: Buffer; type: string; sha256: string };
}

/** The portal's own name and tab icon, for its notebook. */
export interface NotebookIdentity {
  title: string;
  favicon?: { bytes: Buffer; type: string; extension: string };
}

/** What the resolver read for the notebook's assistant and data panel. */
export interface NotebookLabInputs {
  siteTitle: string;
  playgroundOrigin: string;
  /**
   * The shared sign-in callback's path (`/auth/callback/`): on the notebook's origin, whose
   * deployment is served from its root. One setting with the portal's own callback route.
   */
  authCallbackPath: string;
  /**
   * The base path the playground origin serves this deployment under: the portal's, since the
   * compiler writes it into every URL of the pages deployed there (`/`, `/showroom/`).
   */
  basePath: string;
  assistant?: NotebookAssistantSettings;
  dataPanel?: {
    settings: NotebookDataPanelSettings;
    block: DatasetTreeBlockData;
    /** The block's published search index (live trees). */
    searchIndex?: Buffer;
    /** The sanitised icon. */
    iconSvg?: string;
    seeds: { name: string; text: string }[];
    /** The seed (by its published name) the Lab opens at start, if any. */
    startSeed?: string;
  };
}

export interface LabPlan {
  /** The extensions this site needs, by npm package name. */
  packages: string[];
  /** Whether jupyterlite-ai (pinned wheels) is part of the site. */
  jupyterliteAi: boolean;
  overrides: Record<string, Record<string, unknown>>;
  disabledExtensions: string[];
  /** Files added to the site, beside the ones the extensions' packages provide. */
  files: { path: string; text: string }[];
  /** The sign-in callback URLs to register (login and logout), with the legacy page's. */
  callbacks?: AuthCallbackUrls;
}

/** One deployment's sign-in callback, as the identity provider and freva-rest must know it. */
export interface AuthCallbackUrls {
  /** Where an authorization response returns (Keycloak: Valid redirect URIs). */
  login: string;
  /** Where the provider returns after a sign-out (Keycloak: Valid post logout redirect URIs). */
  logout: string;
  /** The page before the shared callback, kept answering during the migration. */
  legacy?: string;
}

/** The legacy login callback page, kept in the notebook site for logins started before. */
export const LEGACY_CALLBACK_FILE = "freva-login-callback.html";

export const CLIMATECLAW_PACKAGE = "@freva-org/jupyterlite-climateclaw";
/** The kernel's own prebuilt extension, in every prepared site, with a JupyterLab or not. */
export const KERNEL_PACKAGE = "@freva-org/jupyterlite-freva-kernel";
export const DATA_PANEL_PACKAGE = "@freva-org/jupyterlite-freva-data";
/** GridLook, the 3D viewer `dataPanel.gridlook` lets the notebook frame. */
export const GRIDLOOK_ORIGIN = "https://gridlook.pages.dev";

/**
 * The trimmed JupyterLab interface: no text/Markdown/Python file creation, no contextual-help
 * inspector. Files still open (the editor's widget factory stays). The console stays: a Freva
 * Python console from the Launcher, and "New Console for Notebook", which shares the notebook's
 * kernel (its interpreter and variables, nothing loaded twice). Every id is checked against the
 * built JupyterLite 0.8.5 bundle by `prepare-notebook`.
 */
export const LAB_DISABLED_EXTENSIONS: readonly string[] = [
  // "Other": new text, Markdown and Python files (the file editor's tracker adds those cards).
  "@jupyterlab/fileeditor-extension:plugin",
  "@jupyterlab/fileeditor-extension:completer",
  "@jupyterlab/fileeditor-extension:cursor-position",
  "@jupyterlab/fileeditor-extension:editor-syntax-status",
  "@jupyterlab/fileeditor-extension:language-server",
  "@jupyterlab/fileeditor-extension:search",
  "@jupyterlab/fileeditor-extension:tab-space-status",
  "@jupyterlab/tooltip-extension:files",
  // "Other": "Show Contextual Help".
  "@jupyterlab/inspector-extension:inspector",
  "@jupyterlab/inspector-extension:consoles",
  "@jupyterlab/inspector-extension:notebooks",
  // The JupyterLite logo in the top bar: the portal names itself.
  "@jupyterlite/application-extension:logo",
];

/** With the assistant: what jupyterlite-ai brings that this site does not use. */
export const AI_DISABLED_EXTENSIONS: readonly string[] = [
  // The AI settings panel: the provider and model are the site's (settings overrides).
  "@jupyternaut/persona:settings-panel",
  // MCP servers need a Jupyter server; JupyterLite has none (it would fetch /jupyter-mcp-manager).
  "jupyter-mcp-manager:manager",
  // Diffs in the file editor, whose tracker is disabled above.
  "jupyterlab-diff:unified-file-diff-plugin",
  // jupyterlite-ai's chat panel: ClimateClaw shows chats in its own panel (with the chat tracker
  // and the chat commands this plugin would otherwise provide), on jupyterlite-ai's chat models.
  "@jupyterlite/ai:chat",
  // "@jupyternaut-frontend" offered on "@": jupyterlite-ai's chats answer without a mention.
  "@jupyternaut/persona:mention",
];

function sha256hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Where the playground origin serves this deployment: that origin plus the portal's base path,
 * which the compiler writes into every URL of the pages deployed there. No trailing slash.
 */
export function playgroundRoot(playgroundOrigin: string, basePath: string): string {
  return `${playgroundOrigin.replace(/\/+$/, "")}${basePath.replace(/\/+$/, "")}`;
}

/** A site-relative path (`/auth/callback/`) under the deployment's base path. */
export function underBase(basePath: string, path: string): string {
  return `${basePath.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** The notebook site's base URL on the playground origin. */
function notebookBase(playgroundOrigin: string, basePath: string): string {
  return `${playgroundRoot(playgroundOrigin, basePath)}/${NOTEBOOK_PATH}/`;
}

interface CatalogNodeLike {
  id: string;
  inspect?: string;
  examples?: { id: string; language: string; code: string; executable?: boolean }[];
  children?: CatalogNodeLike[];
}

function walkNodes(nodes: CatalogNodeLike[] | undefined, visit: (node: CatalogNodeLike) => void) {
  for (const node of nodes ?? []) {
    visit(node);
    walkNodes(node.children, visit);
  }
}

const PYTHON = new Set(["python", "python3", "py"]);

/**
 * The panel's data file: the block's source and the examples and recipes this build registers.
 * The browser hashes a snippet before it puts it into a notebook and refuses one whose bytes are
 * not these.
 */
export function panelData(
  block: DatasetTreeBlockData,
  profile: string,
  searchIndexPath: string | undefined,
): Record<string, unknown> {
  const examples: { datasetId: string; exampleId: string; sha256: string }[] = [];
  let catalog: unknown;
  if (block.mode === "snapshot") {
    catalog = JSON.parse(block.catalogScriptJson) as unknown;
    walkNodes((catalog as { roots?: CatalogNodeLike[] }).roots, (node) => {
      for (const example of node.examples ?? []) {
        if (example.executable !== true || !PYTHON.has(example.language.trim().toLowerCase())) {
          continue;
        }
        examples.push({
          datasetId: node.id,
          exampleId: example.id,
          sha256: sha256hex(example.code),
        });
      }
    });
    examples.sort((a, b) =>
      `${a.datasetId}\u0000${a.exampleId}` < `${b.datasetId}\u0000${b.exampleId}` ? -1 : 1,
    );
  }
  const runnable = new Set(runnableRecipes(PROFILE_PACKAGES[profile] ?? []));
  const recipes =
    block.mode === "s3"
      ? TREE_RECIPES.map((recipe) => ({
          id: recipe.id,
          label: recipe.label,
          ...(recipe.description ? { description: recipe.description } : {}),
          template: recipe.template,
          parameter: recipe.parameter,
          sha256: sha256hex(recipe.template),
          runnable: runnable.has(recipe.id),
        }))
      : [];
  return {
    schemaVersion: 1,
    instanceId: block.instanceId,
    mode: block.mode,
    ...(block.mode === "snapshot" ? { catalog } : {}),
    ...(block.s3 ? { s3: block.s3 } : {}),
    ...(searchIndexPath ? { searchIndex: searchIndexPath } : {}),
    ...(block.searchResultLimit !== undefined
      ? { searchResultLimit: block.searchResultLimit }
      : {}),
    expand: block.expandedIds,
    statusLabel: block.statusLabel,
    examples,
    recipes,
  };
}

/** Origins the data panel reads from: the live gateway, or the catalogue's stores. */
export function dataPanelOrigins(block: DatasetTreeBlockData): string[] {
  const origins = new Set<string>();
  if (block.s3) origins.add(block.s3.origin);
  if (block.mode === "snapshot") {
    const catalog = JSON.parse(block.catalogScriptJson) as { roots?: CatalogNodeLike[] };
    walkNodes(catalog.roots, (node) => {
      if (typeof node.inspect !== "string") return;
      try {
        const url = new URL(node.inspect);
        if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin);
      } catch {
        // Not a URL: nothing to allow.
      }
    });
  }
  return [...origins].sort();
}

function seedTitle(text: string, name: string): string {
  try {
    const nb = JSON.parse(text) as { cells?: { cell_type?: string; source?: string | string[] }[] };
    const first = nb.cells?.find((c) => c.cell_type === "markdown");
    const source = Array.isArray(first?.source) ? first.source.join("") : (first?.source ?? "");
    const heading = /^#\s+(.+)$/m.exec(source)?.[1]?.trim();
    if (heading) return heading.slice(0, 80);
  } catch {
    // The kernel package validates seeds; a title is a nicety.
  }
  return basename(name, ".ipynb");
}

/** The shared callback's path on the notebook's origin, base path included. */
export function callbackPathOf(
  lab: Pick<NotebookLabInputs, "authCallbackPath" | "basePath">,
): string {
  return underBase(lab.basePath, lab.authCallbackPath);
}

export function planLab(settings: PlaygroundSettings, lab: NotebookLabInputs): LabPlan {
  const packages: string[] = [];
  const overrides: Record<string, Record<string, unknown>> = {};
  const disabled = [...LAB_DISABLED_EXTENSIONS];
  const files: { path: string; text: string }[] = [];
  let callbacks: AuthCallbackUrls | undefined;
  const assistant = lab.assistant;
  if (assistant) {
    packages.push(CLIMATECLAW_PACKAGE);
    disabled.push(...AI_DISABLED_EXTENSIONS);
    // The shared callback under the deployment's base path on the notebook's origin, never
    // under /notebook/: the same URL for every consumer on that origin.
    const shared = `${lab.playgroundOrigin.replace(/\/+$/, "")}${callbackPathOf(lab)}`;
    callbacks = {
      login: shared,
      logout: shared,
      legacy: `${notebookBase(lab.playgroundOrigin, lab.basePath)}${LEGACY_CALLBACK_FILE}`,
    };
    overrides["@jupyternaut/persona:settings-model"] = {
      providers: [
        {
          id: "climateclaw",
          name: "ClimateClaw",
          provider: "climateclaw",
          model: assistant.defaultModel,
        },
      ],
      defaultProvider: "climateclaw",
      useSameProviderForChatAndCompleter: false,
      useSecretsManager: false,
      toolsEnabled: false,
    };
    overrides["@jupyterlite/ai:chat"] = { chatBackupDirectory: "chats" };
    // The (empty) backup directory exists in the site, so listing it does not ask the server.
    files.push({
      path: "api/contents/chats/all.json",
      text: `${JSON.stringify({
        content: [],
        created: "2025-10-01T00:00:00.000Z",
        format: "json",
        hash: null,
        hash_algorithm: null,
        last_modified: "2025-10-01T00:00:00.000Z",
        mimetype: null,
        name: "chats",
        path: "chats",
        size: null,
        type: "directory",
        writable: true,
      })}\n`,
    });
    overrides[`${CLIMATECLAW_PACKAGE}:plugin`] = {
      host: assistant.host,
      authBaseUrl: assistant.authBaseUrl,
      // Origin-relative: the notebook resolves it against its own origin, so no host name is in
      // the site's settings.
      callbackPath: callbackPathOf(lab),
      ...(assistant.expectedIssuer ? { expectedIssuer: assistant.expectedIssuer } : {}),
      defaultModel: assistant.defaultModel,
      runAndFixModel: assistant.runAndFixModel ?? assistant.defaultModel,
      scopeNote: assistant.scopeNote ?? "",
      examples: assistant.examples,
      hideCodeByDefault: assistant.hideCodeByDefault,
      // Where saved figures come from: the notebook's policy lets it show pictures from there.
      ...(assistant.previewOrigin ? { previewOrigin: assistant.previewOrigin } : {}),
    };
  }
  const panel = lab.dataPanel;
  if (panel) {
    packages.push(DATA_PANEL_PACKAGE);
    let searchIndexPath: string | undefined;
    if (panel.searchIndex && panel.block.searchIndex) {
      searchIndexPath = basename(panel.block.searchIndex.file);
      files.push({ path: searchIndexPath, text: panel.searchIndex.toString("utf8") });
    }
    const data = `${JSON.stringify(panelData(panel.block, settings.profile, searchIndexPath))}\n`;
    const dataPath = `freva-data/panel.${sha256hex(data).slice(0, 12)}.json`;
    files.push({ path: dataPath, text: data });
    overrides[`${DATA_PANEL_PACKAGE}:plugin`] = {
      siteName: lab.siteTitle,
      title: panel.settings.title ?? `${lab.siteTitle} data`,
      iconSvg: panel.iconSvg ?? "",
      dataUrl: dataPath,
      dataSha256: sha256hex(data),
      kernelName: "freva-python",
      defaultAction: panel.settings.defaultAction,
      seedNotebooks: panel.seeds.map((seed) => ({
        path: seed.name,
        title: seedTitle(seed.text, seed.name),
      })),
      gridlook: panel.settings.gridlook,
      ...(panel.startSeed ? { startNotebook: panel.startSeed } : {}),
      launcher: {
        ...panel.settings.launcher,
        ask: panel.settings.launcher.ask && Boolean(assistant),
      },
    };
  }
  return {
    packages,
    jupyterliteAi: Boolean(assistant),
    overrides,
    disabledExtensions: disabled,
    files,
    ...(callbacks ? { callbacks } : {}),
  };
}

/** Where an extension package is installed: its prebuilt extension, pins and callback page. */
export function extensionPackage(name: string): {
  root: string;
  labextension: string;
  version: string;
} {
  const require = createRequire(import.meta.url);
  let manifest: string;
  try {
    manifest = require.resolve(`${name}/package.json`);
  } catch {
    throw new Error(`The notebook needs ${name}, which is not installed: npm install ${name}`);
  }
  const root = dirname(manifest);
  const labextension = join(root, "labextension");
  if (!existsSync(join(labextension, "package.json"))) {
    throw new Error(`${name} has no prebuilt extension at ${labextension}.`);
  }
  const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
  return { root, labextension, version };
}

/** Every setup the policy allows, the default first: one kernel each. */
function allowedSetups(settings: PlaygroundSettings): SessionSetup[] {
  const policy = sessionPolicyOf(settings);
  const out: SessionSetup[] = [];
  const seen = new Set<string>();
  const add = (setup: SessionSetup): void => {
    const key = canonicalJson(setup);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(setup);
  };
  add({ ...policy.defaults, frontend: "notebook" });
  // Without session choices there is one setup, as there is in the console.
  if (!settings.sessionChoices) return out;
  for (const [profile, entry] of Object.entries(policy.profiles).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const addons = [...entry.allowedAddons].sort();
    // Every subset, smallest first: the catalogue is small, so this stays a short list.
    const subsets: string[][] = [[]];
    for (const id of addons) for (const s of [...subsets]) subsets.push([...s, id]);
    subsets.sort((a, b) => a.length - b.length || a.join().localeCompare(b.join()));
    const starters = starterRuns(policy, profile);
    for (const chosen of subsets) {
      for (const runStarter of starters) {
        add({ profile, addons: chosen, runStarter, frontend: "notebook" });
      }
    }
  }
  return out;
}

function kernelId(setup: SessionSetup): string {
  return [setup.profile, ...setup.addons, ...(setup.runStarter ? [] : ["no-starter"])]
    .join("-")
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 64);
}

/** A notebook holding one registered example: a title and its code, never executed. */
function seedNotebook(example: { title: string; source: string }): string {
  const lines = (text: string): string[] =>
    text.split(/(?<=\n)/).filter((line, index, all) => line !== "" || index < all.length - 1);
  return `${JSON.stringify(
    {
      cells: [
        { cell_type: "markdown", metadata: {}, source: lines(`# ${example.title}\n`) },
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: lines(example.source),
        },
      ],
      metadata: {
        kernelspec: { display_name: "Freva Python", language: "python", name: "freva-python" },
        language_info: { name: "python" },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  )}\n`;
}

export function planNotebook(
  settings: PlaygroundSettings,
  playground: PlaygroundArtifactData,
  /** The deployment's own seed notebooks (`notebook.seeds`), already read and contained. */
  extraSeeds: readonly { name: string; text: string }[] = [],
  /** The assistant and data panel, when configured: the site gains a trimmed Lab interface. */
  lab?: NotebookLabInputs,
  /** The portal's name and favicon: the notebook's tab shows them. */
  identity?: NotebookIdentity,
): NotebookPlan {
  const setups = allowedSetups(settings);
  const kernel: Record<string, unknown> = {
    runtimeIndexUrl: playground.runtimeIndexUrl,
    ...(playground.wheelhouseUrl ? { wheelhouseUrl: playground.wheelhouseUrl } : {}),
    ...(playground.addonBaseUrl ? { addonBaseUrl: playground.addonBaseUrl } : {}),
    maxLiveInterpreters: settings.maxLiveSessions,
    ...(settings.initialSource ? { starter: settings.initialSource } : {}),
    setups: setups.map((setup, index) => ({
      id: index === 0 ? "default" : kernelId(setup),
      label: describeSetup(setup).replace(/ · notebook$/, ""),
      profile: setup.profile,
      addons: [...setup.addons],
      optionalAddons: settings.optionalAddons.filter((id) => setup.addons.includes(id)),
      runStarter: setup.runStarter,
    })),
  };
  const seeds = [...new Map(playground.examples.map((e) => [e.sha256, e])).values()]
    .sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1))
    .map((example) => ({ name: notebookSeedPath(example.sha256), text: seedNotebook(example) }));
  seeds.push(...extraSeeds);
  if (lab?.dataPanel) seeds.push(...lab.dataPanel.seeds);
  return {
    settings: kernel,
    seeds,
    settingsSha256: createHash("sha256").update(JSON.stringify(kernel)).digest("hex"),
    ...(lab && (lab.assistant || lab.dataPanel) ? { lab: planLab(settings, lab) } : {}),
    ...(identity ? notebookIdentity(identity) : {}),
  };
}

/** The notebook's name and tab icon, from the portal's: a favicon JupyterLite can link. */
function notebookIdentity(identity: NotebookIdentity): Pick<NotebookPlan, "appName" | "favicon"> {
  const ext = identity.favicon?.extension.toLowerCase();
  return {
    appName: `${identity.title} Playground`,
    ...(identity.favicon && (ext === ".svg" || ext === ".png" || ext === ".ico")
      ? {
          favicon: {
            path: `favicon${ext}`,
            bytes: identity.favicon.bytes,
            type: identity.favicon.type,
            sha256: createHash("sha256").update(identity.favicon.bytes).digest("hex"),
          },
        }
      : {}),
  };
}

/**
 * `prepareNotebookSite`'s `lab` options for a plan: the packages' prebuilt extensions, the pinned
 * jupyterlite-ai wheels, the overrides, the disabled plugins, and the files (the login callback
 * page with its script, the panel data, the search index).
 */
export function labSiteOptions(lab: LabPlan): {
  extensions: string[];
  requirements?: string;
  overrides: Record<string, unknown>;
  disabledExtensions: string[];
  files: { path: string; text: string }[];
} {
  const extensions: string[] = [];
  const files = [...lab.files];
  let requirements: string | undefined;
  for (const name of lab.packages) {
    const pkg = extensionPackage(name);
    extensions.push(pkg.labextension);
    if (name === CLIMATECLAW_PACKAGE) {
      requirements = join(pkg.root, "lite", "jupyterlite-ai-requirements.txt");
      const page = readFileSync(join(pkg.root, "callback", "freva-login-callback.html"), "utf8");
      const script = readFileSync(join(pkg.root, "callback", "freva-login-callback.js"), "utf8");
      // The legacy page, answering logins started before the shared callback (it relays its own
      // URL to the tab that started them, unchanged).
      files.push({ path: LEGACY_CALLBACK_FILE, text: page });
      files.push({ path: "freva-login-callback.js", text: script });
    }
  }
  return {
    extensions,
    ...(requirements ? { requirements } : {}),
    overrides: lab.overrides,
    disabledExtensions: lab.disabledExtensions,
    files,
  };
}

/** The kernel package's preparation module, which `portal-builder` loads only when it is used. */
type KernelPrepare = typeof KernelPrepareModule;

/**
 * `@freva-org/jupyterlite-freva-kernel` is an optional peer: only a deployment with the notebook
 * needs it, and it brings JupyterLab's packages with it.
 */
export async function loadKernelTools(): Promise<{
  prepare: KernelPrepare;
  csp: typeof KernelCspModule;
}> {
  try {
    const [prepare, csp] = await Promise.all([
      import("@freva-org/jupyterlite-freva-kernel/prepare"),
      import("@freva-org/jupyterlite-freva-kernel/csp"),
    ]);
    return { prepare, csp };
  } catch (error) {
    throw new Error(
      "The notebook needs @freva-org/jupyterlite-freva-kernel, which is not installed: " +
        `npm install @freva-org/jupyterlite-freva-kernel (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
    );
  }
}

/** A set of pins, comparable as one string. */
function pinsOf(pins: readonly { name: string; version: string; sha256: string }[]): string {
  return JSON.stringify(pins.map((p) => `${p.name}==${p.version} ${p.sha256}`).sort());
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message.split("\n")[0]! : String(error);

/** Why the site's copy of a prebuilt extension is not the installed build, or null. */
function staleExtension(dir: string, name: string): string | null {
  const loadOf = (file: string): string | undefined => {
    try {
      const manifest = JSON.parse(readFileSync(file, "utf8")) as {
        jupyterlab?: { _build?: { load?: string } };
      };
      return manifest.jupyterlab?._build?.load;
    } catch {
      return undefined;
    }
  };
  let installed: string | undefined;
  try {
    installed = loadOf(join(extensionPackage(name).labextension, "package.json"));
  } catch {
    return null; // not installed: planning the site says so
  }
  const built = loadOf(join(dir, "extensions", ...name.split("/"), "package.json"));
  return installed && built !== installed ? `it carries an older build of ${name}` : null;
}

/**
 * Whether a prepared site is the one `plan` describes: its files match its own inventory, it
 * passes the kernel package's audit, and it was built from these settings and seeds with this
 * toolchain, these pinned wheels and these extension builds. Returns the problems (empty when it
 * is) and the files to copy.
 */
export async function checkNotebookSite(
  dir: string,
  plan: NotebookPlan,
): Promise<{ problems: string[]; files: string[] }> {
  const { prepare } = await loadKernelTools();
  const problems = prepare.verifyNotebookSite(dir);
  let files: string[] = [];
  try {
    const inventory = JSON.parse(
      readFileSync(join(dir, prepare.INVENTORY), "utf8"),
    ) as NotebookInventory;
    files = [prepare.INVENTORY, ...inventory.files.map((file) => file.path)];
    if (inventory.settingsSha256 !== plan.settingsSha256) {
      problems.push("it was prepared for different kernel settings than this configuration has");
    }
    const want = plan.seeds.map((seed) => seed.name).sort();
    const digests = new Map(inventory.files.map((file) => [file.path, file.sha256]));
    if (
      JSON.stringify([...inventory.seeds].sort()) !== JSON.stringify(want) ||
      plan.seeds.some(
        (seed) =>
          digests.get(`files/${seed.name}`) !==
          createHash("sha256").update(seed.text).digest("hex"),
      )
    ) {
      problems.push("its seed notebooks are not this portal's examples and notebook.seeds");
    }
    // The build's identity beyond its inputs: the JupyterLite toolchain it was built with.
    if (inventory.jupyterliteCore !== prepare.LITE_CORE_VERSION) {
      problems.push(
        `it was built with JupyterLite ${inventory.jupyterliteCore ?? "(unknown)"}, not ${prepare.LITE_CORE_VERSION}`,
      );
    }
    if (pinsOf(inventory.requirements ?? []) !== pinsOf(prepare.pinnedRequirements())) {
      problems.push("it was built with a different pinned JupyterLite toolchain");
    }
    // The portal's name and tab icon.
    if (plan.appName && inventory.appName !== plan.appName) {
      problems.push(
        `it is named "${inventory.appName ?? "Freva Notebook"}", not "${plan.appName}"`,
      );
    }
    if (inventory.preparedBy !== prepare.PREPARE_DIGEST) {
      problems.push("it was prepared by another revision of prepare-notebook");
    }
    if ((inventory.favicon?.sha256 ?? null) !== (plan.favicon?.sha256 ?? null)) {
      problems.push("its tab icon is not this portal's favicon");
    }
    const lab = plan.lab;
    const hasLab = (inventory.apps ?? []).includes("lab");
    if (Boolean(lab) !== hasLab) {
      problems.push(
        lab
          ? "it has no JupyterLab interface, which the assistant or data panel needs"
          : "it has a JupyterLab interface this configuration does not ask for",
      );
    }
    if (lab) {
      if (
        inventory.overridesSha256 !==
        createHash("sha256").update(JSON.stringify(lab.overrides)).digest("hex")
      ) {
        problems.push("it was prepared with different assistant or data panel settings");
      }
      const names = new Set((inventory.extensions ?? []).map((e) => e.name));
      for (const name of lab.packages) {
        if (!names.has(name)) problems.push(`it does not carry ${name}`);
      }
      if (lab.jupyterliteAi && !names.has("@jupyterlite/ai"))
        problems.push("it does not carry jupyterlite-ai");
      for (const file of lab.files) {
        if (digests.get(file.path) !== createHash("sha256").update(file.text).digest("hex")) {
          problems.push(`its ${file.path} is not this configuration's`);
        }
      }
      const disabled = new Set(inventory.disabledExtensions);
      for (const id of lab.disabledExtensions) {
        if (!disabled.has(id)) problems.push(`${id} is not disabled in it`);
      }
      // jupyterlite-ai and what it needs: exactly the pinned wheels, by name, version and digest.
      let wanted = "";
      try {
        const requirements = labSiteOptions(lab).requirements;
        wanted = pinsOf(requirements ? prepare.pinnedRequirements(requirements) : []);
      } catch (error) {
        problems.push(`its pinned wheels cannot be checked: ${errorText(error)}`);
      }
      if (wanted && pinsOf(inventory.extensionWheels ?? []) !== wanted) {
        problems.push("its extension wheels are not the pinned ones (jupyterlite-ai and its own)");
      }
    }
    // The same packages, but rebuilt: a site holding an older build of one - the kernel's
    // included, whatever the lab options - is stale.
    for (const name of [KERNEL_PACKAGE, ...(lab?.packages ?? [])]) {
      const stale = staleExtension(dir, name);
      if (stale) problems.push(stale);
    }
  } catch {
    // verifyNotebookSite has already said why the inventory cannot be read
  }
  return { problems, files };
}

/**
 * The notebook's own Content-Security-Policy: the child playground's network plus the Freva host
 * (sign-in and ClimateClaw) and the data panel's store origins. Images keep `data:` and `blob:`
 * (figures from ClimateClaw), and with the assistant the origin it shows saved files from
 * (`previewOrigin`, else the host). GridLook is framed only when the panel opts in. A top-level
 * page, unless a landing has a notebook block: then the portal's origin may frame it.
 */
export async function notebookPolicy(
  playground: PlaygroundArtifactData,
  lab?: NotebookLabInputs,
  /** A landing frames the notebook: the portal's own origin may, and no other. */
  embedded = false,
): Promise<string> {
  const { csp } = await loadKernelTools();
  return csp.notebookCsp({
    runtimeIndexUrl: playground.runtimeIndexUrl,
    connectSources: [
      ...(playground.dataOrigins ?? []),
      ...(playground.connectOrigins ?? []),
      ...(playground.packageOrigins ?? []),
      ...(playground.anyHttpsOrigin ? ["https:"] : []),
      ...(lab?.assistant ? [lab.assistant.host] : []),
      ...(lab?.assistant?.previewOrigin ? [lab.assistant.previewOrigin] : []),
      ...(lab?.dataPanel ? dataPanelOrigins(lab.dataPanel.block) : []),
    ],
    // Figures ClimateClaw's code saved, shown where they are when they cannot be read (no CORS).
    imageSources: lab?.assistant ? [lab.assistant.previewOrigin ?? lab.assistant.host] : [],
    frameSources: lab?.dataPanel?.settings.gridlook ? [GRIDLOOK_ORIGIN] : [],
    ...(embedded ? { frameAncestors: [playground.hostOrigin] } : {}),
  });
}
