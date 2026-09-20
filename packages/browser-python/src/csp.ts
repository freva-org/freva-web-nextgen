/**
 * csp.ts - the Content-Security-Policy this package can actually run under.
 *
 * Exported as data rather than written in the README, because a policy in prose drifts and the
 * next person copies one that has been wrong for a year. `browser-tests/csp.mjs` serves the
 * fixture page under exactly this header and fails if anything the engine needs is blocked.
 * There is no `default-src *` here and there will not be: every directive below is the narrowest
 * value that works, and each one says what breaks without it.
 */

export interface CspOptions {
  /**
   * Where the Pyodide runtime and its wheels are served from, if not this origin. A self-hosted
   * runtime needs nothing here. A CDN needs its origin in `script-src` (the loader is a module
   * script) and in `connect-src` (the WASM, the stdlib and every wheel are fetched).
   *
   * LEAVING THIS OUT BLOCKS THE ENGINE'S OWN DEFAULT. `createBrowserPython()` loads
   * `DEFAULT_PYODIDE_INDEX_URL`, a jsDelivr URL, so the two defaults are deliberately incompatible:
   * this one is the safe policy and that one is the convenient runtime, and neither should quietly
   * become the other. Either name the CDN here - which also lets it serve scripts to the page - or
   * self-host the runtime and point the engine's `pyodide.indexURL` at your own origin.
   */
  runtimeOrigin?: string;
  /** Extra origins the visitor's Python may fetch from - a Zarr store, a Freva deployment. */
  dataOrigins?: readonly string[];
  /**
   * The page installs wheels from PyPI, so `connect-src` must name it.
   *
   * Adds `https://pypi.org` (the metadata API micropip resolves against) and
   * `https://files.pythonhosted.org` (the wheels themselves), and nothing else. OFF BY DEFAULT
   * and separate from `dataOrigins`, so a deployment that never installs a package keeps a
   * policy naming no package index at all.
   *
   * The `freva-client` profile NEEDS it: it installs one derived wheel with dependency
   * resolution enabled, and micropip fetches the ordinary dependencies from PyPI. A profile that
   * only loads the runtime's own locked packages does not, and should leave this off.
   */
  packageIndex?: boolean;
  /**
   * The page uses the bundled console component, not just the engine.
   *
   * Adds `style-src-attr 'unsafe-inline'`, and only that: jQuery Terminal builds its own markup
   * with `style="…"` attributes, and a policy without this blocks every one of them, leaving a
   * terminal whose columns do not line up. An explicit option rather than a default, so a host
   * embedding only the engine keeps the stricter policy. `style-src-attr` governs style
   * ATTRIBUTES only, and `style-src` stays `'self'`.
   */
  console?: boolean;
  /**
   * Add `'unsafe-inline'` to `style-src` itself. Needed only in a browser without constructable
   * stylesheets, where the component falls back to a `<style>` element in its shadow root. Every
   * current engine supports `adoptedStyleSheets`, which CSP does not govern, so leave this off.
   */
  allowInlineStyles?: boolean;
  /**
   * How much of the network the visitor's Python may reach.
   *
   * `"origins"` (the default) lists exactly what the deployment named in `connect-src`: the
   * runtime's origin and whatever `dataOrigins` says - right for a portal with known endpoints,
   * wrong for a science console whose purpose is opening datasets from wherever they live.
   * `"https"` adds the `https:` SCHEME and nothing else: any TLS origin may be fetched,
   * plaintext may not. Deliberately not `*`, which would also permit `ws:` and `data:`. Read
   * `README.md` on what this does not protect: CSP bounds where the PAGE may talk, not the
   * boundary between the visitor's Python and a credential in the same interpreter.
   */
  network?: "origins" | "https";
  /**
   * Who may frame this page. Defaults to `'none'`, because a console that runs visitor-authored
   * Python is a clickjacking target - but it is the host's decision, and a portal embedding the
   * console in its own shell should not have to hand-edit the header. Values are CSP source
   * expressions: `'self'`, `'none'`, or an origin, validated like every other origin here.
   */
  frameAncestors?: readonly string[];
  /**
   * Which origins this page may load in a frame. Defaults to none. `default-src 'none'` governs
   * `frame-src` by fallback, so a portal using this policy could not frame the playground it is
   * meant to - which is on a DIFFERENT origin by design. Naming that origin widens nothing else.
   * Each value is validated and serialised as an origin, exactly like `dataOrigins`.
   */
  frameSrc?: readonly string[];
}

/**
 * One origin, as CSP may safely be told about it. A header is a `;`-separated list of
 * directives, so a host-supplied string is not data until it has been proved to be an origin:
 * `URL` does the proving and `.origin` the serialising, discarding a path or query, and anything
 * containing a separator, a space or a scheme with no origin is refused HERE, at build time. A
 * wildcard host (`https://*.example.com`) survives, because it cannot widen anything beyond the
 * hosts it names.
 */
function originOf(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(
      `${field} must be an origin like "https://data.example"; received ${JSON.stringify(value)}. ` +
        "A Content-Security-Policy is a list of directives separated by semicolons, so an " +
        "unparsed value here would become one.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(
      `${field} must be an http(s) origin; ${JSON.stringify(value)} has no origin to grant.`,
    );
  }
  return url.origin;
}

/** A `frame-ancestors` source: a keyword this package accepts, or a validated origin. */
function frameAncestor(value: string): string {
  if (value === "'none'" || value === "'self'") return value;
  return originOf(value, "frameAncestors");
}

/**
 * The directives, with the reason each one is here. `wasm-unsafe-eval` has an unfortunate name:
 * it permits compiling and instantiating WebAssembly and NOTHING else - not `eval`, not
 * `new Function` - and without it there is no interpreter, Pyodide being a WebAssembly build of
 * CPython. `unsafe-eval` is NOT required and must not be added.
 */
export const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // Nothing loads from anywhere unless a directive below says so. The opposite of `default-src *`.
  "default-src": ["'none'"],
  // The page's own scripts, plus WebAssembly compilation - the interpreter itself.
  "script-src": ["'self'", "'wasm-unsafe-eval'"],
  // The module Worker. Same origin: a Worker built from a cross-origin URL is blocked by the
  // browser regardless of CSP, which is why the package resolves it relative to its own module.
  "worker-src": ["'self'"],
  // Fetching the runtime, the wheels, and whatever the visitor's Python reads.
  "connect-src": ["'self'"],
  // Matplotlib figures arrive as base64 PNG and are rendered from a data: URL; artifact previews
  // are rendered from a blob: URL. Neither is a network fetch and neither can be an origin.
  "img-src": ["'self'", "data:", "blob:"],
  // Audio and video previews of artifacts, from the same blob: URLs.
  "media-src": ["'self'", "blob:"],
  // The console's stylesheet. `'self'` alone is enough when the component can use
  // `adoptedStyleSheets`, which every current engine can: a constructable stylesheet is not a
  // style element and CSP does not govern it. The fallback path creates a `<style>` element in
  // the shadow root, which does need `'unsafe-inline'` - hence an option rather than a default.
  "style-src": ["'self'"],
  // No plugins, no framing, no form posts, no base-tag rewriting. None of it is used, and every
  // one of them is a way to smuggle a navigation out of a page that runs visitor-authored code.
  "object-src": ["'none'"],
  "frame-ancestors": ["'none'"],
  "form-action": ["'none'"],
  "base-uri": ["'none'"],
});

/**
 * Build a header value from the manifest. The additions are additive and per-directive; nothing
 * here can remove a restriction, so a host passing a data origin cannot widen `script-src`.
 */
/**
 * Where micropip resolves and downloads from: the metadata API, and the files behind it.
 *
 * EXPORTED because a host that builds its own header has to write the same two hosts. A
 * portal builder deriving a `connect-src` from its own configuration and this package
 * deriving one from `packageIndex: true` must not be two lists that can disagree.
 */
export const PACKAGE_INDEX_ORIGINS: readonly string[] = [
  "https://pypi.org",
  "https://files.pythonhosted.org",
];

export function contentSecurityPolicy(options: CspOptions = {}): string {
  // Every host-supplied value is validated BEFORE anything is assembled, so a refusal cannot
  // leave a half-built policy behind for a caller that swallows the error.
  const runtimeOrigin = options.runtimeOrigin
    ? originOf(options.runtimeOrigin, "runtimeOrigin")
    : null;
  const dataOrigins = (options.dataOrigins ?? []).map((origin) => originOf(origin, "dataOrigins"));
  const frameAncestors = (options.frameAncestors ?? []).map(frameAncestor);
  const frameSrc = (options.frameSrc ?? []).map((value) => originOf(value, "frameSrc"));
  // `'none'` is not a source; it is the ABSENCE of sources. `frame-ancestors 'none'
  // https://portal.example` is not narrower than either half - it is a contradiction, and which
  // half a browser honours is not knowable. Refused where the mistake is visible.
  if (frameAncestors.length > 1 && frameAncestors.includes("'none'")) {
    throw new TypeError(
      "frameAncestors cannot combine 'none' with anything else: 'none' means no framing at all, " +
        "so listing it alongside an origin is a contradiction rather than a narrower policy. " +
        "Pass either [\"'none'\"] or the origins that may frame this page.",
    );
  }

  const directives: Record<string, string[]> = Object.fromEntries(
    Object.entries(CSP_DIRECTIVES).map(([name, values]) => [name, [...values]]),
  );
  if (runtimeOrigin) {
    directives["script-src"]?.push(runtimeOrigin);
    directives["connect-src"]?.push(runtimeOrigin);
  }
  for (const origin of dataOrigins) {
    directives["connect-src"]?.push(origin);
  }
  if (options.packageIndex) {
    // The two hosts micropip uses, named rather than folded into `dataOrigins`: a reader of the
    // emitted header can tell a package index from a data store, and so can a reviewer.
    directives["connect-src"]?.push(...PACKAGE_INDEX_ORIGINS);
  }
  if (options.network === "https") {
    // The scheme, not a wildcard: TLS origins only, and only for connect-src. See `CspOptions`.
    directives["connect-src"]?.push("https:");
  }
  if (frameAncestors.length > 0) {
    // Replaces rather than appends: `'none'` and an origin in the same directive is not a policy,
    // and an empty list is not a way to delete the directive.
    directives["frame-ancestors"] = frameAncestors;
  }
  if (frameSrc.length > 0) {
    // A directive that did not exist in the base policy: `default-src 'none'` was governing frames
    // by fallback, and naming the frames a portal may load is strictly narrower than that fallback
    // being lifted some other way.
    directives["frame-src"] = frameSrc;
  }
  if (options.console) {
    // Attributes only. See `CspOptions.console`.
    directives["style-src-attr"] = ["'unsafe-inline'"];
  }
  if (options.allowInlineStyles) {
    directives["style-src"]?.push("'unsafe-inline'");
  }
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${[...new Set(values)].join(" ")}`)
    .join("; ");
}
