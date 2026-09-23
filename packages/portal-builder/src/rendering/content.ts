// The page pipeline: discover, parse, render diagrams, lower, link, sanitize.
//
// Ordering is the interesting part. Routes are known before any document is lowered, so a link
// to another page resolves immediately; heading anchors are known only *after* lowering, so
// fragment checks are deferred until every document has produced its ids. Diagrams are
// collected across the whole site and rendered in one browser pass, because starting a browser
// per diagram would dominate the build.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Diagnostic } from "../diagnostics.js";
import { CodeStyleSheet, type RunnableExample } from "./code.js";
import { sanitize, serialize, type HElement, type HNode } from "./html.js";
import type { IrCode, IrDocument, IrNode } from "./ir.js";
import { lineOf } from "./location.js";
import { lower, extractTitle, textOf, type HeadingOut, type LinkTarget } from "./lower.js";
import { attachCaptions } from "./markdown/captions.js";
import { parseMarkdown } from "./markdown/parse.js";
import { renderDiagrams } from "./mermaid.js";
import type { ContentProfile } from "./profile.js";
import { RstHelper } from "./rst/client.js";
import { runnableId, runnableTitle, validateRunnable } from "./runnable.js";
import { applyPathOverride, derivePageRoute } from "../routes/derive.js";
import type { MountedRoot } from "../model/assets.js";
import type { HeadingRef, RegisteredContentExample, RenderedFragment } from "../model/types.js";
import { selectFiles, walkRoot } from "../sources/glob.js";
import { sha256 } from "../util/package.js";
import { compareCodePoints } from "../util/order.js";

export interface ContentSourceSpec {
  root: MountedRoot;
  include: string[];
  exclude: string[];
}

export interface DiscoveredDoc {
  /** Source-root-relative path. */
  source: string;
  absolute: string;
  mount: string;
  /** Path relative to its content root. */
  relative: string;
  extension: ".md" | ".rst";
  /**
   * Source-root-relative path of the CONTENT ROOT this document was discovered under, e.g.
   * `content` - the declared source's identity. Section membership keys on it; the root rather
   * than the mount because two declared sources may mount at the same place, and root-relative
   * rather than absolute because it reaches the resolved model, where no build-machine path may.
   */
  contentRoot: string;
  /**
   * Directory of `relative`, `""` for a file directly under the content root. Kept from
   * discovery rather than recomputed from the final route: `guide.md` and `guide/index.md`
   * produce the same URL from different source relationships, and frontmatter can move a
   * page's public path anywhere under its mount while leaving it where it is on disk.
   */
  directory: string;
  /** Whether this file is its directory's `index.md` / `index.rst`. */
  isIndex: boolean;
}

export interface FragmentRequest {
  /** Source-root-relative path of the fragment file. */
  source: string;
  absolute: string;
  /** What referenced it, for the diagnostic. */
  referencedBy: string;
}

export interface RenderedPage {
  doc: DiscoveredDoc;
  route: string;
  fragment: RenderedFragment;
  /** The page's declared `navOrder`, if it stated one. Sibling ordering only. */
  navOrder?: number;
}

export interface ContentResult {
  pages: RenderedPage[];
  fragments: Map<string, RenderedFragment>;
  diagnostics: Diagnostic[];
  codeCss?: string;
  /** Every asset URL a document actually referenced. */
  referencedAssets: Set<string>;
  /** Digest and size of every source the renderer read. */
  inputs: { path: string; digest: string; bytes: number; role: "page" | "fragment" }[];
  /** True when at least one equation was rendered, so its stylesheet is needed. */
  mathUsed: boolean;
}

export interface ResolveTargets {
  /** Every generated route path, including landings and components. */
  routes: Set<string>;
  /** Published static file site-paths (assets, downloads, identity). */
  files: Map<string, string>;
  /** Subsite mounts, whose interiors are opaque to the portal. */
  subsiteMounts: string[];
  /** Source-root-relative asset path to its public URL. */
  assetsBySource: Map<string, string>;
  /** Site-logical path to the doc that owns it, for fragment checks. */
  routeOwner: Map<string, string>;
  basePath: string;
}

const DEFAULT_INCLUDE = ["**/*.md", "**/*.rst"];

export function discoverPages(
  specs: ContentSourceSpec[],
  fragmentSources: Set<string>,
): { docs: DiscoveredDoc[]; diagnostics: Diagnostic[] } {
  const docs: DiscoveredDoc[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const spec of specs) {
    const walked = walkRoot(spec.root.absolute, spec.root.relative);
    diagnostics.push(...walked.diagnostics);
    const selected = selectFiles(walked.files, {
      include: spec.include.length ? spec.include : DEFAULT_INCLUDE,
      exclude: spec.exclude,
    });
    for (const rel of selected) {
      const source = `${spec.root.relative}/${rel}`.replace(/^\/+/, "");
      const extension = rel.toLowerCase().endsWith(".rst") ? ".rst" : ".md";
      if (fragmentSources.has(source)) {
        // AR-012: a direct fragment owns no route. Being both is worth stopping the build
        // for, because one of the two uses is not what the author meant.
        diagnostics.push({
          code: "PC1020",
          severity: "error",
          message: `'${source}' is used as a direct fragment and is also discovered as a page.`,
          file: source,
          hint: "Move the fragment under an excluded directory such as _fragments/, or stop referencing it directly.",
        });
        continue;
      }
      const slash = rel.lastIndexOf("/");
      const stem = (slash < 0 ? rel : rel.slice(slash + 1)).replace(/\.(md|rst)$/i, "");
      docs.push({
        source,
        absolute: join(spec.root.absolute, rel),
        mount: spec.root.mount,
        relative: rel,
        extension,
        contentRoot: spec.root.relative,
        directory: slash < 0 ? "" : rel.slice(0, slash),
        isIndex: stem === "index",
      });
    }
  }
  docs.sort((a, b) => compareCodePoints(a.source, b.source));
  return { docs, diagnostics };
}

interface ParsedDoc {
  doc: DiscoveredDoc;
  ir: IrDocument;
  route: string;
  title: string;
  body: IrNode[];
}

export class ContentPipeline {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly codeSheet: CodeStyleSheet;
  private readonly rst: RstHelper;
  private rstUsed = false;
  private mathUsed = false;

  /**
   * Snippets registered while lowering, keyed by the file they came from. Filled during
   * `run()` and read out with `runnableFor`, because a fragment is rendered in one place and
   * consumed in several - a landing block's prose, a documentation page, both.
   */
  private readonly runnable = new Map<string, RegisteredContentExample[]>();

  constructor(
    private readonly profile: ContentProfile,
    private readonly limits: ContentProfile["limits"],
    /**
     * Whether a `try-in-python` marker means anything on this portal. False by default, which
     * keeps a marked block in a portal with no `pythonPlayground` rendering as ordinary
     * copyable code: the marker is parsed, diagnosed and then not acted on. The emitted HTML
     * of an unmarked block does not depend on this either way.
     */
    private readonly runnableEnabled = false,
  ) {
    this.codeSheet = new CodeStyleSheet(profile.highlighting.colorClassPrefix);
    this.rst = new RstHelper(profile);
  }

  get helperUsed(): boolean {
    return this.rstUsed;
  }

  get helperHandshake(): RstHelper["handshake"] {
    return this.rst.handshake;
  }

  /**
   * One counter per file, and the identity a marked block gets from it. The counter advances
   * for EVERY code block, marked or not: an id meaning "the third runnable block" would change
   * meaning the moment a marker was added above it, and a manifest already deployed to a
   * separate origin would then describe a different snippet under the same name. "The third
   * code block of guide.md" survives that, and is what a person counting would say.
   */
  private codeRegistrar(file: string): (node: IrCode) => RunnableExample | undefined {
    let occurrence = 0;
    return (node) => {
      occurrence += 1;
      if (!this.runnableEnabled || node.runnable !== true) return undefined;
      const sha256 = createHash("sha256").update(node.value, "utf8").digest("hex");
      const id = runnableId(file, occurrence);
      const registered = this.runnable.get(file) ?? [];
      registered.push({
        id,
        sha256,
        title: runnableTitle(file, occurrence, node.title),
        source: node.value,
      });
      this.runnable.set(file, registered);
      return { id, sha256 };
    };
  }

  /** What a rendered source registered, or `undefined` when the capability is off. */
  private runnableFor(file: string): RegisteredContentExample[] | undefined {
    if (!this.runnableEnabled) return undefined;
    return this.runnable.get(file) ?? [];
  }

  private async parseOne(
    source: string,
    absolute: string,
    extension: ".md" | ".rst",
  ): Promise<IrDocument | undefined> {
    const size = statSync(absolute).size;
    if (size > this.limits.maxSourceBytes) {
      this.diagnostics.push({
        code: "PC1016",
        severity: "error",
        message: `'${source}' is ${size} bytes, above the ${this.limits.maxSourceBytes}-byte source limit.`,
        file: source,
      });
      return undefined;
    }
    const text = readFileSync(absolute, "utf8");
    if (extension === ".rst") {
      this.rstUsed = true;
      const result = await this.rst.render(text, source);
      this.diagnostics.push(...result.diagnostics);
      // Both lanes go through the same attachment pass. Docutils already nests a `figure`
      // around its caption, so there is nothing there to attach, but a table title arrives the
      // same way in both, and one pass over both keeps the lanes from drifting into two
      // caption models.
      return this.attach(result.document, source);
    }
    const result = parseMarkdown(text, source, this.profile);
    this.diagnostics.push(...result.diagnostics);
    return this.attach(result.document, source);
  }

  /** Attach captions to the blocks they describe, in either lane. */
  private attach(document: IrDocument | undefined, source: string): IrDocument | undefined {
    if (!document) return document;
    const attached = attachCaptions(document, source);
    this.diagnostics.push(...attached.diagnostics);
    // One rule about the block, applied to both lanes - see `validateRunnable`.
    this.diagnostics.push(
      ...validateRunnable(attached.children, source, this.profile.highlighting.languages),
    );
    return { ...document, children: attached.children };
  }

  /**
   * Render the whole content graph. `fragments` are sources referenced directly by a landing
   * block or a component option: rendered and hashed like a page, but never routed.
   */
  async run(
    docs: DiscoveredDoc[],
    fragments: FragmentRequest[],
    targets: ResolveTargets,
    routeRegister: (path: string, owner: string) => boolean,
  ): Promise<ContentResult> {
    const inputs: ContentResult["inputs"] = [];
    const parsed: ParsedDoc[] = [];
    const parsedFragments: { request: FragmentRequest; ir: IrDocument }[] = [];

    if (docs.length > this.limits.maxPages) {
      this.diagnostics.push({
        code: "PC1016",
        severity: "error",
        message: `${docs.length} pages exceed the ${this.limits.maxPages}-page limit.`,
      });
    }

    for (const doc of docs) {
      const ir = await this.parseOne(doc.source, doc.absolute, doc.extension);
      const bytes = readFileSync(doc.absolute);
      inputs.push({
        path: doc.source,
        digest: sha256(bytes),
        bytes: bytes.byteLength,
        role: "page",
      });
      if (!ir) continue;

      const { title, children } = extractTitle(ir, this.profile);
      if (!title) {
        this.diagnostics.push({
          code: "PC1006",
          severity: "error",
          message: `'${doc.source}' has neither a frontmatter title nor a level-one heading.`,
          file: doc.source,
          hint: "A filename is not a human-facing title; state it explicitly.",
        });
        continue;
      }

      let route = derivePageRoute(doc.mount, doc.relative);
      if (ir.frontmatter.path) {
        const overridden = applyPathOverride(doc.mount, ir.frontmatter.path);
        if (!overridden) {
          this.diagnostics.push({
            code: "PC1005",
            severity: "error",
            message: `Frontmatter path '${ir.frontmatter.path}' is outside the source mount '${doc.mount}'.`,
            file: doc.source,
          });
          continue;
        }
        route = overridden;
      }
      if (!routeRegister(route, doc.source)) continue;
      targets.routes.add(route);
      targets.routeOwner.set(route, doc.source);
      parsed.push({ doc, ir, route, title, body: children });
    }

    for (const request of fragments) {
      const extension = request.source.toLowerCase().endsWith(".rst") ? ".rst" : ".md";
      const ir = await this.parseOne(request.source, request.absolute, extension as ".md" | ".rst");
      const bytes = readFileSync(request.absolute);
      inputs.push({
        path: request.source,
        digest: sha256(bytes),
        bytes: bytes.byteLength,
        role: "fragment",
      });
      if (ir) parsedFragments.push({ request, ir });
    }

    // One browser pass for every diagram on the site.
    const diagramNodes: { node: IrNode; file: string }[] = [];
    const collect = (nodes: IrNode[], file: string): void => {
      for (const node of nodes) {
        if (node.type === "diagram") diagramNodes.push({ node, file });
        const children = (node as { children?: IrNode[] }).children;
        if (children) collect(children, file);
      }
    };
    for (const p of parsed) collect(p.body, p.doc.source);
    for (const f of parsedFragments) collect(f.ir.children, f.request.source);

    const diagrams = new Map<IrNode, { light: HElement; dark?: HElement }>();
    if (diagramNodes.length > 0) {
      const requests = diagramNodes.map(({ node, file }, index) => ({
        code: (node as { value: string }).value,
        id: `${this.profile.mermaid.idPrefix}${sha256(`${file}#${index}`).slice(7, 19)}`,
        file,
        ...(lineOf(node.loc) !== undefined ? { line: lineOf(node.loc)! } : {}),
      }));
      const rendered = await renderDiagrams(requests, this.profile);
      rendered.forEach((result, index) => {
        this.diagnostics.push(...result.diagnostics);
        if (!result.root) return;
        result.root.generatedBy = "mermaid";
        if (result.darkRoot) result.darkRoot.generatedBy = "mermaid";
        diagrams.set(diagramNodes[index]!.node, {
          light: result.root,
          ...(result.darkRoot ? { dark: result.darkRoot } : {}),
        });
      });
    }

    const fragmentChecks: { file: string; line?: number; route: string; fragment: string }[] = [];
    const headingsByRoute = new Map<string, Set<string>>();
    const referencedAssets = new Set<string>();

    const makeContext = (
      file: string,
      selfRoute: string | undefined,
      headings: HeadingOut[],
    ): Parameters<typeof lower>[1] => ({
      profile: this.profile,
      file,
      diagnostics: this.diagnostics,
      codeSheet: this.codeSheet,
      diagrams,
      headings,
      footnoteOrder: new Map<string, number>(),
      markMath: () => {
        this.mathUsed = true;
      },
      resolveLink: (url, line, options) =>
        this.resolveLink(url, line, file, selfRoute, targets, fragmentChecks, options),
      resolveAsset: (url, line) => {
        const resolved = this.resolveAsset(url, line, file, targets);
        if (resolved) referencedAssets.add(resolved);
        return resolved;
      },
      registerCode: this.codeRegistrar(file),
    });

    const pages: RenderedPage[] = [];
    for (const p of parsed) {
      const headings: HeadingOut[] = [];
      const tree = await lower(p.body, makeContext(p.doc.source, p.route, headings));
      const html = this.finish(tree, p.doc.source);
      headingsByRoute.set(p.route, new Set(headings.map((hd) => hd.id)));
      const fragment: RenderedFragment = {
        html,
        headings: headings as HeadingRef[],
        source: p.doc.source,
        title: p.title,
        toc: p.ir.frontmatter.toc ?? this.profile.headings.tocDefault,
      };
      if (p.ir.frontmatter.description) {
        const description = p.ir.frontmatter.description.trim();
        if (description.length > this.limits.maxDescriptionLength) {
          this.diagnostics.push({
            code: "PC1016",
            severity: "error",
            message: `Description in '${p.doc.source}' is longer than ${this.limits.maxDescriptionLength} characters.`,
            file: p.doc.source,
          });
        }
        fragment.description = description;
      }
      if (Buffer.byteLength(html) > this.limits.maxRenderedBytesPerPage) {
        this.diagnostics.push({
          code: "PC1016",
          severity: "warning",
          message: `'${p.doc.source}' renders to ${Buffer.byteLength(html)} bytes, an unusually large page.`,
          file: p.doc.source,
        });
      }
      const registered = this.runnableFor(p.doc.source);
      if (registered) fragment.runnable = registered;
      pages.push({
        doc: p.doc,
        route: p.route,
        fragment,
        ...(typeof p.ir.frontmatter.navOrder === "number"
          ? { navOrder: p.ir.frontmatter.navOrder }
          : {}),
      });
    }

    const fragmentsOut = new Map<string, RenderedFragment>();
    for (const f of parsedFragments) {
      const headings: HeadingOut[] = [];
      const { title, children } = extractTitle(f.ir, this.profile);
      const tree = await lower(children, makeContext(f.request.source, undefined, headings));
      const rendered: RenderedFragment = {
        html: this.finish(tree, f.request.source),
        headings: headings as HeadingRef[],
        source: f.request.source,
        toc: false,
      };
      if (title) rendered.title = title;
      const registered = this.runnableFor(f.request.source);
      if (registered) rendered.runnable = registered;
      fragmentsOut.set(f.request.source, rendered);
    }

    for (const check of fragmentChecks) {
      const ids = headingsByRoute.get(check.route);
      if (!ids || ids.has(check.fragment)) continue;
      this.diagnostics.push({
        code: "PC1009",
        severity: "error",
        message: `Fragment '#${check.fragment}' does not exist on '${check.route}'.`,
        file: check.file,
        ...(check.line !== undefined ? { position: { line: check.line } } : {}),
      });
    }

    this.rst.stop();

    const result: ContentResult = {
      pages,
      fragments: fragmentsOut,
      diagnostics: this.diagnostics,
      referencedAssets,
      inputs,
      mathUsed: this.mathUsed,
    };
    if (this.codeSheet.used) result.codeCss = this.codeSheet.css();
    return result;
  }

  private finish(tree: HNode[], file: string): string {
    const diagnostics: Diagnostic[] = [];
    const clean = sanitize(tree, { profile: this.profile, file, diagnostics });
    this.diagnostics.push(...diagnostics);
    return serialize(clean, this.profile);
  }

  private reject(
    code: string,
    message: string,
    file: string,
    line: number | undefined,
    hint?: string,
  ): undefined {
    this.diagnostics.push({
      code,
      severity: "error",
      message,
      file,
      ...(line !== undefined ? { position: { line } } : {}),
      ...(hint ? { hint } : {}),
    });
    return undefined;
  }

  private resolveLink(
    url: string,
    line: number | undefined,
    file: string,
    selfRoute: string | undefined,
    targets: ResolveTargets,
    fragmentChecks: { file: string; line?: number; route: string; fragment: string }[],
    options: { bareWwwAutolink?: boolean } = {},
  ): LinkTarget | undefined {
    const raw = url.trim();
    if (raw === "") return this.reject("PC1008", "Empty link target.", file, line);

    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
    if (schemeMatch) {
      const scheme = schemeMatch[1]!.toLowerCase();
      if (scheme === "http" && options.bareWwwAutolink) {
        // AR-005 normalizes exactly one form: a GFM *bare* `www.` autolink, which the parser
        // marked as such. Inferring it from the final URL would silently upgrade an
        // explicitly authored `http://` link, which the profile requires to fail.
        return { href: `https://${raw.slice("http://".length)}`, external: true };
      }
      if (!this.profile.urls.allowedSchemes.includes(scheme)) {
        return this.reject(
          "PC1007",
          `URL scheme '${scheme}' is not accepted by portal-content-v1.`,
          file,
          line,
          `Accepted schemes: ${this.profile.urls.allowedSchemes.join(", ")}.`,
        );
      }
      return { href: raw, external: scheme === "https" };
    }

    if (raw.startsWith("#")) {
      if (selfRoute) {
        fragmentChecks.push({
          file,
          ...(line !== undefined ? { line } : {}),
          route: selfRoute,
          fragment: raw.slice(1),
        });
      }
      return { href: raw, external: false };
    }

    const [pathPart, fragment] = splitFragment(raw);

    if (raw.startsWith("/")) {
      const sitePath = normalizeSiteTarget(pathPart);
      const href = `${targets.basePath.replace(/\/$/, "")}${pathPart}`;
      if (
        targets.routes.has(sitePath) ||
        targets.files.has(pathPart) ||
        targets.subsiteMounts.some((m) => pathPart.startsWith(m))
      ) {
        if (fragment && targets.routes.has(sitePath)) {
          fragmentChecks.push({
            file,
            ...(line !== undefined ? { line } : {}),
            route: sitePath,
            fragment,
          });
        }
        return { href: fragment ? `${href}#${fragment}` : href, external: false };
      }
      return this.reject(
        "PC1008",
        `Internal link '${raw}' matches no generated route, static file or subsite mount.`,
        file,
        line,
      );
    }

    // A relative link to another source file becomes that file's route.
    const targetSource = posix.normalize(posix.join(posix.dirname(file), pathPart));
    if (/\.(md|rst)$/i.test(targetSource)) {
      const route = [...targets.routeOwner.entries()].find(
        ([, owner]) => owner === targetSource,
      )?.[0];
      if (!route) {
        return this.reject(
          "PC1008",
          `Link '${raw}' points at '${targetSource}', which is not a discovered page.`,
          file,
          line,
          "A fragment source owns no route; link to a page instead.",
        );
      }
      if (fragment) {
        fragmentChecks.push({ file, ...(line !== undefined ? { line } : {}), route, fragment });
      }
      const href = `${targets.basePath.replace(/\/$/, "")}${route}`;
      return { href: fragment ? `${href}#${fragment}` : href, external: false };
    }

    const assetUrl = targets.assetsBySource.get(targetSource);
    if (assetUrl) return { href: assetUrl, external: false };

    return this.reject(
      "PC1008",
      `Link '${raw}' resolves to '${targetSource}', which is neither a page nor a declared asset or download.`,
      file,
      line,
    );
  }

  private resolveAsset(
    url: string,
    line: number | undefined,
    file: string,
    targets: ResolveTargets,
  ): string | undefined {
    const trimmed = url.trim();
    // A fragment is not part of a file path: it selects a view inside an SVG, or tags the
    // image for a stylesheet rule. Either way the bytes to resolve are the ones before the
    // '#', and the fragment is carried through to the emitted URL unchanged.
    const [raw, assetFragment] = splitFragment(trimmed);
    const withFragment = (href: string): string =>
      assetFragment === undefined ? href : `${href}#${assetFragment}`;
    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
    if (schemeMatch) {
      const scheme = schemeMatch[1]!.toLowerCase();
      if (scheme === "https") {
        return this.reject(
          "PC1010",
          `Remote image '${raw}' is not accepted: nothing is fetched during a build.`,
          file,
          line,
          "Copy the image into a declared rendering.assets root.",
        );
      }
      return this.reject(
        "PC1007",
        `URL scheme '${scheme}' is not accepted for an image.`,
        file,
        line,
      );
    }
    if (raw.startsWith("/")) {
      const found = targets.files.get(raw);
      if (found) return withFragment(found);
      return this.reject("PC1010", `Asset '${raw}' does not exist in the artifact.`, file, line);
    }
    const targetSource = posix.normalize(posix.join(posix.dirname(file), raw));
    const assetUrl = targets.assetsBySource.get(targetSource);
    if (assetUrl) return withFragment(assetUrl);
    return this.reject(
      "PC1010",
      `Asset '${raw}' resolves to '${targetSource}', which is not inside a declared rendering.assets root.`,
      file,
      line,
    );
  }
}

function splitFragment(value: string): [string, string | undefined] {
  const index = value.indexOf("#");
  return index === -1 ? [value, undefined] : [value.slice(0, index), value.slice(index + 1)];
}

function normalizeSiteTarget(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

export { textOf };
