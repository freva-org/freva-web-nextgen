/**
 * The parsed shape of `portal.yaml`, exactly as the published schema accepts it. These types
 * describe *input*; the rest of the builder consumes `ResolvedPortalModel`, and the one-way trip
 * between them is where validation, containment and defaulting happen.
 */

export interface RawLink {
  label: string;
  landing?: string;
  component?: string;
  href?: string;
  description?: string;
}

export interface RawContentSource {
  root: string;
  mount: string;
  files?: { include?: string[]; exclude?: string[] };
}

export interface RawMountRoot {
  root: string;
  mount: string;
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
    header?: { enabled: boolean; links?: RawLink[]; prose?: string };
    footer?: {
      enabled: boolean;
      groups?: { title: string; links: RawLink[] }[];
      legalLinks?: RawLink[];
      prose?: string;
      badge?: { enabled?: boolean; kind?: "freva"; quality?: "auto" | "standard" };
    };
  };
  theme?: { preset: string; tokens?: Record<string, string> };
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
  navigation?: { header?: RawLink[]; footer?: RawLink[] };
  announcements?: RawAnnouncement[];
  trustedSubsites?: RawTrustedSubsite[];
  pythonPlayground?: RawPythonPlayground;
}

export interface RawLandingBlock {
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
  /** dataset-tree only: node identifiers expanded as soon as they appear. */
  expand?: string[];
  /** dataset-tree only: the footer pill's text. */
  statusLabel?: string;
  /** dataset-tree only: the optional in-page Python playground. */
  python?: RawDatasetTreePython;
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
  blocks: RawLandingBlock[];
}

export interface SubsitePolicyDocument {
  schemaVersion: 1;
  profile: "static-docs-v1";
  entryPoints: string[];
  runtime: { connectOrigins: string[]; frameOrigins: string[]; workers: "none" | "self" };
}
