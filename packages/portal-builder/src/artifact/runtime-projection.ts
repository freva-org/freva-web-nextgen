// The public projection and the compile-time component entry.
//
// The entry is generated with *literal* imports for the enabled components only. A runtime
// lookup table containing every component would be simpler to write and would defeat the
// point: the bundler cannot drop what it cannot prove unused, so a disabled component would
// still ship.

import { join } from "node:path";
import { PACKAGE_ROOT } from "../util/package.js";
import type {
  AuthOptions,
  DatabrowserOptions,
  ResolvedPortalModel,
  ResolvedService,
} from "../model/types.js";

export interface RuntimeProjection {
  siteId: string;
  basePath: string;
  databrowser?: {
    id: string;
    mountId: string;
    apiBase: string;
    flavour: string;
    fixedFacets: Record<string, string | string[]>;
    defaultLayout: "browse" | "overview";
    overview: { order: string[]; mainFacets: string[] | null };
    scopeRemovable: boolean;
    authentication: "none" | "optional" | "required";
  };
  stac?: { id: string; mountId: string };
  /** Present only when a footer badge was configured. */
  footerBadge?: { kind: string; quality: string };
  /**
   * Present only when the theme asks for a drawn backdrop. A preset that does not ask leaves
   * this undefined and the module is never imported, which is how a `default` build is proved
   * to contain none of it.
   */
  backdrop?: { kind: "contour" | "cosmos" };
  /**
   * Present only when a landing actually carries a `dataset-tree` block. It names the block
   * instances rather than counting them, so the generated module reads as a description of the
   * page and a reviewer can see which landing asked for what. The island still finds its hosts
   * in the DOM: the catalogue is embedded next to each one, and putting it here as well would
   * duplicate a quarter of a megabyte into the entry bundle.
   */
  datasetTree?: {
    instances: string[];
    /**
     * Which SOURCE modes this portal's blocks actually use. The entry imports one loader module
     * per mode in use and no others, because a module that merely MENTIONS
     * `@freva-org/dataset-tree/s3` puts an object-store client in the bundle, and a portal
     * serving a build-time catalogue has to prove it ships none. A page may legitimately have
     * one block of each, so this is two flags rather than one word.
     */
    snapshot: boolean;
    s3: boolean;
  };
  /**
   * Present only when a dataset-tree block asked for a Python playground. Separate from
   * `datasetTree` because the two are enabled separately, and because this flag decides whether
   * an interpreter reaches the bundle at all. It names the instances rather than carrying the
   * configuration: that is already on each block's host element, and duplicating it here would
   * put a second copy of every digest in the entry chunk.
   */
  pythonPlayground?: {
    instances: string[];
    /**
     * Whether the interpreter runs on a SEPARATE origin. The one piece of playground
     * configuration that has to be here rather than on the block's host element, because it
     * decides which module the entry imports - and an import is decided when the entry is
     * written, not when a visitor presses something.
     */
    framed: boolean;
    /**
     * Whether any page of this portal has a runnable code block. Decides whether the entry
     * imports the content provider at all; because a module that merely MENTIONS a specifier
     * ships it, a portal whose playground is only a dataset tree's carries no runnable-code
     * module in its graph.
     */
    content: boolean;
  };
  auth?: {
    id: string;
    authBaseUrl: string;
    redirectUri: string;
    expectedIssuer?: string;
    allowedResourceOrigins: string[];
    callbackPath: string;
    basePath: string;
  };
}

/** Fixed by the prepared STAC patch set; the generated route must match it. */
export const STAC_MOUNT_ID = "stac-browser-mount";

function serviceFor(
  model: ResolvedPortalModel,
  id: string | undefined,
): ResolvedService | undefined {
  return id ? model.services.find((s) => s.id === id) : undefined;
}

/** Only enabled components contribute; nothing else reaches the browser. */
export function projectRuntime(model: ResolvedPortalModel): RuntimeProjection {
  const projection: RuntimeProjection = {
    siteId: model.site.id,
    basePath: model.site.basePath,
  };

  if (model.theme.backdrop) {
    projection.backdrop = { kind: model.theme.backdrop };
  }

  // Blocks, not components: a landing is scanned for them, because that is where the decision to
  // ship this code is actually made.
  const datasetTreeInstances = model.landings
    .flatMap((landing) => landing.blocks)
    .filter((block) => block.type === "dataset-tree" && block.datasetTree)
    .map((block) => block.datasetTree!.instanceId)
    .sort();
  if (datasetTreeInstances.length > 0) {
    const modes = model.landings
      .flatMap((landing) => landing.blocks)
      .map((block) => block.datasetTree?.mode)
      .filter((mode): mode is "snapshot" | "s3" => Boolean(mode));
    projection.datasetTree = {
      instances: datasetTreeInstances,
      snapshot: modes.includes("snapshot"),
      s3: modes.includes("s3"),
    };
  }

  const pythonInstances = model.landings
    .flatMap((landing) => landing.blocks)
    .filter((block) => block.type === "dataset-tree" && block.datasetTree?.python)
    .map((block) => block.datasetTree!.instanceId)
    .sort();
  // A page with a runnable snippet is a playground too, tree or no tree. `route.python` is set
  // only for pages that actually registered something, so a portal that enables
  // `pythonPlayground` and marks nothing produces no projection here and therefore no import,
  // no chunk, no Worker and no widened policy - the guarantee the absence tests check from the
  // built artifact. `?? []` because a test may hand `projectRuntime` a partial model: routes
  // are the artifact's, not the projection's, and throwing on a model without them would test
  // the fixture rather than the projection.
  const runnableContent = (model.routes ?? []).some((route) => Boolean(route.python));
  if (pythonInstances.length > 0 || runnableContent) {
    projection.pythonPlayground = {
      instances: pythonInstances,
      framed: Boolean(model.playground),
      content: runnableContent,
    };
  }

  if (model.chrome.footer.badge) {
    projection.footerBadge = {
      kind: model.chrome.footer.badge.kind,
      quality: model.chrome.footer.badge.quality,
    };
  }

  for (const component of model.enabledComponents) {
    const service = serviceFor(model, component.serviceId);
    if (component.kind === "databrowser" && service) {
      const options = component.options as DatabrowserOptions;
      projection.databrowser = {
        id: component.id,
        mountId: "portal-databrowser-mount",
        apiBase: service.url,
        flavour: options.defaultFlavour,
        fixedFacets: options.fixedFacets,
        defaultLayout: options.defaultLayout,
        overview: options.overview,
        scopeRemovable: options.scopeRemovable,
        authentication: service.authentication,
      };
    }
    if (component.kind === "stac-browser") {
      projection.stac = { id: component.id, mountId: STAC_MOUNT_ID };
    }
    if (component.kind === "auth" && service) {
      const options = component.options as AuthOptions;
      projection.auth = {
        id: component.id,
        authBaseUrl: service.url,
        redirectUri: options.redirectUri,
        ...(options.expectedIssuer ? { expectedIssuer: options.expectedIssuer } : {}),
        allowedResourceOrigins: options.bearerResourceOrigins,
        callbackPath: options.callbackPath,
        basePath: model.site.basePath,
      };
    }
  }

  return projection;
}

const CLIENT = (file: string): string => JSON.stringify(join(PACKAGE_ROOT, "client", file));

/**
 * The generated island entry. Its shape is deliberately boring: literal imports,
 * one branch for the technical callback route, no dynamic component lookup.
 */
export function generateEntryModule(model: ResolvedPortalModel): string {
  const projection = projectRuntime(model);
  const lines: string[] = [
    "// Generated by @freva-org/portal-builder. Literal imports only: what is not",
    "// imported here cannot be in the bundle, which is how a disabled component is",
    "// proved absent rather than merely hidden.",
    `import { initShell } from ${CLIENT("shell.ts")};`,
    `import { initCodeCopy } from ${CLIENT("code-copy.ts")};`,
  ];

  if (projection.auth) {
    lines.push(`import { createAuth } from ${CLIENT("components/auth.ts")};`);
    lines.push(`import { runAuthCallback } from ${CLIENT("components/auth-callback.ts")};`);
  }
  if (projection.databrowser) {
    lines.push(`import { mountDatabrowserIsland } from ${CLIENT("components/databrowser.ts")};`);
    // The landing box's suggestion list is Data-Browser-owned too: it ranks with that
    // package's ranker and reads that service. With the component disabled there is no box to
    // enhance, and nothing of it is imported.
    lines.push(`import { initSearchSuggestions } from ${CLIENT("search-box.ts")};`);
  }
  if (projection.stac) {
    lines.push(`import { mountStacIsland } from ${CLIENT("components/stac.ts")};`);
  }
  if (projection.footerBadge) {
    lines.push(`import { mountFooterBadge } from ${CLIENT("components/footer-badge.ts")};`);
  }
  // The dataset tree is reached through a LITERAL DYNAMIC import, and only because a landing
  // block asked for it; a portal without the block emits no such line at all, which
  // `tests/artifact/dataset-tree-block.test.ts` checks against the built output. Dynamic
  // because there is one client entry for the whole site, so a static import puts the island -
  // and its stylesheet's bytes, since the package ships CSS as a string - into the chunk every
  // page loads, including the 404 document: 17,638 bytes of CSS and about as much JavaScript
  // again on a consumer-shaped fixture. The import sits behind a check for a block on THIS
  // page, below, and `import()` with a literal specifier keeps the evidence rule intact.
  //
  // The playground's own literal import is a STYLESHEET-ONLY one on purpose: the coordinator
  // is reached through a dynamic `import()` in the dataset-tree island, on the first press,
  // so the interpreter and the terminal are downloaded only by the visitors who ask. What has
  // to be here is the decision - a build whose landings asked for no playground does not emit
  // this line, so the module and everything behind it is not in the graph at all, which is
  // what `python-playground.test.ts` checks.
  //
  // ONE LOADER PER SOURCE MODE IN USE, named literally.
  // `@freva-org/dataset-tree/snapshot` and `/s3` are separate entry points precisely so a
  // portal can prove which one it has; a single module branching between them at run time
  // would put both in every build's graph. What is not named here is not in the bundle, which
  // `tests/artifact/dataset-tree-block.test.ts` checks against the emitted chunks.
  if (projection.datasetTree?.snapshot) {
    lines.push(
      `import { loadSnapshotSource } from ${CLIENT("components/tree-source-snapshot.ts")};`,
    );
  }
  if (projection.datasetTree?.s3) {
    lines.push(`import { loadS3Source } from ${CLIENT("components/tree-source-s3.ts")};`);
  }
  if (projection.datasetTree) {
    // In the IMPORT section, like its two siblings: `import` is only legal at the top level,
    // so pushing this into the body below would not parse.
    lines.push(`import { loadInspector } from ${CLIENT("components/tree-inspector-loader.ts")};`);
  }
  if (projection.pythonPlayground) {
    lines.push(`import { preparePythonPlayground } from ${CLIENT("components/python-ready.ts")};`);
    // ONE of the two chunk loaders, chosen here because the topology is configuration. A
    // single module holding both `import()` calls behind an `if` is correct at run time and
    // worthless as evidence: naming `@freva-org/browser-python/console` anywhere in a module
    // puts the console, jQuery Terminal and Prism in that build's graph whether the branch
    // runs or not, so the parent of a two-origin playground would serve a third of a megabyte
    // it never uses. One literal specifier makes "the framed parent's graph contains no
    // console" a checkable property of the artifact.
    lines.push(
      projection.pythonPlayground.framed
        ? `import { loadFramedChunks } from ${CLIENT("components/python-chunks-framed.ts")};`
        : `import { loadLocalChunks } from ${CLIENT("components/python-chunks-local.ts")};`,
    );
    // Literal, and only when a page has one. See `RuntimeProjection.pythonPlayground.content`.
    if (projection.pythonPlayground.content) {
      lines.push(`import { mountRunnableCode } from ${CLIENT("components/code-run.ts")};`);
    }
  }
  // One branch per backdrop kind, each naming its own module literally. The guard is on the
  // KIND and not merely on "a backdrop exists": a generic guard would import the contour
  // module for a cosmos build, exactly the sort of leak the literal-import rule exists to stop.
  if (projection.backdrop?.kind === "contour") {
    lines.push(`import { mountContourBackdrop } from ${CLIENT("components/contour.ts")};`);
  }
  if (projection.backdrop?.kind === "cosmos") {
    lines.push(`import { mountCosmosBackdrop } from ${CLIENT("components/cosmos.ts")};`);
  }

  lines.push("", `const RUNTIME = ${JSON.stringify(projection, null, 2)};`, "");

  if (projection.auth) {
    lines.push(
      "// The callback route runs before anything else and scrubs its parameters as",
      "// its first client action.",
      'if (document.documentElement.dataset.portalRoute === "auth-callback" || document.body.dataset.portalRoute === "auth-callback") {',
      "  void runAuthCallback(RUNTIME.auth);",
      "} else {",
    );
  } else {
    lines.push("{");
  }

  lines.push("  initShell();");
  lines.push("  initCodeCopy();");
  if (projection.auth) lines.push("  const auth = createAuth(RUNTIME.auth);");
  if (projection.databrowser) {
    lines.push(
      projection.auth
        ? "  mountDatabrowserIsland(RUNTIME.databrowser, { auth });"
        : "  mountDatabrowserIsland(RUNTIME.databrowser);",
    );
  }
  if (projection.databrowser) lines.push("  initSearchSuggestions();");
  if (projection.stac) lines.push("  void mountStacIsland(RUNTIME.stac);");
  if (projection.footerBadge) lines.push("  void mountFooterBadge();");
  if (projection.datasetTree) {
    // The playground is prepared AFTER the mount RESOLVES, not beside it and not inside its
    // `.then`. `preparePythonPlayground()` reads the blocks the island registers,
    // synchronously, and does nothing when the register is empty. The island is a dynamic
    // import, so calling the two as siblings leaves the register empty; its mount is
    // asynchronous as well - a live block's adapter arrives through an import of its own - so
    // calling it inside the island's `.then` is one microtask too early, leaving no launcher
    // and a Try press that does nothing and says nothing. The order is expressed against the
    // thing that finishes: `mountDatasetTreeBlocks` returns a promise that settles when every
    // block on the page has mounted or failed, and the playground is prepared in ITS
    // continuation. `browser-tests/dataset-tree-overlay.mjs` catches a regression here,
    // because the symptom is a control that renders and does nothing.
    const loaderArgs = [
      projection.datasetTree.snapshot ? "snapshot: loadSnapshotSource" : "",
      projection.datasetTree.s3 ? "s3: loadS3Source" : "",
      // The inspector is offered to every dataset tree: a snapshot catalogue carries `inspect`
      // URLs too, and without this they are dead data. The heavy package stays behind the
      // loader's own dynamic import, so a page nobody presses Inspect on never fetches it.
      "inspector: loadInspector",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      '  if (document.querySelector("[data-portal-dataset-tree]")) {',
      `    void import(${CLIENT("components/dataset-tree.ts")})`,
      `      .then((m) => m.mountDatasetTreeBlocks({ ${loaderArgs} }))`,
    );
    if (projection.pythonPlayground) {
      // CONTENT FIRST, THEN THE TREES, THEN PREPARE. `mountRunnableCode` is synchronous work
      // over elements the document already contains, but it verifies each snippet's digest
      // with Web Crypto and so returns a promise. The tree mounts asynchronously and registers
      // inside that. `preparePythonPlayground` merges whatever has registered by the time it
      // runs, so it has to be last: a press that arrives before a source is registered is a
      // press the coordinator has to refuse.
      if (projection.pythonPlayground.content) {
        lines.push("      .then(() => mountRunnableCode())");
      }
      lines.push(
        projection.pythonPlayground.framed
          ? "      .then(() => preparePythonPlayground(loadFramedChunks));"
          : "      .then(() => preparePythonPlayground(loadLocalChunks));",
      );
    } else {
      lines[lines.length - 1] += ";";
    }
    lines.push("  }");
  } else if (projection.pythonPlayground) {
    // No tree block on any page of this portal: the runnable snippets are the only providers,
    // so the chain starts from them rather than from a mount that will not happen.
    const prepare = projection.pythonPlayground.framed
      ? "preparePythonPlayground(loadFramedChunks)"
      : "preparePythonPlayground(loadLocalChunks)";
    if (projection.pythonPlayground.content) {
      lines.push(`  void mountRunnableCode().then(() => ${prepare});`);
    } else {
      lines.push(`  ${prepare};`);
    }
  }
  if (projection.backdrop?.kind === "contour") lines.push("  mountContourBackdrop();");
  // The Cosmos island is small; the scene kernel behind it is not, so the island fetches that
  // itself, only once it has found a Cosmos canvas on the page.
  if (projection.backdrop?.kind === "cosmos") lines.push("  mountCosmosBackdrop();");
  lines.push("}", "");

  return lines.join("\n");
}

/**
 * The generated entry for the SEPARATE-ORIGIN playground document, or `null`. One literal
 * import and one call, exactly like the portal's own entry and for the same reason: what is
 * not named here cannot be in the child's bundle. It is a different module from the portal's
 * entry and the two never import each other, which makes "the parent's graph contains no
 * console, no Worker and no interpreter" and "the child's graph contains no portal shell" two
 * facts a test can check against the built output rather than two intentions.
 */
export function generatePlaygroundEntryModule(model: ResolvedPortalModel): string {
  // An EMPTY module rather than no module when there is no playground origin. The child page
  // template names this specifier, and the compiler resolves every page's scripts whether or
  // not `getStaticPaths` emits an HTML file for it, so an unmapped specifier fails the build
  // for every portal without a playground. What matters is that the module imports nothing:
  // no client entry, no console, no interpreter, and the page it belongs to is not emitted.
  if (!model.playground) {
    return "// No separate-origin playground on this portal.\nexport {};\n";
  }
  return [
    "// Generated by @freva-org/portal-builder for the separate-origin playground.",
    "// Deployed to the configured playground origin, never served from the portal's.",
    `import { startPlaygroundOrigin } from ${CLIENT("playground-origin.ts")};`,
    "",
    "void startPlaygroundOrigin();",
    "",
  ].join("\n");
}
