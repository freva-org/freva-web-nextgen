/**
 * `ResolvedPortalModel` - the seam between "where the inputs came from" and "what the site is".
 * Everything above this type has finished validating; everything below it (layouts, blocks, the
 * Astro pages) reads a plain frozen value and never touches YAML, the filesystem or a network.
 *
 * Internal, serializable so tests can assert on it, and frozen so a later stage cannot quietly
 * "fix" an input that validation accepted.
 */

import type { OutlineHeading, OutlineSection } from "./nav-outline.js";
import type { PackagePolicy } from "./package-policy.js";

export type ComponentKind = "databrowser" | "stac-browser" | "auth";
export type ServiceKind = "databrowser" | "stac" | "auth";
export type AuthenticationMode = "none" | "optional" | "required";
export type CacheClass = "immutable" | "revalidate" | "download" | "subsite" | "no-store";

export interface ResolvedIdentityAsset {
  /** Public URL path within the artifact, base path included. */
  url: string;
  /** Artifact-relative output file. */
  file: string;
  mimeType: string;
  /** Source-root-relative input path, for the input manifest. */
  source: string;
  /** Inline sanitized SVG markup, when the asset is an SVG the shell inlines. */
  inlineSvg?: string;
}

export interface ResolvedSite {
  id: string;
  title: string;
  subtitle?: string;
  language: string;
  canonicalUrl: string;
  /** The pathname of `canonicalUrl`. The one and only base path. */
  basePath: string;
  origin: string;
  identity: { logo: ResolvedIdentityAsset; favicon: ResolvedIdentityAsset };
  institution?: { name: string; url?: string };
}

export interface ResolvedThemeTokens {
  [token: string]: string;
}

export interface ResolvedTheme {
  preset: string;
  tokens: ResolvedThemeTokens;
  /** The preset's CSS, already resolved with the consumer's token overrides. */
  css: string;
  /**
   * A drawn backdrop the preset asks for. Present only on presets that declare it; every other
   * preset leaves it undefined, which keeps the runtime out of their bundles.
   */
  backdrop?: "contour" | "cosmos";
  /**
   * Where a backdrop's own object bodies were published, with a trailing slash. Present only for
   * a backdrop that has any - today only `cosmos`. The island cannot work this out: the directory
   * is named for the digest of the published set, which only the build knows.
   */
  sceneAssetBase?: string;
}

export interface ResolvedLink {
  label: string;
  href: string;
  external: boolean;
  description?: string;
  /** Set when the link resolved to a component instance, for evidence. */
  componentId?: string;
  landingId?: string;
}

export interface ResolvedChrome {
  header: { enabled: boolean; links: ResolvedLink[]; prose?: RenderedFragment };
  footer: {
    enabled: boolean;
    groups: { title: string; links: ResolvedLink[] }[];
    legalLinks: ResolvedLink[];
    prose?: RenderedFragment;
    /**
     * The footer badge, when the configuration asked for one. Absent is the load-bearing case: no
     * badge in the model means no markup in the footer, no island in the entry module, no
     * stylesheet, and not one of its assets copied into the artifact.
     */
    badge?: ResolvedFooterBadge;
  };
}

/** The footer badge as the templates and the island see it. */
export interface ResolvedFooterBadge {
  kind: "freva";
  /** `standard` pins the 1x motion set; `auto` lets the badge choose. */
  quality: "auto" | "standard";
  /** Public URL of the badge stylesheet, base path included. */
  styleUrl: string;
  /** Public URL of the directory holding `assets/`, with its trailing slash. */
  assetBase: string;
}

export interface ResolvedService {
  id: string;
  kind: ServiceKind;
  /** The complete, normalized public URL for this kind. */
  url: string;
  /** Origin used for the bearer-resource allowlist; empty for same-origin. */
  origin: string;
  authentication: AuthenticationMode;
}

export interface DatabrowserOptions {
  defaultFlavour: string;
  fixedFacets: Record<string, string | string[]>;
  /**
   * Which view a visitor lands on. A default, not a lock - the Browse/Overview control is still
   * there, and a visitor's own choice is remembered over this on their next visit.
   */
  defaultLayout: "browse" | "overview";
  /**
   * How the metadata overview is composed. `order` names block keys in the order they appear;
   * unlisted keys keep their natural position *after* the listed ones, so naming three is a
   * statement about those three rather than a hiding of everything else. `mainFacets` names the
   * main blocks - everything else moves under "Show additional facets", moved rather than hidden -
   * and `null` means the server's own `primary_facets`. `__time` and `__bbox` are valid keys in
   * both: the two blocks that are not facets are ordered in the same flow as the facets, so a
   * deployment that wants the map first can say so.
   */
  overview: { order: string[]; mainFacets: string[] | null };
  /**
   * Whether a visitor may take off a value that came from `fixedFacets`. Default false: the scope
   * renders locked and survives "Clear all". True makes it a starting point rather than a boundary.
   * Neither setting is an authorization boundary - the scope is applied in the browser.
   */
  scopeRemovable: boolean;
}

export interface StacChromeLink {
  label: string;
  href: string;
}

export interface StacProvider {
  name: string;
  url?: string;
  roles?: string[];
  /**
   * A published URL for the provider's mark, resolved from a local path at build time. Not part
   * of STAC - the specification has no provider logo - so it is the portal's own field, projected
   * onto the root document's provider entries and drawn by the patched `Providers` view.
   */
  logo?: string;
}

/**
 * What this portal displays for the root catalogue. Presentation only, and only for the root:
 * none of it modifies the remote STAC API or reaches a collection, item or child catalogue.
 * `title` and `description` fall back to what the API returned, so a deployment states them only
 * to override.
 */
export interface StacRootPage {
  title?: string;
  description?: string;
  introHtml?: string;
  keywords?: string[];
  license?: string;
  providers?: StacProvider[];
}

export interface StacOptions {
  chrome: { title?: string; imageUrl?: string; footerLinks: StacChromeLink[] };
  access: {
    externalCatalogs: "deny";
    /**
     * Origins the deployment permits basemap tiles to be fetched from, normalized to origins.
     * Empty by default, and empty means no third-party request at all. The same list reaches the
     * mounted application through the generated adapter and the artifact's `img-src` through the
     * host policy, so map and policy cannot disagree about which tiles may be drawn.
     */
    basemapOrigins: string[];
  };
  rootPage: StacRootPage;
  linkPolicy: {
    canonicalizeAdvertisedRoot: boolean;
    hiddenRelations: string[];
    /** Absolute URLs the deployment declares to be the same catalogue as `catalogUrl`. */
    rootAliases: string[];
  };
  /** Adapter-owned, never consumer-configurable (FP-001 AR-006). */
  historyMode: "hash";
  pathPrefix: string;
  catalogUrl: string;
}

export interface AuthOptions {
  callbackPath: string;
  /** Derived from `site.canonicalUrl` + `callbackPath`; never independently configured. */
  redirectUri: string;
  expectedIssuer?: string;
  /** Derived minimum allowlist plus the explicitly declared origins. */
  bearerResourceOrigins: string[];
  additionalResourceOrigins: string[];
}

export interface ResolvedComponent {
  id: string;
  kind: ComponentKind;
  enabled: boolean;
  serviceId?: string;
  /** User-facing route, when the component has one. */
  route?: string;
  title: string;
  description: string;
  options: DatabrowserOptions | StacOptions | AuthOptions | Record<string, never>;
}

/** One page in a derived section navigation. */
export interface ResolvedSectionNavigationItem {
  /** The page's resolved human-facing title. */
  title: string;
  /** The page's resolved public URL, base-path aware. */
  href: string;
  /**
   * Source-root-relative source path: what a template compares against `route.source` to find the
   * current page. Matching on the source makes it an identity check on a file, not a comparison
   * of two URLs that a base path, trailing slash or percent-encoding could make differ while
   * naming the same page.
   */
  source: string;
}

/**
 * The pages of one source directory, in reading order. Derived, never configured: the file tree
 * is the authority for membership, and a consumer never restates their content structure in
 * `portal.yaml`. It carries no mark for the current page - one frozen object is shared by every
 * route in the section, and a `current` flag would fork it into one copy per page - so the
 * template compares each item's `source` with the route's own.
 */
export interface ResolvedSectionNavigation {
  /** The section's visible label. */
  title: string;
  /**
   * Source-root-relative directory the section was derived from, e.g. `content/storage-concepts`.
   * Never absolute: this is serialized into the artifact, where a build-machine path has no
   * business. It is also the section's identity, so two content sources with the same relative
   * directory name never share one.
   */
  sourceDirectory: string;
  items: readonly ResolvedSectionNavigationItem[];
}

export interface HeadingRef {
  depth: number;
  id: string;
  text: string;
}

export interface RenderedFragment {
  /** Sanitized, serialized HTML. */
  html: string;
  headings: HeadingRef[];
  /** Source-root-relative path of the source that produced it. */
  source: string;
  title?: string;
  description?: string;
  toc: boolean;
  /**
   * The runnable snippets this fragment registered, in document order. Absent - not empty - when
   * the portal has no playground, so "nothing runnable here" and "a playground this page uses
   * none of" stay different facts.
   */
  runnable?: RegisteredContentExample[];
}

/**
 * One build-approved snippet: what runs, under what name, if a visitor presses the button. The
 * source is here because the build is what approves it; what ships to the page is the id and the
 * digest. The source is either already in the document (in the copy control) or in the
 * separate-origin child's manifest - neither a place a press can put arbitrary text.
 */
export interface RegisteredContentExample {
  /** `content:<escaped source path>#<code-block occurrence>`. Deterministic, and injective. */
  id: string;
  /** Lowercase SHA-256 over the exact UTF-8 source, as the author wrote it. */
  sha256: string;
  /** The author's `title="…"`, or a deterministic readable fallback. For the terminal's divider. */
  title: string;
  /** The exact source. Never sent to the page in a same-origin build. */
  source: string;
}

export type BlockKind =
  | "hero"
  | "prose"
  | "cards"
  | "links"
  | "callout"
  | "component-link"
  | "component-search"
  | "dataset-tree";

/**
 * One bucket or prefix a live tree may browse, exactly as the deployment declared it and carried
 * to the page verbatim. There is no discovery step: an S3 root legitimately answers 403, and a
 * portal does not get to ask a browser to enumerate an account.
 */
export interface DatasetTreeS3Root {
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
 * A live S3 source, resolved. The endpoint is normalised and its origin is what reaches
 * `connect-src`; nothing else about the artifact's policy changes. The rest are bounds the
 * adapter already honours - pages, timeout, retries - carried so a deployment can tune them.
 */
export interface DatasetTreeS3Source {
  endpoint: string;
  /** `new URL(endpoint).origin`, for the recorded policy. Derived once, here. */
  origin: string;
  style: "path" | "virtual-host";
  roots: DatasetTreeS3Root[];
  maxKeys?: number;
  maxPages?: number;
  requestTimeoutMs?: number;
  retries?: number;
  datasetSuffixes?: string[];
}

export interface DatasetTreeBlockData {
  /** Stable per-block DOM id: `<landing>-<block index>`, never derived from render order. */
  instanceId: string;
  /**
   * Which source this block has, and the only thing deciding what the island loads. `snapshot` is
   * a build-time catalogue embedded in the page: no request at load, no dependency on a service.
   * `s3` lists one prefix when a row is expanded, which is how an archive too large to walk at
   * build time is browsed at all. Exactly one, checked at resolve time.
   */
  mode: "snapshot" | "s3";
  /**
   * The validated catalogue, re-serialised canonically and escaped for a `<script>` data block.
   * Escaped here, not in the page template: the published package ships `dist/` and not `src/`,
   * so an Astro template may import a *type* from the model and nothing else - a value import
   * resolves in this checkout and fails in every consumer's build - and the rule then has exactly
   * one copy, tested where it lives. Still valid JSON: an escaped `<` is a `<`.
   */
  catalogScriptJson: string;
  /** The live source's configuration, when `mode` is `s3`. */
  s3?: DatasetTreeS3Source;
  /** Source-root-relative path of the catalogue file, for the manifest and for messages. */
  source: string;
  /** Total nodes, at every depth. Worth knowing in a review; NOT shown to a visitor. */
  nodeCount: number;
  rootCount: number;
  /** Identifiers expanded on load, already checked against the catalogue. */
  expandedIds: string[];
  statusLabel: string;
  /**
   * The catalogue's own `generatedAt`, formatted for the footer, or `undefined` when it states
   * none - then the footer shows the pill alone. No fallback to the build time: a snapshot's age
   * is a claim about the *archive*, and the moment the site was compiled would look like an
   * answer to it without being one.
   */
  generatedAt?: string;
  /** The catalogue's own `source`, e.g. an endpoint. Rendered as text, never as a link. */
  sourceLabel?: string;
  /**
   * The Python playground, when this block asked for one. Undefined is the whole of "disabled":
   * the projection does not name the feature, the generated entry does not import it, and no
   * chunk of it reaches the bundle.
   */
  python?: PythonPlaygroundData;
  /**
   * The same examples with their source, for the separate-origin child artifact. Present only
   * when the block declared a `playgroundOrigin`, the only thing that reads them: a same-origin
   * playground takes its source from the catalogue already on the page. Never rendered into a
   * page - see `PlaygroundArtifactExample`.
   */
  playgroundExamples?: PlaygroundArtifactExample[];
}

/**
 * The least a run request needs: a name, and the digest the build approved it under.
 *
 * The source is not here: it is already in the page - the catalogue carries it - so repeating it
 * would put a second copy of every snippet in the document. What the build adds is the one thing
 * a page cannot compute without trusting what it is hashing: the digest of the bytes the build
 * read. Kept wider than {@link RegisteredExampleDigest} because a snippet in a Markdown file has
 * no dataset and no catalogue node, and empty strings for those would be two lies per example.
 */
export interface PlaygroundExampleDigest {
  id: string;
  /** Lowercase hex SHA-256 of the example's source, exactly as embedded. */
  sha256: string;
  /**
   * What the terminal prints on the divider before the source. Present for a snippet in a
   * document, whose title the page cannot derive: a dataset-tree example is named by the
   * catalogue the page already reads, a documentation snippet has no such catalogue. A label
   * only, never given to the interpreter.
   */
  title?: string;
}

export interface RegisteredExampleDigest extends PlaygroundExampleDigest {
  /**
   * The node the example belongs to, unescaped, as the catalogue wrote it. It is one segment of
   * the run request's name, `<block instance>/<node id>/<example id>`, each segment
   * percent-escaped - which has to be injective across a whole page, since node ids are unique
   * within a catalogue and a page may carry two.
   */
  datasetId: string;
  /**
   * The example's own id within that node, unescaped. Carried so the island can find this entry
   * from the catalogue it already reads, without re-implementing the composition - which would be
   * two places to get the escaping right.
   */
  exampleId: string;
}

/**
 * The resolved playground configuration a page's providers all agree on. Split out from
 * {@link PythonPlaygroundData} because it is the part that has to match: a page has one
 * interpreter, and the examples are the only thing two providers may legitimately differ in.
 */
export interface PlaygroundSettings {
  /** browser-python profile name, passed through verbatim. Singular - see the raw type. */
  profile: string;
  autostart: "never" | "after-interactive" | "immediately";
  /** 1 or 2. Two is the ceiling: each session is a Worker with its own WASM heap. */
  maxSessions: number;
  /**
   * The subset of {@link PlaygroundSettings.addons} whose absence must not stop the interpreter.
   * Sorted and validated: every entry is in `addons` and is one the interpreter can drop without
   * leaving a half-changed session. Empty when nothing was asked to be optional.
   */
  optionalAddons: string[];
  /**
   * Curated add-ons, validated against the catalogue and sorted. Sorted so two configurations
   * naming the same add-ons in different orders produce the same artifact, and so the agreement
   * check compares a value rather than an ordering.
   */
  addons: string[];
  /** Where the Freva wheels are served from, when the deployment hosts them itself. */
  wheelhouseUrl?: string;
  /** Where the add-ons' pinned artefacts are served from, when not beside the runtime. */
  addonBaseUrl?: string;
  /**
   * Exactly the origins the interpreter may reach, normalised and sorted. Never inferred: nothing
   * reads Python source to decide what the page may connect to.
   */
  connectOrigins: string[];
  /** Whether a Freva refresh token survives a reload. False unless the deployment asked. */
  persistCredentials: boolean;
  /**
   * How much of the network the visitor's Python may reach. `"origins"` unless configured, and
   * exactly what the deployment wrote: `packagePolicy` below is the consequence of it, and the
   * emitted `connect-src` is written from the pair.
   */
  network: "origins" | "https";
  /**
   * Where packages may come from - derived, never authored. The same value writes the page's
   * `connect-src` and the terminal's package help, because two texts describing one deployment
   * drift: a help panel offering `micropip.install("name")` beside a policy naming no package
   * index documents a capability the portal forbids. See `resolvePackagePolicy`.
   */
  packagePolicy: PackagePolicy;
  /** Python run once into a new session. Portal-owned configuration, not visitor input. */
  initialSource?: string;
  /**
   * The origin the interpreter is served from, when the deployment gives it one. Undefined means
   * the interpreter runs on the portal's own origin, which is convenient and is also the
   * arrangement in which visitor Python holds the portal's origin authority.
   */
  playgroundOrigin?: string;
  /**
   * Where the interpreter's runtime is fetched from, when the deployment hosts its own. Undefined
   * means the pinned CDN `@freva-org/browser-python` uses by default. A deployment whose network
   * does not reach a CDN - or will not depend on one - mirrors the pinned release and points this
   * at it; the recorded policy then names that origin instead.
   */
  runtimeIndexUrl?: string;
  terminal: {
    osControls: "auto" | "mac" | "windows" | "linux";
    alwaysOnTop: boolean;
    rememberAppearance: boolean;
  };
}

/** A page's playground: the settings everything agreed on, plus what this provider registered. */
export interface PythonPlaygroundData extends PlaygroundSettings {
  /**
   * Every runnable example in this block's catalogue, with the digest the build computed. Sorted
   * by id, so the artifact is byte-identical for one input whatever order the walk found them in.
   * Empty means Python is enabled and the catalogue offers nothing to run - legitimate, not an
   * error: the window still exists for the prompt.
   */
  examples: PlaygroundExampleDigest[];
  /**
   * Recipe ids the configured profile can execute, for a live block. Every recipe is drawn
   * whatever the profile - it is documentation, and copyable - and this is the subset that also
   * gets a run control, because the packages it imports are actually loaded.
   */
  recipes?: string[];
  /** `recipe id -> sha256 of its template`. The digest identifies the recipe, not a rendered snippet. */
  recipeDigests?: Record<string, string>;
  /**
   * The archive a recipe's store parameter must belong to, carried into the page so the runner
   * can check it and not merely the tree. What arrives on a press is a store identifier the
   * source produced; before it reaches a template's hole it must name one of these buckets, under
   * that bucket's declared prefix, in a character set that cannot end a Python string literal.
   * The endpoint is the configured one and never taken from the value.
   */
  store?: {
    endpoint: string;
    style: "path" | "virtual-host";
    roots: { bucket: string; prefix?: string }[];
  };
}

/**
 * One registered example as the *child* artifact needs it: the source included. The parent page
 * never carries this shape - a portal page gets `RegisteredExampleDigest`, an id and a digest,
 * because the point of the two-origin arrangement is that the parent asks for a snippet by name
 * and can never describe one. The source lives in exactly two places: the catalogue the tree
 * renders, and this manifest, deployed to the playground's own origin and read only there.
 */
export interface PlaygroundArtifactExample {
  /** The page-global identity, composed the same way as the parent's. */
  id: string;
  /**
   * The catalogue node the example belongs to. Carried, never interpreted, and absent for a
   * snippet in a document, which belongs to no dataset: `""` in a manifest reads as an answer.
   */
  datasetId?: string;
  /** What the console prints on the divider before the source. */
  title: string;
  /** The Python itself. */
  source: string;
  /** Lowercase hex SHA-256 of `source`, byte for byte as embedded. */
  sha256: string;
}

/**
 * The deployable separate-origin playground, as the build resolved it. Present only when a
 * landing's `dataset-tree.python` declared a `playgroundOrigin`. It is what the child document is
 * generated from, and deliberately a whole description rather than a pointer: the artifact
 * deployed to the other origin has to stand alone, because at run time all it ever receives from
 * the portal is an id and a digest.
 */
export interface PlaygroundArtifactData {
  /** The origin the child is deployed at, exactly as configured. */
  origin: string;
  /** The portal's own origin, from `site.canonicalUrl`. The only peer the bridge will answer. */
  hostOrigin: string;
  /** browser-python profile name, passed through verbatim. */
  profile: string;
  /** Python run once into every new interpreter here, mirroring the local session's rule. */
  initialSource?: string;
  /** The embed protocol version this build speaks. A mismatch is refused at the handshake. */
  protocolVersion: number;
  /** Where the interpreter's runtime is fetched from, so the child's CSP can name it. */
  runtimeIndexUrl: string;
  /**
   * Origins the registered examples themselves fetch from, so the child's CSP can name them.
   *
   * A recipe for a live store is a program that opens that store, so the interpreter - running on
   * the child origin under `default-src 'none'` - reaches the storage gateway the tree is
   * configured against. Without this the child loads, the button is enabled, the run starts, and
   * the fetch is refused by a policy the reader cannot see. Origins only, and only ones this build
   * already reaches from the parent page, so nothing here widens the child beyond the portal.
   */
  dataOrigins?: string[];
  /** Where the Freva wheels are served from, when the deployment hosts them itself. */
  wheelhouseUrl?: string;
  /** Where the add-ons' pinned artefacts are served from, when not beside the runtime. */
  addonBaseUrl?: string;
  /**
   * The curated add-ons the child must prepare, sorted. The *child's*, because the child builds
   * the interpreter: in a framed deployment the parent never has one, so this is the only place
   * the answer can live and still be the answer.
   */
  addons?: string[];
  /** Whether the child keeps a Freva refresh token across reloads. Absent means no. */
  persistCredentials?: boolean;
  /** Exactly the origins the child's interpreter may reach, beyond its own and the runtime's. */
  connectOrigins?: string[];
  /**
   * The resolved package policy's origins, so the child's own policy is written from the same
   * value. Origins rather than the whole policy object: the child's document does not render the
   * package help - the parent's terminal does - and a manifest carries what its reader uses.
   */
  packageOrigins?: string[];
  /**
   * Whether the child may reach any TLS origin, as the parent's package policy resolved it.
   * Carried rather than re-decided: the parent's `connect-src`, the child's `connect-src` and the
   * terminal's package help are three statements about one deployment, kept consistent by all
   * three being written from the one resolved policy.
   */
  anyHttpsOrigin?: boolean;
  /** Every runnable example on the portal, merged across blocks and sorted by id. */
  examples: PlaygroundArtifactExample[];
}

export interface ResolvedBlock {
  type: BlockKind;
  heading?: string;
  summary?: string;
  body?: string;
  level?: "note" | "tip" | "warning" | "caution";
  actions?: ResolvedLink[];
  cards?: { title: string; summary?: string; link?: ResolvedLink }[];
  prose?: RenderedFragment;
  /** component-search only. */
  search?: {
    componentId: string;
    action: string;
    placeholder: string;
    submitLabel: string;
    intent: SearchIntentV1;
  };
  link?: ResolvedLink;
  /** dataset-tree only. The catalogue is carried, not referenced: the page embeds it. */
  datasetTree?: DatasetTreeBlockData;
}

/**
 * The versioned landing-to-Data-Browser handoff (FP-001 AR-010). It travels in the URL, so a
 * search survives reload, bookmark and share, and it is read by a typed initializer in the Data
 * Browser package rather than by a DOM selector.
 */
export interface SearchIntentV1 {
  v: 1;
  q?: string;
  flavour?: string;
  facets?: Record<string, string[]>;
}

export interface ResolvedLanding {
  id: string;
  path: string;
  title: string;
  description?: string;
  blocks: ResolvedBlock[];
  source: string;
}

export type RouteKind = "landing" | "content" | "component" | "auth-callback" | "error";

export interface ResolvedRoute {
  /** Site-logical path with a trailing slash, e.g. `/docs/guide/`. */
  path: string;
  /** Artifact-relative output file, e.g. `docs/guide/index.html`. */
  file: string;
  /** Absolute public URL. */
  url: string;
  kind: RouteKind;
  title: string;
  description?: string;
  /** The HTTP status this document is served for. Only on `kind: "error"`. */
  status?: number;
  /**
   * The specification's own name for that status, e.g. `Service Unavailable`. Carried on the
   * route rather than looked up in the template: the published package ships `dist/`, not `src/`,
   * so a page template may read the model and nothing else. `[...route].astro` gets away with
   * importing from `src/` because it imports a *type*, which the compiler erases.
   */
  reason?: string;
  /** Whether the visitor's own next action can plausibly fix this status. */
  retry?: boolean;
  landingId?: string;
  componentId?: string;
  /**
   * This page's Python playground, when the page has something runnable on it. On the *route*
   * rather than on the portal, because that is the granularity the guarantee needs: a portal may
   * enable the capability, have three documentation pages using it and forty that do not, and the
   * forty must carry no configuration, no provider and nothing that fetches an interpreter.
   */
  python?: PythonPlaygroundData;
  /** The runnable snippets this page registered, with their sources, for a framed manifest. */
  runnable?: RegisteredContentExample[];
  content?: RenderedFragment;
  /** Source-root-relative source, for content routes. */
  source?: string;
  toc?: HeadingRef[];
  /**
   * The same headings, nested one level, for the rail and the outline dropdown. Nested here
   * rather than in the page template for the reason `reason` above gives: a template may import a
   * *type* from this model and nothing else, so a call to `nestHeadings` in an `.astro` file
   * builds here and fails in a consumer's. Present only on content routes with two headings or
   * more.
   */
  tocTree?: OutlineHeading[];
  /**
   * The other pages of this page's own source directory, when there are any. Only on
   * `kind: "content"` routes, and only when the directory publishes at least two pages - a
   * section of one is a list whose single entry is the page you are already reading.
   */
  sectionNavigation?: ResolvedSectionNavigation;
}

export interface ResolvedStaticFile {
  /** Artifact-relative output path. */
  file: string;
  /** Public URL including the base path. */
  url: string;
  source: string;
  mimeType: string;
  bytes: number;
  digest: string;
  cacheClass: CacheClass;
  kind: "asset" | "download" | "identity" | "subsite";
  contentDisposition?: string;
  /** Set when the published bytes are a sanitized derivative, not the input bytes. */
  sanitized?: boolean;
}

export interface ResolvedSubsite {
  mount: string;
  profile: "static-docs-v1";
  policy: {
    entryPoints: string[];
    runtime: { connectOrigins: string[]; frameOrigins: string[]; workers: "none" | "self" };
  };
  policySource: string;
  policyDigest: string;
  treeDigest: string;
  files: {
    file: string;
    url: string;
    source: string;
    mimeType: string;
    bytes: number;
    digest: string;
  }[];
  inlineScriptHashes: string[];
  inlineStyleHashes: string[];
  staticResources: string[];
}

export interface ResolvedAnnouncement {
  id: string;
  message: string;
  level: "info" | "warning" | "critical";
  dismissible: boolean;
}

export interface ComponentEvidencePlan {
  id: string;
  /**
   * What the plan is about: components, one landing block that owns shipped code of its own, and
   * that block's optional Python playground. Absence is the same question for all three, so they
   * share one mechanism. The playground is its own plan rather than more roots on the tree's,
   * because the two are enabled separately: a portal with a dataset-tree block and no `python`
   * stanza must be provable to contain no interpreter.
   */
  kind: ComponentKind | "dataset-tree" | "python-playground";
  enabled: boolean;
  ownedModuleRoots: string[];
  ownedStaticRoots: string[];
  /**
   * Emitted file names this feature owns that are *not* chunks in the module graph. A Worker
   * bundle is the case that needs it: the bundler emits it beside the graph rather than in it, so
   * a switched-off feature could leave one behind with no module-level check noticing, and a
   * switched-on one has no other way to be charged for it. Matched as a prefix of the emitted
   * file's own name, because the bundler appends a content hash.
   */
  ownedEmittedNames?: string[];
  assetNamespaces: string[];
  allowedSharedModules: string[];
  routes: string[];
  emittedServiceIds: string[];
}

export interface HostPolicyPlan {
  authCallbackPath?: string;
  downloadPrefixes: string[];
  subsiteMounts: string[];
}

export interface BuildIdentity {
  builderName: string;
  builderVersion: string;
  builderPurl: string;
  sourceDateEpoch: number;
  effectiveAt?: string;
  release: boolean;
  schemaDigests: Record<string, string>;
  profileDigest: string;
  profileName: string;
}

export interface InputRecord {
  path: string;
  role:
    | "config"
    | "landing"
    | "page"
    | "fragment"
    | "asset"
    | "download"
    | "identity"
    | "subsite-policy"
    | "subsite-file"
    | "component-asset";
  digest: string;
  bytes: number;
}

export interface ResolvedPortalModel {
  site: ResolvedSite;
  /**
   * The separate-origin playground artifact, when one was configured. Absent means the
   * interpreter runs on the portal's own origin and nothing about a child document is emitted at
   * all, which makes "this artifact contains no playground page" a checkable fact, not a claim.
   */
  playground?: PlaygroundArtifactData;
  theme: ResolvedTheme;
  chrome: ResolvedChrome;
  services: ResolvedService[];
  components: ResolvedComponent[];
  enabledComponents: ResolvedComponent[];
  componentEvidencePlan: ComponentEvidencePlan[];
  navigation: { header: ResolvedLink[]; footer: ResolvedLink[] };
  /**
   * Both navigation levels as one tree, for the narrow-width chrome. Derived here and not in the
   * template: an Astro template may import a *type* from this model and nothing else, since the
   * published package ships `dist/` and not `src/`, so a value import resolves in this checkout
   * and fails in every consumer's build. Nothing new is computed; see `deriveNavOutline`.
   */
  navOutline: OutlineSection[];
  landings: ResolvedLanding[];
  routes: ResolvedRoute[];
  embeddableAssets: ResolvedStaticFile[];
  passiveDownloads: ResolvedStaticFile[];
  identityFiles: ResolvedStaticFile[];
  trustedSubsiteMounts: ResolvedSubsite[];
  announcements: ResolvedAnnouncement[];
  hostPolicy: HostPolicyPlan;
  buildIdentity: BuildIdentity;
  inputs: InputRecord[];
  /** Every rendered fragment's dependency edges, for the unreferenced-file check. */
  referencedFiles: string[];
}

/** Immutable after validation. Frozen deeply, not by convention. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
