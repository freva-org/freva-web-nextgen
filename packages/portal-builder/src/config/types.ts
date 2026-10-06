/**
 * The parsed shape of `portal.yaml`, exactly as the published schema accepts it. These types
 * describe *input*; the rest of the builder consumes `ResolvedPortalModel`, and the one-way trip
 * between them is where validation, containment and defaulting happen.
 */

export interface RawLink {
  label: string;
  landing?: string;
  component?: string;
  /** The notebook on `playgroundOrigin`: its JupyterLab interface, or its file list. */
  notebook?: "lab" | "files";
  href?: string;
  description?: string;
  /** A typed action on an existing component (landing actions only). */
  intent?: "select-facet" | "open-dataset" | "run-example";
  facets?: Record<string, string | string[]>;
  flavour?: string;
  dataset?: string;
  example?: string;
}

export interface RawHeaderLink extends RawLink {
  links?: RawLink[];
}

export interface RawContentSource {
  root: string;
  mount: string;
  files?: { include?: string[]; exclude?: string[] };
}

export interface RawMountRoot {
  root: string;
  mount: string;
  /** The same include/exclude globs a content source takes. Absent: every file. */
  files?: { include?: string[]; exclude?: string[] };
}

export interface RawAnnouncement {
  id: string;
  message: string;
  level: "info" | "warning" | "critical";
  dismissible?: boolean;
  startsAt?: string;
  endsAt?: string;
}

export interface RawTrustedSubsite {
  profile: "static-docs-v1";
  source: string;
  mount: string;
  trust: "active";
  policy: string;
}

export interface RawService {
  kind: "databrowser" | "stac" | "auth";
  baseUrl?: string;
  catalogUrl?: string;
  authentication?: "none" | "optional" | "required";
}

export interface RawStacProvider {
  name: string;
  url?: string;
  roles?: ("licensor" | "producer" | "processor" | "host")[];
  /** A local path to the provider's mark; published through the asset pipeline at build time. */
  logo?: string;
}

export interface RawStacOptions {
  chrome?: { title?: string; image?: string; footerLinks?: { label: string; href: string }[] };
  access?: { externalCatalogs?: "deny"; basemapOrigins?: string[] };
  rootPage?: {
    title?: string;
    description?: string;
    intro?: string;
    keywords?: string[];
    license?: string;
    providers?: RawStacProvider[];
  };
  linkPolicy?: {
    canonicalizeAdvertisedRoot?: boolean;
    hiddenRelations?: string[];
    rootAliases?: string[];
  };
}

export interface RawComponent {
  kind: "databrowser" | "stac-browser" | "auth";
  enabled: boolean;
  service?: string;
  route?: string;
  title?: string;
  description?: string;
  options?: {
    defaultFlavour?: string;
    fixedFacets?: Record<string, string | string[]>;
    defaultLayout?: "browse" | "overview";
    overview?: { order?: string[]; mainFacets?: string[] };
    scopeRemovable?: boolean;
    callbackPath?: string;
    expectedIssuer?: string;
    additionalResourceOrigins?: string[];
  } & RawStacOptions;
}

export interface PortalConfig {
  schemaVersion: 1;
  site: {
    id: string;
    title: string;
    subtitle?: string;
    language: string;
    canonicalUrl: string;
    identity: { logo: string; favicon: string };
    institution?: { name: string; url?: string };
  };
  chrome?: {
    header?: {
      enabled: boolean;
      links?: RawLink[];
      prose?: string;
      search?: { enabled: boolean; placeholder?: string };
      variant?: "standard" | "centered" | "split" | "compact" | "minimal";
      sticky?: boolean;
      transparentOverHero?: boolean;
      logo?: RawImageWithVariants;
      items?: HeaderItem[];
    };
    footer?: {
      enabled: boolean;
      groups?: { title: string; links: RawLink[] }[];
      legalLinks?: RawLink[];
      /** Short links in the collapsed bar, on screen on every page. See the schema. */
      bar?: { lead?: string; links: RawLink[] };
      prose?: string;
      badge?: {
        enabled?: boolean;
        kind?: "freva";
        quality?: "auto" | "standard";
        email?: false | string;
      };
      variant?: "columns" | "stacked" | "minimal" | "bar-only";
      columns?: number;
      logos?: { src: string; alt: string; href?: string }[];
      order?: FooterSection[];
    };
    /** portal-template-v1 slot templates, by slot name (schema/slots-v1.json). */
    slots?: Partial<Record<SlotName, string>>;
  };
  theme?: {
    preset: string;
    tokens?: RawThemeTokens;
    /** How a drawn backdrop meets the end of the landing; see the schema. */
    backdrop?: { tail?: "full" | "short" | "none" };
    fonts?: RawFont[];
    stylesheet?: { profile: "portal-style-v1"; path: string };
  };
  rendering?: {
    profile: "portal-content-v1";
    sources?: RawContentSource[];
    assets?: RawMountRoot[];
    downloads?: RawMountRoot[];
    diagnostics?: { warningsAsErrors?: boolean };
    limits?: Record<string, number>;
  };
  landings?: Record<string, { path: string; source: string }>;
  services?: Record<string, RawService>;
  components?: Record<string, RawComponent>;
  navigation?: {
    header?: RawHeaderLink[];
    footer?: RawLink[];
    placement?: NavPlacement;
    pager?: boolean;
  };
  announcements?: RawAnnouncement[];
  trustedSubsites?: RawTrustedSubsite[];
  pythonPlayground?: RawPythonPlayground;
  redirects?: RawRedirect[];
  announcementFeed?: { url: string };
}

/**
 * `theme.tokens`: the flat tokens (one value for both colour modes) and, optionally, one page
 * palette per colour mode.
 */
export type RawThemeTokens = {
  [token: string]: string | number | RawThemeModeTokens | undefined;
} & {
  light?: RawThemeModeTokens;
  dark?: RawThemeModeTokens;
};

/** One colour mode's page palette: see `themes/palette.ts`. */
export type HeaderItem = "brand" | "links" | "navToggle" | "search" | "themeToggle" | "auth";
export type FooterSection = "about" | "groups" | "logos" | "legal" | "prose";
export type NavPlacement = "header" | "side" | "both";
export type SlotName =
  | "headerBrand"
  | "headerExtra"
  | "footerTop"
  | "footerColumns"
  | "footerBottom"
  | "landingSectionShell"
  | "proseAside";

export interface RawImageWithVariants {
  src: string;
  light?: string;
  dark?: string;
  alt?: string;
}

export interface RawFont {
  family: string;
  weight?: number;
  style?: "normal" | "italic";
  src: string;
}

/** A landing block's background: a fill, or a local image. */
export type RawBackground = "none" | "surface" | "accent" | { image: string };

export interface RawBlockPlacement {
  section?: string;
  span?: { base?: number; md?: number; lg?: number };
  width?: "narrow" | "content" | "wide" | "full";
  align?: "start" | "center" | "end";
  background?: RawBackground;
}

export interface RawLandingSection {
  id: string;
  heading?: string;
  width?: "narrow" | "content" | "wide" | "full";
  align?: "start" | "center" | "end";
  background?: RawBackground;
}

export interface RawThemeModeTokens {
  shadow?: "none" | "soft" | "regular" | "strong";
  colorBackground?: string;
  colorSurface?: string;
  colorText?: string;
  colorTextMuted?: string;
  colorBorder?: string;
}

/** One old public path and where it went: exactly one of `landing`, `component` or `href`. */
export interface RawRedirect {
  from: string;
  landing?: string;
  component?: string;
  href?: string;
  status?: 301 | 302 | 307 | 308;
}

export interface RawLandingBlock extends RawBlockPlacement {
  type: string;
  heading?: string;
  summary?: string;
  body?: string;
  level?: "note" | "tip" | "warning" | "caution";
  source?: string;
  actions?: RawLink[];
  items?: (RawLink & { title?: string; summary?: string })[];
  component?: string;
  label?: string;
  placeholder?: string;
  submitLabel?: string;
  flavour?: string;
  fixedFacets?: Record<string, string | string[]>;
  /** dataset-tree only: the project-owned catalogue path, relative to the landing file. */
  catalog?: string;
  /** dataset-tree only: browse an S3-compatible gateway live instead of embedding a catalogue. */
  s3?: RawDatasetTreeS3;
  /** dataset-tree only, with `s3`: a dataset-tree-search-index-v1 file, relative to the landing. */
  searchIndex?: string;
  /** dataset-tree only, with `searchIndex`: results drawn before the rest are counted. */
  searchResultLimit?: number;
  /** dataset-tree only: node identifiers expanded as soon as they appear. */
  expand?: string[];
  /** dataset-tree only: the footer pill's text. */
  statusLabel?: string;
  /** dataset-tree only: the optional in-page Python playground. */
  python?: RawDatasetTreePython;
  /** notebook only: which interface the block shows. */
  view?: "lab" | "files";
  /** notebook only: the name on the window's bar. */
  title?: string;
  /** prose only: an illustration beside the text. */
  figure?: RawProseFigure;
}

/** A prose block's illustration: a still picture, and optionally a looping video. */
export interface RawProseFigure {
  image: string;
  imageDark?: string;
  /** One file, or the same clip in several formats. */
  video?: string | string[];
  videoDark?: string | string[];
  alt: string;
  caption?: string;
}

/** One bucket, or one prefix inside one, that a live tree may browse. */
export interface RawDatasetTreeS3Root {
  id?: string;
  name: string;
  bucket: string;
  prefix?: string;
  title?: string;
  description?: string;
  /**
   * A project or documentation page for this collection, drawn as a small external-link control
   * beside the title. Declared rather than derived from the bucket name, which would send a click
   * to a raw storage URL - a listing document, not a page for a person.
   */
  link?: { href: string; label?: string };
  /**
   * Announced, not yet browsable; the string is the badge's text. The row is drawn with no
   * chevron, no `aria-expanded` and no listing request, on expansion or on the availability
   * probe, so a deployment that knows a bucket is unpublished says so here instead of asking.
   */
  planned?: string;
}

/**
 * The `dataset-tree.s3` block, as written. The roots are declared: there is no discovery step and
 * no ListBuckets, since an S3 root legitimately answers 403 and a browser cannot enumerate an
 * account. A visitor can reach exactly what the deployment listed.
 */
export interface RawDatasetTreeS3 {
  endpoint: string;
  style?: "path" | "virtual-host";
  roots: RawDatasetTreeS3Root[];
  maxKeys?: number;
  maxPages?: number;
  requestTimeoutMs?: number;
  retries?: number;
  datasetSuffixes?: string[];
}

/** `pythonPlayground.notebook.assistant.climateclaw`, as written. */
export interface RawClimateClaw {
  host: string;
  authBaseUrl?: string;
  expectedIssuer?: string;
  defaultModel: string;
  runAndFixModel?: string;
  scopeNote?: string;
  examples?: { title: string; prompt: string }[];
  previewOrigin?: string;
  hideCodeByDefault?: boolean;
}

/** `pythonPlayground.notebook.dataPanel`, as written. */
export interface RawNotebookDataPanel {
  title?: string;
  icon?: string;
  /** A dataset-tree block's instance id, `<landing id>-<block index>`. */
  tree: string;
  defaultAction?:
    | "open-in-notebook"
    | "insert"
    | "inspect"
    | "ask-climateclaw"
    | "copy-url"
    | "copy-code";
  seedNotebooks?: string[];
  /**
   * A notebook opened when the Lab starts (the visitor's own copy, made once), in place of the
   * Launcher: published like a seed notebook, its saved outputs shown as they are.
   */
  startNotebook?: string;
  /** GridLook's 3D globe for stores readable without a token. Default false. */
  gridlook?: boolean;
  launcher?: { newNotebook?: boolean; browse?: boolean; examples?: boolean; ask?: boolean };
}

/**
 * The `dataset-tree.python` block, as written. Absent, or `enabled: false`, compiles the whole
 * feature out: no run control, no interpreter chunk, no Worker, no frame, no widening of the
 * page's CSP. The schema is the authority on what is accepted; this is what the resolver reads.
 */
export interface RawPythonPlaygroundBase {
  enabled: boolean;
  /**
   * A `@freva-org/browser-python` profile name, deliberately singular. The profiles are a chain -
   * `minimal` ⊂ `xarray-zarr` ⊂ `freva-client` - so a list would only be a longer way of naming
   * the last one, and a composed environment would be untested as a whole. `freva-client` already
   * carries xarray, Zarr and fsspec; there is no "xarray plus Freva" to ask for.
   */
  profile?: string;
  autostart?: "never" | "after-interactive" | "immediately";
  maxSessions?: number;
  initialSource?: string;
  playgroundOrigin?: string;
  /** With `playgroundOrigin`: the console stays in the portal's pages, the notebook goes there. */
  consoleInPage?: boolean;
  /** A self-hosted Pyodide directory, instead of the pinned CDN. Ends with a slash. */
  runtimeIndexUrl?: string;
  /** Where the derived Freva wheel is served from, for `freva-client`. Ends with a slash. */
  wheelhouseUrl?: string;
  /** Where the curated add-ons' pinned artefacts are served from. Ends with a slash. */
  addonBaseUrl?: string;
  /**
   * Curated add-ons: a closed set of prepared capabilities, not package names. A profile is which
   * interpreter you get; an add-on is an extra capability prepared for it. No URL, distribution
   * name or install script is accepted, and no add-on is inferred from a snippet's imports.
   */
  addons?: string[];
  /**
   * The subset of `addons` whose absence must not stop the interpreter. A separate list rather
   * than a flag on an entry, so `addons` stays strictly required; making it best-effort would
   * silently downgrade every portal depending on it.
   */
  optionalAddons?: string[];
  /**
   * Exactly the origins the interpreter may reach beyond the portal's own: exact HTTPS origins,
   * no wildcards, no paths, never derived from content. A snippet that mentions a host does not
   * thereby get permission to reach it.
   */
  connectOrigins?: string[];
  /**
   * How much of the network the visitor's Python may reach.
   *
   * `"origins"` (the default) is the exact allowlist above and nothing else: the runtime, the
   * prepared artefacts, and whatever `connectOrigins` names. A public package index is refused
   * wherever it is configured, so `micropip.install("name")` does not work and is not offered.
   *
   * `"https"` adds the `https:` scheme to `connect-src` - any TLS origin, never plaintext - which
   * makes an experimental session possible: `micropip.install("name")` against the public index, a
   * pasted wheel URL, a CORS-enabled dataset nobody listed at deployment time. The prepared
   * environment is unchanged and still the starting point, but stops being a ceiling; unsupported
   * packages may fail, and `Restart session` is the way back. It exposes
   * `@freva-org/browser-python`'s own `network` setting in `CspOptions`, not a second policy
   * system. An installed package runs in the same interpreter as the rest of the session, so a
   * deployment that persists credentials on the portal's own origin should weigh both settings
   * together; the resolver warns about the second one.
   */
  network?: "origins" | "https";
  /** Keep a Freva refresh token across reloads. Off by default; see the resolver for why. */
  persistCredentials?: boolean;
  /**
   * When a runnable snippet's Copy and Try in Python controls show. `always` (the default) or
   * `hover`. Presentation only: not part of the interpreter's identity.
   */
  controls?: "always" | "hover";
  /** Every runnable snippet editable in place. Off by default; see `editable` on a fence. */
  editableSnippets?: boolean;
  /** Per-session setup choices. Absent, every session gets the configured setup; see the schema. */
  sessionChoices?: {
    profiles: Record<string, { allowedAddons?: string[] }>;
    allowSkipStarter?: boolean;
    starterProfiles?: string[];
  };
  /** The JupyterLite notebook on `playgroundOrigin`. */
  notebook?: {
    enabled: boolean;
    seeds?: string[];
    /** ClimateClaw in the notebook, through jupyterlite-ai. */
    assistant?: { climateclaw: RawClimateClaw };
    /** A dataset-tree block as a side panel in the notebook. */
    dataPanel?: RawNotebookDataPanel;
  };
  resources?: { maxLiveSessions?: number };
  terminal?: {
    style?: "freva-client-terminal";
    osControls?: "auto" | "mac" | "windows" | "linux";
    alwaysOnTop?: boolean;
    rememberAppearance?: boolean;
  };
}

/**
 * The `dataset-tree.python` block, as written: a strict subset of the portal-level stanza, kept
 * as its own type. A tree block does not accept add-ons, a wheelhouse or an origin allowlist;
 * allowing them would configure a page's one playground from two levels at once.
 */
export type RawDatasetTreePython = Omit<
  RawPythonPlaygroundBase,
  | "addons"
  | "optionalAddons"
  | "connectOrigins"
  | "persistCredentials"
  | "wheelhouseUrl"
  | "addonBaseUrl"
  | "sessionChoices"
  | "notebook"
  | "resources"
>;

/**
 * The portal-level `pythonPlayground` stanza, as written. Enabling it does not turn Python on for
 * an existing dataset tree, nor put an interpreter on any page: a marked snippet or a
 * Python-enabled tree is what gives a page a playground, and a portal that marks nothing ships no
 * runtime at all.
 */
export type RawPythonPlayground = RawPythonPlaygroundBase;

export interface LandingDocument {
  schemaVersion: 1;
  title: string;
  description?: string;
  layout?: { sections?: RawLandingSection[] };
  blocks: RawLandingBlock[];
}

export interface SubsitePolicyDocument {
  schemaVersion: 1;
  profile: "static-docs-v1";
  entryPoints: string[];
  runtime: { connectOrigins: string[]; frameOrigins: string[]; workers: "none" | "self" };
}
