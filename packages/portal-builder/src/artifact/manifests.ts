// The artifact's manifests.
//
// These are the artifact's public contract with whatever deploys it: what it is, what went
// into it, what the browser will be allowed to do, and what a host must promise. They contain
// no secrets, no absolute caller paths, no temporary directory names and no wall-clock value,
// because all four would make two identical builds produce two different artifacts.

import { createHash } from "node:crypto";
import type { EvidenceResult } from "./evidence.js";
import type {
  CacheClass,
  ResolvedPortalModel,
  ResolvedStaticFile,
  StacOptions,
} from "../model/types.js";
import type { PreparedStacMaterials } from "../components/stac-browser/materials.js";
import { registrationFor } from "../components/registry.js";
import { packagePurl, sha256 } from "../util/package.js";
import type { RstHandshake } from "../rendering/rst/client.js";
import { compareCodePoints } from "../util/order.js";
import { DEFAULT_PYODIDE_INDEX_URL } from "@freva-org/browser-python";

/**
 * Where the Python runtime is fetched from, as an ORIGIN. Taken from the package rather than
 * written out here, because the two would otherwise drift on the next runtime bump and the
 * symptom would be a policy that blocks the interpreter it was written for. An origin and not
 * the full URL: CSP source expressions match by origin, and pinning the path here would be a
 * promise this policy cannot keep.
 */
export const PYODIDE_RUNTIME_ORIGIN = new URL(DEFAULT_PYODIDE_INDEX_URL).origin;

export interface ArtifactFile {
  path: string;
  bytes: number;
  digest: string;
  mimeType: string;
  cacheClass: CacheClass;
  contentDisposition?: string;
}

export const CACHE_HEADERS: Record<CacheClass, string> = {
  immutable: "public, max-age=31536000, immutable",
  revalidate: "public, max-age=0, must-revalidate",
  download: "public, max-age=3600",
  subsite: "public, max-age=0, must-revalidate",
  "no-store": "no-store",
};

const HTML = "text/html; charset=utf-8";

export function mimeForArtifactFile(path: string): string {
  if (path.endsWith(".html")) return HTML;
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".txt") || path.endsWith(".sha256")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export interface ManifestInputs {
  model: ResolvedPortalModel;
  evidence: EvidenceResult;
  files: ArtifactFile[];
  stac?: PreparedStacMaterials;
  rstHelper?: RstHandshake;
  rstUsed: boolean;
  builderImage?: {
    reference: string;
    indexDigest: string;
    manifestDigest: string;
    configDigest: string;
    platform: { os: string; architecture: string; variant?: string };
  };
  sourceRevision?: string;
  publicEnvironment?: Record<string, string>;
  /** Literal inline blocks the compiler emitted, hashed for the portal CSP. */
  inlineScriptHashes?: string[];
  inlineStyleHashes?: string[];
  /**
   * Whether this artifact publishes the mathematics stylesheet. It is KaTeX's own CSS, and
   * KaTeX inlines its font faces as `data:` URLs, so the portal needs `font-src data:` exactly
   * when it ships that stylesheet and not otherwise. It is not the STAC component's to grant:
   * the prepared tree contains no font and no `@font-face`, so taking the grant from there
   * would refuse a mathematics portal its own fonts and hand a third-party application `data:`
   * fonts for no reason.
   */
  mathUsed?: boolean;
}

export function inputManifest(inputs: ManifestInputs): object {
  const { model } = inputs;
  return {
    schemaVersion: 1,
    site: {
      id: model.site.id,
      canonicalUrl: model.site.canonicalUrl,
      basePath: model.site.basePath,
    },
    sources: model.inputs.map((input) => ({
      ref: { kind: "source", path: input.path },
      role: input.role,
      digest: input.digest,
      bytes: input.bytes,
    })),
    builder: {
      package: {
        kind: "package",
        purl: packagePurl(),
        path: "dist/index.js",
      },
      ...(inputs.builderImage ? { image: { kind: "image", ...inputs.builderImage } } : {}),
      ...(inputs.sourceRevision ? { sourceRevision: inputs.sourceRevision } : {}),
    },
    schemas: {
      portal: { name: "portal.schema.json", digest: model.buildIdentity.schemaDigests.portal! },
      landing: { name: "landing.schema.json", digest: model.buildIdentity.schemaDigests.landing! },
      subsitePolicy: {
        name: "subsite-policy.schema.json",
        digest: model.buildIdentity.schemaDigests.subsitePolicy!,
      },
    },
    profile: { name: model.buildIdentity.profileName, digest: model.buildIdentity.profileDigest },
    ...(inputs.rstUsed && inputs.rstHelper
      ? {
          rstHelper: {
            protocol: inputs.rstHelper.protocol,
            package: inputs.rstHelper.package,
            version: inputs.rstHelper.version,
            docutils: inputs.rstHelper.docutils,
          },
        }
      : {}),
    components: model.components.map((component) => ({
      id: component.id,
      kind: component.kind,
      enabled: component.enabled,
      materials: component.enabled
        ? [{ kind: "package", purl: packagePurl(), path: `client/components/${component.kind}.ts` }]
        : [],
    })),
    ...(inputs.stac
      ? {
          stac: {
            upstream: {
              repository: inputs.stac.manifest.upstream.repository,
              tag: inputs.stac.manifest.upstream.tag,
              commit: inputs.stac.manifest.upstream.commit,
              ...(inputs.stac.manifest.upstream.sourceDigest
                ? { sourceDigest: inputs.stac.manifest.upstream.sourceDigest }
                : {}),
            },
            patches: inputs.stac.manifest.patches,
            preparedDigest: inputs.stac.manifest.treeDigest,
            // Which recipe produced that tree, when the preparation stage said so. The
            // artifact already names the upstream commit and the ordered patches; this names
            // the Freva side of the same question, which an upgrade review needs to line up.
            ...(inputs.stac.provenance?.recipeVersion
              ? { recipeVersion: inputs.stac.provenance.recipeVersion }
              : {}),
            ...(inputs.stac.provenance?.cacheKey
              ? { cacheKey: inputs.stac.provenance.cacheKey }
              : {}),
            ...(inputs.stac.provenance?.upstream?.licenseSpdx
              ? {
                  license: {
                    spdx: inputs.stac.provenance.upstream.licenseSpdx,
                    ...(inputs.stac.provenance.upstream.licenseDigest
                      ? { digest: inputs.stac.provenance.upstream.licenseDigest }
                      : {}),
                  },
                }
              : {}),
            ...(inputs.stac.provenance?.upstream?.lockfileDigest
              ? { lockfileDigest: inputs.stac.provenance.upstream.lockfileDigest }
              : {}),
          },
        }
      : {}),
    ...(model.trustedSubsiteMounts.length
      ? {
          trustedSubsites: model.trustedSubsiteMounts.map((subsite) => ({
            mount: subsite.mount,
            profile: subsite.profile,
            policyDigest: subsite.policyDigest,
            treeDigest: subsite.treeDigest,
            fileCount: subsite.files.length,
            bytes: subsite.files.reduce((sum, f) => sum + f.bytes, 0),
          })),
        }
      : {}),
    reproducibility: {
      sourceDateEpoch: model.buildIdentity.sourceDateEpoch,
      ...(model.buildIdentity.effectiveAt ? { effectiveAt: model.buildIdentity.effectiveAt } : {}),
      release: model.buildIdentity.release,
    },
    ...(inputs.publicEnvironment ? { publicEnvironment: inputs.publicEnvironment } : {}),
  };
}

export function portalManifest(inputs: ManifestInputs): object {
  const { model } = inputs;
  return {
    schemaVersion: 1,
    site: {
      id: model.site.id,
      title: model.site.title,
      language: model.site.language,
      canonicalUrl: model.site.canonicalUrl,
      basePath: model.site.basePath,
      theme: model.theme.preset,
    },
    routes: model.routes.map((route) => ({
      path: route.path,
      url: route.url,
      kind: route.kind,
      file: route.file,
      ...(route.componentId ? { componentId: route.componentId } : {}),
      ...(route.landingId ? { landingId: route.landingId } : {}),
      title: route.title,
    })),
    components: model.components.map((component) => ({
      id: component.id,
      kind: component.kind,
      enabled: component.enabled,
      ...(component.enabled && component.route ? { route: component.route } : {}),
      ...(component.enabled && component.serviceId ? { serviceId: component.serviceId } : {}),
    })),
    services: model.services.map((service) => ({
      id: service.id,
      kind: service.kind,
      origin: service.origin,
      url: service.url,
      authentication: service.authentication,
    })),
    mounts: model.trustedSubsiteMounts.map((subsite) => ({
      mount: subsite.mount,
      kind: "subsite" as const,
      profile: subsite.profile,
    })),
    files: inputs.files.map((file) => ({
      path: file.path,
      mimeType: file.mimeType,
      cacheClass: file.cacheClass,
      ...(file.contentDisposition ? { contentDisposition: file.contentDisposition } : {}),
      bytes: file.bytes,
    })),
  };
}

export function componentEvidenceManifest(evidence: EvidenceResult): object {
  return {
    schemaVersion: 1,
    components: evidence.components.map((component) => ({
      id: component.id,
      kind: component.kind,
      enabled: component.enabled,
      ownedModuleRoots: component.ownedModuleRoots,
      ownedStaticRoots: component.ownedStaticRoots,
      assetNamespaces: component.assetNamespaces,
      allowedSharedModules: component.allowedSharedModules,
      modules: component.modules,
      chunks: component.chunks,
      copiedRoots: component.copiedRoots,
      copiedFiles: component.copiedFiles,
      routes: component.routes,
      emittedServiceIds: component.emittedServiceIds,
    })),
    // `chunkModuleBytes` is build-time attribution, not artifact evidence: it exists so the
    // per-module sizes can be summed over the chunks that survived. Listing every field
    // explicitly means a new one has to be a decision rather than an accident.
    graph: {
      // The three published fields per chunk, and not the edge lists. `imports`,
      // `dynamicImports` and `css` are recorded during the build so the separate-origin
      // playground's deployment list can be a closure over what the bundler actually emitted.
      // They are bundler bookkeeping rather than evidence about a component, and the
      // manifest's schema is closed on purpose, so they are dropped here in one place rather
      // than by widening the schema to admit whatever a future recording adds.
      chunks: evidence.graph.chunks.map((chunk) => ({
        file: chunk.file,
        isEntry: chunk.isEntry,
        modules: chunk.modules,
      })),
      modules: evidence.graph.modules,
      copiedFiles: evidence.graph.copiedFiles,
      moduleBytes: evidence.graph.moduleBytes,
    },
  };
}

/**
 * Whether `static-docs-v1` permits a subsite to frame its own pages. Named rather than inlined
 * so that forbidding frames altogether is a one-line profile decision somebody signed off, and
 * so an empty `frameOrigins` list cannot quietly mean the same thing.
 */
const STATIC_DOCS_V1_FRAMES_SELF = true;

export function hostPolicy(inputs: ManifestInputs): object {
  const { model } = inputs;
  const connectOrigins = new Set<string>();
  for (const service of model.services) if (service.origin) connectOrigins.add(service.origin);

  // Enabled components may need directives the portal baseline does not grant. They are merged
  // here, from the registry, so the policy the artifact carries is one it can satisfy.
  const componentDirectives = new Map<string, Set<string>>();
  for (const component of model.enabledComponents) {
    for (const [directive, values] of Object.entries(
      registrationFor(component.kind).cspRequirements,
    )) {
      const set = componentDirectives.get(directive) ?? new Set<string>();
      for (const value of values) set.add(value);
      componentDirectives.set(directive, set);
    }
  }
  // The Python playground, whose requirements are a BLOCK's rather than a component's, merged
  // into the same map. A portal with no playground reaches none of this: the directives below
  // are added only when a landing block enabled one. Two topologies, two answers. On the
  // portal's OWN origin the interpreter needs `'wasm-unsafe-eval'` (which permits compiling
  // WebAssembly and nothing else - not `eval`, not `new Function`), a same-origin Worker, the
  // runtime's CDN in `script-src` and `connect-src`, `blob:` for artifact previews, and
  // `style-src-attr 'unsafe-inline'` because jQuery Terminal builds its own markup with style
  // attributes. Framed on a SEPARATE origin it needs one thing: permission to load that
  // origin in a frame - the arrangement to prefer, and the shorter list says why.
  //
  // A LIVE DATASET TREE'S GATEWAY goes in `connect-src` and in nothing else. The block lists
  // one prefix per expanded row, so the artifact really does reach a third party at run time.
  // Its ORIGIN, not its URL: CSP source expressions match by origin, and pinning the path
  // would be a promise this policy cannot keep. A snapshot block adds nothing here, which is
  // the difference the two modes are for.
  for (const landing of model.landings) {
    for (const block of landing.blocks) {
      const origin = block.datasetTree?.s3?.origin;
      if (origin) connectOrigins.add(origin);
    }
  }

  // Every playground on the portal, from BOTH the things that can ask for one: a dataset-tree
  // block's stanza, and a page that registered a runnable snippet. Reading only the blocks is
  // a silent hole now that a documentation page can have an interpreter - the page would load
  // one and the portal's own policy would refuse the Worker.
  const playgrounds = [
    ...model.landings
      .flatMap((landing) => landing.blocks)
      .map((block) => block.datasetTree?.python),
    ...model.routes.map((route) => route.python),
  ].filter((python): python is NonNullable<typeof python> => Boolean(python));
  for (const playground of playgrounds) {
    const add = (directive: string, values: readonly string[]): void => {
      const set = componentDirectives.get(directive) ?? new Set<string>();
      for (const value of values) set.add(value);
      componentDirectives.set(directive, set);
    };
    if (playground.playgroundOrigin) {
      add("frame-src", [playground.playgroundOrigin]);
      // …and the one grant the WINDOW needs, which the parent draws in both topologies.
      // `@freva-org/freva-client-terminal` positions and sizes itself with style ATTRIBUTES,
      // so a portal whose interpreter is on another origin still refuses its own window chrome
      // without this: in a real browser the window appears unstyled and the frame inside it
      // never gets a box to load into. The interpreter's own grants are not here; this is the
      // chrome, and the chrome is all a framed parent runs.
      add("style-src-attr", ["'unsafe-inline'"]);
      continue;
    }
    // The runtime's origin, which is the deployment's when it hosts its own copy. Naming the
    // pinned CDN unconditionally would write a policy for a runtime the artifact does not
    // fetch and omit the one it does, so a portal with a mirror would be blocked by its own
    // policy - the most expensive kind of correct-looking configuration.
    const runtime = playground.runtimeIndexUrl
      ? new URL(playground.runtimeIndexUrl).origin
      : PYODIDE_RUNTIME_ORIGIN;
    add("script-src", ["'wasm-unsafe-eval'", runtime]);
    add("worker-src", ["'self'"]);
    add("img-src", ["blob:"]);
    add("media-src", ["'self'", "blob:"]);
    add("style-src-attr", ["'unsafe-inline'"]);
    connectOrigins.add(runtime);
    // PACKAGE ORIGINS, from the resolved package policy and from nowhere else - the same
    // object the terminal's package help is rendered from. That is the point: help that
    // offers `micropip.install("name")` while this policy names no package index advertises a
    // capability the portal forbids, and the command fails at metadata lookup. Two texts about
    // one deployment drift; one value used twice cannot. `'self'` already covers the default
    // layouts - the wheelhouse and the add-on directory both default beside the runtime - so
    // what is added here is the runtime's origin and any explicitly configured elsewhere.
    for (const origin of playground.packagePolicy.origins) connectOrigins.add(origin);
    // AND THE SCHEME, when the deployment asked for the open policy. `https:` is a scheme
    // source in `connect-src`: any TLS origin may be FETCHED, plaintext may not, and no other
    // directive changes - `script-src` still names only this origin, the inline hashes and
    // the runtime. Deliberately not `*`, which would also carry `ws:`, `data:` and plaintext.
    // THE SCOPE IS THE PAGE, which is wider than the Worker: with its own origin the Worker
    // is served by the CHILD artifact, which records its own policy in
    // `playground-deploy.ts`; SAME-ORIGIN, the Worker script is served by THIS artifact under
    // this policy, so an install cannot work unless this `connect-src` carries the scheme. A
    // Worker loaded from a URL is governed by the CSP on ITS OWN script response, not the
    // document's, so a narrower Worker policy is a hosting decision rather than a CSP
    // impossibility - but `host-policy.json` carries a single `csp.portal` block that every
    // deployment recipe sends on every response, so narrowing it here would mean a second,
    // per-path policy every static host would have to apply. `playgroundOrigin` expresses
    // that boundary in a way any host can honour. (`worker-src` governs something else again:
    // where a Worker may be LOADED from.)
    if (playground.packagePolicy.anyHttpsOrigin) connectOrigins.add("https:");
    // And the deployment's own allowlist. EXACTLY these, and never one more: they come from
    // configuration and nowhere else - no origin here was read out of a code block, inferred
    // from an import, or derived from what a snippet appears to talk to. A portal that emits
    // no runnable provider adds none of them, because this loop does not run.
    for (const origin of playground.connectOrigins) connectOrigins.add(origin);
  }

  // External origins a component's own configuration permits, as opposed to the fixed
  // requirements of the pinned build. Today that is basemap tiles: a deployment lists the
  // origins it accepts third-party tile requests from, and the same statement reaches the
  // mounted application, so the map cannot be configured to draw tiles this policy refuses.
  for (const component of model.enabledComponents) {
    if (component.kind !== "stac-browser") continue;
    const origins = (component.options as StacOptions).access.basemapOrigins;
    if (origins.length === 0) continue;
    const set = componentDirectives.get("img-src") ?? new Set<string>();
    for (const origin of origins) set.add(origin);
    componentDirectives.set("img-src", set);
  }

  // A component's own service origin, in the directives that component says it needs it in.
  // `connect-src` gets every service origin, because that is how the artifact reaches a
  // service at all. What comes BACK from one is the component's business: a STAC document's
  // thumbnails live on the service that served the document, so granting the origin in
  // `connect-src` alone lets an artifact fetch the catalogue and not one image it points at,
  // and every collection tile draws its `alt` text. Per component, from the registry, rather
  // than derived for every service: an auth broker's origin has no business in `img-src`, and
  // granting it there for symmetry would widen a policy nobody asked to widen.
  const serviceOriginById = new Map(model.services.map((service) => [service.id, service.origin]));
  for (const component of model.enabledComponents) {
    const directives = registrationFor(component.kind).serviceOriginDirectives;
    if (directives.length === 0) continue;
    const origin = component.serviceId ? serviceOriginById.get(component.serviceId) : undefined;
    // Empty means same-origin, which `'self'` already covers in every directive.
    if (!origin) continue;
    for (const directive of directives) {
      const set = componentDirectives.get(directive) ?? new Set<string>();
      set.add(origin);
      componentDirectives.set(directive, set);
    }
  }

  const withComponents = (directive: string, baseline: string[]): string => {
    const extra = [...(componentDirectives.get(directive) ?? [])].sort(compareCodePoints);
    // A browser ignores 'unsafe-inline' whenever a hash or nonce is also present, so listing
    // both would produce a policy that reads stricter than it is.
    const kept = extra.includes("'unsafe-inline'")
      ? baseline.filter((value) => !value.startsWith("'sha"))
      : baseline;
    // Deduplicated, keeping first occurrence, so a component asking for something the baseline
    // already grants does not make the emitted policy read `img-src 'self' data: blob: data:`:
    // harmless to a browser, misleading to the people who read this deciding whether a
    // deployment is safe.
    return [...new Set([...kept, ...extra])].join(" ");
  };

  const headers: object[] = [
    {
      match: { class: "immutable" },
      set: { "Cache-Control": CACHE_HEADERS.immutable },
    },
    {
      match: { class: "revalidate" },
      set: { "Cache-Control": CACHE_HEADERS.revalidate },
    },
    ...model.hostPolicy.downloadPrefixes.map((prefix) => ({
      match: { prefix: `${model.site.basePath.replace(/\/$/, "")}${prefix}` },
      set: {
        "Cache-Control": CACHE_HEADERS.download,
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
      },
    })),
  ];

  const authCallback = model.hostPolicy.authCallbackPath;
  if (authCallback) {
    headers.push({
      match: { path: `${model.site.basePath.replace(/\/$/, "")}${authCallback}` },
      set: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
      accessLog: { redactQueryString: true },
    });
  }

  return {
    schemaVersion: 1,
    mount: {
      canonicalUrl: model.site.canonicalUrl,
      basePath: model.site.basePath,
      documentRoot: ".",
    },
    routing: {
      directoryIndex: "index.html",
      spaFallback: false,
      trailingSlashRedirect: "308",
      preserveQueryOnRedirect: true,
    },
    errorPages: { notFound: "404.html", status: 404 },
    headers,
    csp: {
      portal: {
        "default-src": "'none'",
        "script-src": withComponents("script-src", [
          "'self'",
          ...(inputs.inlineScriptHashes ?? []).map((h) => `'${h}'`),
        ]),
        "style-src": withComponents("style-src", [
          "'self'",
          ...(inputs.inlineStyleHashes ?? []).map((h) => `'${h}'`),
        ]),
        "img-src": withComponents("img-src", ["'self'", "data:"]),
        "font-src": withComponents("font-src", ["'self'", ...(inputs.mathUsed ? ["data:"] : [])]),
        "connect-src": ["'self'", ...[...connectOrigins].sort()].join(" "),
        // Emitted only when something asked for them. `default-src 'none'` already denies
        // workers, frames and media by fallback, so a portal with no playground carries no
        // directive for any of them and is not widened by this feature existing.
        // `style-src-attr` is likewise absent unless the console is on screen.
        ...(componentDirectives.has("worker-src")
          ? { "worker-src": withComponents("worker-src", []) }
          : {}),
        ...(componentDirectives.has("frame-src")
          ? { "frame-src": withComponents("frame-src", []) }
          : {}),
        ...(componentDirectives.has("media-src")
          ? { "media-src": withComponents("media-src", []) }
          : {}),
        ...(componentDirectives.has("style-src-attr")
          ? { "style-src-attr": withComponents("style-src-attr", []) }
          : {}),
        "base-uri": "'none'",
        "form-action": "'self'",
        "frame-ancestors": "'none'",
      },
      ...(model.trustedSubsiteMounts.length
        ? {
            subsites: model.trustedSubsiteMounts.map((subsite) => ({
              mount: `${model.site.basePath.replace(/\/$/, "")}${subsite.mount}`,
              profile: subsite.profile,
              directives: {
                "default-src": "'self'",
                "script-src": ["'self'", ...subsite.inlineScriptHashes.map((h) => `'${h}'`)].join(
                  " ",
                ),
                "style-src": ["'self'", ...subsite.inlineStyleHashes.map((h) => `'${h}'`)].join(
                  " ",
                ),
                "img-src": "'self' data:",
                "font-src": "'self'",
                "connect-src": [
                  "'self'",
                  ...[...subsite.policy.runtime.connectOrigins].sort(compareCodePoints),
                ].join(" "),
                // `'self'` first, always: a documentation build that frames one of its own
                // pages is ordinary, the inventory permits it, and a policy of just the
                // declared origins would have the browser block it. `'none'` belongs here
                // only if a future profile forbids frames outright - a reviewed change to
                // STATIC_DOCS_V1_FRAMES_SELF, not a side effect of an empty list.
                "frame-src":
                  [
                    ...(STATIC_DOCS_V1_FRAMES_SELF ? ["'self'"] : []),
                    ...[...subsite.policy.runtime.frameOrigins].sort(compareCodePoints),
                  ]
                    .join(" ")
                    .trim() || "'none'",
                "worker-src": subsite.policy.runtime.workers === "self" ? "'self'" : "'none'",
                "base-uri": "'none'",
                // `'self'`, not `'none'`, for the same reason `frame-src` has `'self'`: a
                // subsite page framing a sibling is one document embedding another from the
                // same origin, which `frame-ancestors 'none'` on the embedded page forbids.
                // Cross-origin framing stays forbidden, which is what the directive is for.
                "frame-ancestors": STATIC_DOCS_V1_FRAMES_SELF ? "'self'" : "'none'",
              },
              inlineScriptHashes: subsite.inlineScriptHashes,
              inlineStyleHashes: subsite.inlineStyleHashes,
              workers: subsite.policy.runtime.workers,
            })),
          }
        : {}),
    },
    mimeTypes: Object.fromEntries(
      [...new Set(inputs.files.map((f) => f.path.slice(f.path.lastIndexOf("."))))]
        .filter((ext) => ext.startsWith("."))
        .sort()
        .map((ext) => [ext, inputs.files.find((f) => f.path.endsWith(ext))!.mimeType]),
    ),
    cache: { classes: CACHE_HEADERS },
    ...(authCallback
      ? {
          authCallback: {
            path: `${model.site.basePath.replace(/\/$/, "")}${authCallback}`,
            headers: {
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
              "X-Content-Type-Options": "nosniff",
            },
            accessLog: { redactQueryString: true },
          },
        }
      : {}),
  };
}

export function buildInfo(inputs: ManifestInputs, inputManifestJson: string): object {
  const { model } = inputs;
  return {
    schemaVersion: 1,
    builder: {
      name: model.buildIdentity.builderName,
      version: model.buildIdentity.builderVersion,
      purl: model.buildIdentity.builderPurl,
      ...(inputs.builderImage ? { image: { kind: "image", ...inputs.builderImage } } : {}),
      ...(inputs.sourceRevision ? { sourceRevision: inputs.sourceRevision } : {}),
    },
    schemas: {
      portal: { name: "portal.schema.json", digest: model.buildIdentity.schemaDigests.portal! },
      landing: { name: "landing.schema.json", digest: model.buildIdentity.schemaDigests.landing! },
      subsitePolicy: {
        name: "subsite-policy.schema.json",
        digest: model.buildIdentity.schemaDigests.subsitePolicy!,
      },
    },
    profile: { name: model.buildIdentity.profileName, digest: model.buildIdentity.profileDigest },
    ...(inputs.rstHelper
      ? {
          rstHelper: {
            protocol: inputs.rstHelper.protocol,
            package: inputs.rstHelper.package,
            version: inputs.rstHelper.version,
            docutils: inputs.rstHelper.docutils,
            used: inputs.rstUsed,
          },
        }
      : {}),
    inputManifestDigest: sha256(inputManifestJson),
    artifact: {
      schemaVersion: 1,
      release: model.buildIdentity.release,
      sourceDateEpoch: model.buildIdentity.sourceDateEpoch,
      ...(model.buildIdentity.effectiveAt ? { effectiveAt: model.buildIdentity.effectiveAt } : {}),
    },
  };
}

export function checksumFile(files: { path: string; digest: string }[]): string {
  return (
    files
      .filter((f) => f.path !== "checksums.sha256")
      .sort((a, b) => compareCodePoints(a.path, b.path))
      .map((f) => `${f.digest.replace("sha256:", "")}  ${f.path}`)
      .join("\n") + "\n"
  );
}

export function digestOf(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function cacheClassFor(
  path: string,
  model: ResolvedPortalModel,
  statics: ResolvedStaticFile[],
): CacheClass {
  const known = statics.find((f) => f.file === path);
  if (known) return known.cacheClass;
  if (model.hostPolicy.authCallbackPath) {
    const callbackFile = `${model.hostPolicy.authCallbackPath.replace(/^\//, "")}index.html`;
    if (path === callbackFile) return "no-store";
  }
  for (const subsite of model.trustedSubsiteMounts) {
    if (path.startsWith(subsite.mount.replace(/^\//, ""))) return "subsite";
  }
  // The compiler content-hashes everything it writes under `_portal/`.
  if (/^_portal\//.test(path) && /\.[0-9a-zA-Z_-]{8}\./.test(path)) return "immutable";
  return "revalidate";
}
