/**
 * What a trusted subsite actually references.
 *
 * Regular expressions are the wrong tool in front of a security boundary, because a browser's
 * HTML parser is not a regular language: `src=https://cdn.example/x.js` without quotes,
 * `onclick=alert(1)` without quotes, a `<script>` opened inside a comment - each is well-defined
 * to a browser and invisible to a pattern. So this uses a standards-compliant parser with the
 * same error recovery a browser performs, and reads the tree the browser would build.
 *
 * The inventory is bounded on purpose: it records statically discoverable resource URLs and
 * hashes literal inline blocks, and does not claim to predict what arbitrary JavaScript does at
 * runtime. That is the closed policy's job, checked in a real browser.
 */

import { createHash } from "node:crypto";
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import postcss from "postcss";
import { decodeSafePath, rawPathReason } from "../config/raw-path.js";

/**
 * What a browser would do with a reference, which is not the same question as where the reference
 * points.
 *
 * `static-docs-v1` says different things about each class - a third-party stylesheet is always
 * forbidden, a third-party frame is allowed exactly when the policy names its origin - so the
 * inventory reports the class, not just "external". Without it the collector cannot tell which
 * findings declared `frameOrigins` and `connectOrigins` are allowed to permit.
 */
export type ReferenceClass =
  /** Fetched and used as part of the document: script, style, image, font, media. */
  | "subresource"
  /** A connection or a hint to open one: `preconnect`, `dns-prefetch`. */
  | "connection"
  /** A nested browsing context: `iframe`. */
  | "frame"
  /** A worker script. */
  | "worker"
  /** Somewhere the reader may go: `a`, `form`, `base`. Fetches nothing. */
  | "navigation";

export type SubsiteFinding =
  | {
      kind: "external-subresource";
      value: string;
      element: string;
      attribute: string;
      origin: string;
    }
  | {
      kind: "external-connection";
      value: string;
      element: string;
      attribute: string;
      origin: string;
    }
  | { kind: "external-frame"; value: string; element: string; attribute: string; origin: string }
  | { kind: "external-worker"; value: string; element: string; attribute: string; origin: string }
  | {
      kind: "escaping-resource";
      value: string;
      element: string;
      attribute: string;
      referenceClass: ReferenceClass;
    }
  | { kind: "active-url"; value: string; element: string; attribute: string }
  | { kind: "event-handler"; attribute: string; element: string }
  | { kind: "unparsable-css"; detail: string };

/**
 * The origin of an external reference, as a browser would compute it. `URL.origin` lowercases the
 * host and drops a default port, exactly the normalization an origin comparison needs. A
 * reference whose origin cannot be computed is not comparable to a declared one and the caller
 * refuses it.
 */
export function referenceOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    return url.origin === "null" ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

export interface SubsiteInventory {
  /** Subsite-relative paths of every statically discoverable local resource. */
  localResources: string[];
  inlineScriptHashes: string[];
  inlineStyleHashes: string[];
  findings: SubsiteFinding[];
}

/**
 * URL-bearing attributes that make the browser *fetch a subresource into the page*. A hyperlink
 * is deliberately absent: a documentation subsite linking back to the portal it is mounted in is
 * normal, and `static-docs-v1` constrains what is fetched, not where a reader may click.
 */
const RESOURCE_ATTRIBUTES: Record<string, string[]> = {
  // `link` is handled separately: whether its href is fetched depends on `rel`.
  // `iframe` is handled separately: it is a frame, not a subresource.
  script: ["src"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  embed: ["src"],
  object: ["data"],
  input: ["src"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
};

/** Elements that create a nested browsing context. */
const FRAME_ATTRIBUTES: Record<string, string[]> = {
  iframe: ["src"],
};

/** `rel` values that only open or warm a connection; they load no document. */
const CONNECTION_LINK_RELATIONS = new Set(["preconnect", "dns-prefetch"]);

/** Attributes whose value may navigate, checked only for an active scheme. */
const NAVIGATION_ATTRIBUTES: Record<string, string[]> = {
  a: ["href"],
  area: ["href"],
  form: ["action"],
  button: ["formaction"],
  base: ["href"],
};

/**
 * The `rel` values that make a `<link>` href something the browser fetches or connects to.
 * Everything else - `canonical`, `alternate`, `next`, `license` - is metadata about *where this
 * page lives*, not a subresource. Treating a canonical URL as a fetched resource would report
 * every documentation generator that emits one as importing its own public origin: wrong, and the
 * kind of false alarm that gets a real check switched off.
 *
 * `preconnect` and `dns-prefetch` are included: they fetch no document, but they do open a
 * connection to a third party, which is what static-docs-v1 decides about.
 */
const FETCHING_LINK_RELATIONS = new Set([
  "stylesheet",
  "icon",
  "shortcut icon",
  "apple-touch-icon",
  "apple-touch-icon-precomposed",
  "mask-icon",
  "manifest",
  "preload",
  "modulepreload",
  "prefetch",
  "prerender",
  "preconnect",
  "dns-prefetch",
]);

/**
 * Element/attribute pairs a browser loads as an image, with scripting disabled. `object[data]`,
 * `embed[src]` and `iframe[src]` are absent: document contexts, where a `data:` URL is the attack
 * the rule is for.
 */
const IMAGE_CONTEXTS = new Set([
  "img[src]",
  "img[srcset]",
  "source[srcset]",
  "video[poster]",
  "input[src]",
  "image[href]",
  "image[xlink:href]",
]);

const ACTIVE_SCHEME = /^\s*(?:javascript|vbscript|data)\s*:/i;

/**
 * A `data:` URL that carries an image. `data:` is an active scheme in a navigational or document
 * context - `data:text/html` in an iframe or a link is a script delivery mechanism - but not in
 * an *image* context: a browser loads a CSS `url()` or an `<img src>` with scripting disabled and
 * external references blocked, including for SVG. Refusing those would reject every mainstream
 * documentation theme, which vendors its icons exactly this way, for no security gained.
 */
const DATA_IMAGE = /^\s*data:image\/[a-z0-9.+-]+[;,]/i;

type Element = DefaultTreeAdapterTypes.Element;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;

function hash(content: string): string {
  return `sha256-${createHash("sha256").update(content, "utf8").digest("base64")}`;
}

function textOf(element: Element): string {
  return element.childNodes
    .map((child) => ("value" in child && typeof child.value === "string" ? child.value : ""))
    .join("");
}

function attributeOf(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name.toLowerCase())?.value;
}

export type ReferenceResolution =
  | { kind: "local"; path: string }
  | { kind: "external" }
  | { kind: "escapes" }
  | { kind: "ignored" }
  | { kind: "active" };

/**
 * Resolve a reference to a subsite-relative path, or say why it cannot be one. `mountPrefix` is
 * the artifact-absolute prefix this subsite is served under, so a root-relative reference is
 * compared in the same namespace as a relative one; get that wrong and the resulting "resources"
 * can never match the copied files.
 */
export function resolveReference(
  raw: string,
  file: string,
  mountPrefix: string,
  options: { imageContext?: boolean } = {},
): ReferenceResolution {
  const value = raw.trim();
  if (value === "" || value.startsWith("#")) return { kind: "ignored" };
  if (options.imageContext && DATA_IMAGE.test(value)) return { kind: "ignored" };
  if (ACTIVE_SCHEME.test(value)) return { kind: "active" };
  if (value.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value))
    return { kind: "external" };

  const withoutQuery = value.split("?")[0]!.split("#")[0]!;
  if (withoutQuery === "") return { kind: "ignored" };

  // The same raw-path contract the rest of the system uses: a subsite reference that
  // percent-encodes a separator or a dot segment is refused, not decoded once and trusted.
  if (
    rawPathReason(withoutQuery, {
      requireLeadingSlash: false,
      rejectQueryAndFragment: false,
      // A literal `../style.css` is how generators write a sibling path; it is resolved below
      // and proved inside the mount. An *encoded* dot segment is refused.
      allowDotSegments: true,
    }) !== undefined
  ) {
    return { kind: "escapes" };
  }
  const decoded = decodeSafePath(withoutQuery);

  const directory = posixDirname(file);
  const base = withoutQuery.startsWith("/")
    ? decoded
    : `${mountPrefix}${directory}${directory ? "/" : ""}${decoded}`;

  const normalized = normalizePosix(base.startsWith("/") ? base : `/${base}`);
  if (normalized === undefined) return { kind: "escapes" };
  if (!normalized.startsWith(mountPrefix)) return { kind: "escapes" };
  return { kind: "local", path: normalized.slice(mountPrefix.length) };
}

function posixDirname(file: string): string {
  const index = file.lastIndexOf("/");
  return index === -1 ? "" : file.slice(0, index);
}

/** Collapse `.` and `..` without letting `..` climb above the root. */
function normalizePosix(path: string): string | undefined {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

const URL_TOKEN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;

function emptyInventory(): SubsiteInventory {
  return { localResources: [], inlineScriptHashes: [], inlineStyleHashes: [], findings: [] };
}

function classify(
  inventory: SubsiteInventory,
  raw: string,
  file: string,
  mountPrefix: string,
  element: string,
  attribute: string,
  referenceClass: ReferenceClass,
  imageContext = false,
): void {
  const resolved = resolveReference(raw, file, mountPrefix, { imageContext });
  const value = raw.trim();

  if (resolved.kind === "local") {
    // A local frame or subresource must exist in the copied tree; navigation may point at a
    // page the subsite does not own.
    if (referenceClass !== "navigation") inventory.localResources.push(resolved.path);
    return;
  }

  if (resolved.kind === "external") {
    if (referenceClass === "navigation") return;
    const origin = referenceOrigin(value) ?? "";
    const kind = (
      {
        subresource: "external-subresource",
        connection: "external-connection",
        frame: "external-frame",
        worker: "external-worker",
      } as const
    )[referenceClass];
    inventory.findings.push({ kind, value, element, attribute, origin });
    return;
  }

  if (resolved.kind === "escapes") {
    // A hyperlink out of the subsite is ordinary navigation - a documentation page linking back
    // to the portal it is mounted in is normal. Only what the browser *loads* must stay inside.
    if (referenceClass !== "navigation") {
      inventory.findings.push({
        kind: "escaping-resource",
        value,
        element,
        attribute,
        referenceClass,
      });
    }
    return;
  }

  if (resolved.kind === "active") {
    inventory.findings.push({ kind: "active-url", value, element, attribute });
  }
}

/** Inspect one stylesheet with a real CSS parser rather than a pattern. */
export function inspectCss(source: string, file: string, mountPrefix: string): SubsiteInventory {
  const inventory = emptyInventory();

  let root;
  try {
    root = postcss.parse(source, { from: undefined });
  } catch (error) {
    inventory.findings.push({
      kind: "unparsable-css",
      detail: error instanceof Error ? error.message : String(error),
    });
    return inventory;
  }

  root.walkDecls((declaration) => {
    for (const match of declaration.value.matchAll(URL_TOKEN)) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";
      if (value) {
        classify(inventory, value, file, mountPrefix, "css", declaration.prop, "subresource", true);
      }
    }
  });

  root.walkAtRules("import", (rule) => {
    const quoted = /^\s*(?:"([^"]*)"|'([^']*)')/.exec(rule.params);
    if (quoted) {
      classify(
        inventory,
        quoted[1] ?? quoted[2] ?? "",
        file,
        mountPrefix,
        "css",
        "@import",
        "subresource",
      );
      return;
    }
    for (const match of rule.params.matchAll(URL_TOKEN)) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";
      if (value) classify(inventory, value, file, mountPrefix, "css", "@import", "subresource");
    }
  });

  inventory.localResources = [...new Set(inventory.localResources)].sort();
  return inventory;
}

/** Inspect one HTML document the way a browser would read it. */
export function inspectHtml(source: string, file: string, mountPrefix: string): SubsiteInventory {
  const inventory = emptyInventory();
  const document = parse(source, { sourceCodeLocationInfo: false });

  const visit = (node: ChildNode | DefaultTreeAdapterTypes.Document): void => {
    const element = node as Element;
    if ("tagName" in element && Array.isArray(element.attrs)) {
      const tag = element.tagName.toLowerCase();

      // Every `on*` attribute, whatever the quoting, on whatever element.
      for (const attr of element.attrs) {
        if (attr.name.toLowerCase().startsWith("on") && attr.value.trim() !== "") {
          inventory.findings.push({ kind: "event-handler", attribute: attr.name, element: tag });
        }
      }

      for (const name of RESOURCE_ATTRIBUTES[tag] ?? []) {
        const value = attributeOf(element, name);
        if (value === undefined) continue;
        const imageContext = IMAGE_CONTEXTS.has(`${tag}[${name}]`);
        const candidates = name === "srcset" ? value.split(",") : [value];
        for (const candidate of candidates) {
          const url = candidate.trim().split(/\s+/)[0] ?? "";
          if (url) {
            classify(inventory, url, file, mountPrefix, tag, name, "subresource", imageContext);
          }
        }
      }

      for (const name of FRAME_ATTRIBUTES[tag] ?? []) {
        const value = attributeOf(element, name);
        if (value !== undefined && value !== "") {
          classify(inventory, value, file, mountPrefix, tag, name, "frame");
        }
      }

      if (tag === "link") {
        const href = attributeOf(element, "href");
        if (href !== undefined && href !== "") {
          const rel = (attributeOf(element, "rel") ?? "").toLowerCase().trim();
          const tokens = rel.split(/\s+/);
          const connects =
            CONNECTION_LINK_RELATIONS.has(rel) ||
            tokens.some((token) => CONNECTION_LINK_RELATIONS.has(token));
          const fetches =
            FETCHING_LINK_RELATIONS.has(rel) ||
            tokens.some((token) => FETCHING_LINK_RELATIONS.has(token));
          // A connection hint is checked against `connectOrigins`, a fetch is a subresource,
          // anything else is metadata about where the page lives.
          const referenceClass: ReferenceClass = connects
            ? "connection"
            : fetches
              ? "subresource"
              : "navigation";
          classify(inventory, href, file, mountPrefix, tag, "href", referenceClass);
        }
      }

      for (const name of NAVIGATION_ATTRIBUTES[tag] ?? []) {
        const value = attributeOf(element, name);
        if (value !== undefined) {
          classify(inventory, value, file, mountPrefix, tag, name, "navigation");
        }
      }

      if (tag === "script") {
        const src = attributeOf(element, "src");
        const body = textOf(element);
        if (src === undefined && body.trim() !== "") inventory.inlineScriptHashes.push(hash(body));
      }

      if (tag === "style") {
        const body = textOf(element);
        if (body.trim() !== "") {
          inventory.inlineStyleHashes.push(hash(body));
          const nested = inspectCss(body, file, mountPrefix);
          inventory.localResources.push(...nested.localResources);
          inventory.findings.push(...nested.findings);
        }
      }

      const inlineStyle = attributeOf(element, "style");
      if (inlineStyle) {
        const nested = inspectCss(`selector{${inlineStyle}}`, file, mountPrefix);
        inventory.localResources.push(...nested.localResources);
        inventory.findings.push(...nested.findings);
      }
    }

    for (const child of (node as { childNodes?: ChildNode[] }).childNodes ?? []) visit(child);
    // A template's contents are not in childNodes.
    const content = (node as { content?: DefaultTreeAdapterTypes.DocumentFragment }).content;
    if (content) for (const child of content.childNodes) visit(child);
  };

  visit(document);
  inventory.localResources = [...new Set(inventory.localResources)].sort();
  inventory.inlineScriptHashes = [...new Set(inventory.inlineScriptHashes)].sort();
  inventory.inlineStyleHashes = [...new Set(inventory.inlineStyleHashes)].sort();
  return inventory;
}
