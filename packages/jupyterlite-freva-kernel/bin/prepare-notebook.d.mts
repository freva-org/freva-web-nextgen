export declare const LITE_CORE_VERSION: string;
/** This preparation's revision (the digest of its script), recorded in every site it prepares. */
export declare const PREPARE_DIGEST: string;
/** Where a site's jupyter-lite.json files do not name its tab icon `path` as `faviconUrl`. */
export declare function faviconProblems(siteDir: string, path: string): string[];
export declare const INVENTORY: string;
export declare const INVENTORY_SCHEMA: number;
export declare const KERNEL_SETTINGS_KEY: string;
export declare const DISABLED_EXTENSIONS: readonly string[];
export declare const APPS: readonly string[];
export declare const LAB_APPS: readonly string[];
export declare const SOURCE_DATE_EPOCH: number;

export interface NotebookSeed {
  /** `x.ipynb` or `folder/x.ipynb`. */
  name: string;
  path?: string;
  text?: string;
}

export interface NotebookInventory {
  schemaVersion: number;
  jupyterliteCore: string;
  apps: string[];
  kernel: { name: string; version: string };
  /** Every federated extension, with where it came from (`package`, or the pinned wheel). */
  extensions?: { name: string; version: string; source: string }[];
  disabledExtensions: string[];
  requirements: { name: string; version: string; sha256: string }[];
  /** With `lab`: the pinned wheels that carried extensions. */
  extensionWheels?: { name: string; version: string; sha256: string }[];
  /** With `lab`: SHA-256 of the settings overrides exactly as written. */
  overridesSha256?: string;
  /** With `lab`: files added to the site. */
  added?: string[];
  /** The app's name (the tab's title). */
  appName?: string;
  /** The site's own tab icon, at the site root. */
  favicon?: { path: string; sha256: string };
  /** The Content-Security-Policy every page carries as a `<meta>` tag, when asked for. */
  metaPolicy?: string;
  /** `PREPARE_DIGEST` of the preparation that made the site. */
  preparedBy?: string;
  seeds: string[];
  settingsSha256: string;
  entry: string;
  labEntry?: string;
  files: { path: string; sha256: string; bytes: number }[];
}

export declare function pinnedRequirements(
  file?: string,
): { name: string; version: string; sha256: string }[];
export declare function liteConfig(options: {
  settings: unknown;
  appName?: string;
  disabledExtensions?: readonly string[];
}): unknown;
export declare function externalizeInline(siteDir: string): void;
export declare function missingPluginIds(siteDir: string, ids: readonly string[]): string[];
export declare function auditSite(
  siteDir: string,
  expect?: {
    apps: readonly string[];
    extensions: readonly string[];
    disabledExtensions: readonly string[];
  },
): string[];
export declare function pinnedWheels(options: {
  requirements: string;
  bin: string;
  cacheDir?: string;
  log?: (message: string) => void;
}): { name: string; version: string; sha256: string; path: string }[];
export declare function wheelExtensions(
  wheel: string,
  bin: string,
): { name: string; version: string }[];

/** A trimmed JupyterLab interface beside the Notebook interface. */
export interface LabOptions {
  /** Prebuilt extension directories (each with a package.json). */
  extensions?: readonly string[];
  /** A pins file (`name==version --hash=sha256:...`) of wheels carrying prebuilt extensions. */
  requirements?: string;
  /** JupyterLab settings overrides. */
  overrides?: Record<string, unknown>;
  /** Plugin ids to disable, each checked against the build. */
  disabledExtensions?: readonly string[];
  /** Files added to the site. */
  files?: readonly { path: string; text?: string; bytes?: Uint8Array }[];
}
/** The site's own tab icon: `favicon.svg`, `favicon.png` or `favicon.ico` at the site root. */
export interface FaviconOptions {
  path: string;
  bytes: Uint8Array;
  type: string;
}
export declare const TAB_ICON_PLUGIN: string;
export declare function linkFavicon(siteDir: string, favicon: FaviconOptions): void;
export declare function siteFiles(
  siteDir: string,
): { path: string; sha256: string; bytes: number }[];
export declare function prepareNotebookSite(options: {
  out: string;
  settings: unknown;
  seeds?: readonly NotebookSeed[];
  appName?: string;
  favicon?: FaviconOptions;
  pythonExecutable?: string;
  cacheDir?: string;
  labextension?: string;
  lab?: LabOptions;
  /** A meta-safe policy (`metaPolicyOf`) written into every page as a `<meta>` tag. */
  metaPolicy?: string;
  log?: (message: string) => void;
}): Promise<NotebookInventory>;
/** A policy without what a `<meta>` tag cannot deliver, and the directives left out. */
export declare function metaPolicyOf(policy: string): { policy: string; dropped: string[] };
export declare function writeMetaPolicy(siteDir: string, policy: string): void;
export declare function metaPolicyProblems(siteDir: string, policy: string): string[];
/** The page with `policy` as its only CSP meta element, first in `<head>`; throws if it can't. */
export declare function setMetaPolicy(html: string, policy: string): string;
/** Why the page's meta policy is not exactly `policy`, or null. */
export declare function pageMetaPolicyProblem(html: string, policy: string): string | null;
/** Every Content-Security-Policy `<meta>` element's span in a page, as a browser parses it. */
export declare function cspMetaTags(html: string): { start: number; end: number }[];
export declare function verifyNotebookSite(siteDir: string): string[];
