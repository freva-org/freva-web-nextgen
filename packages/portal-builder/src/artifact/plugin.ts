// The Vite/Astro plugin.
//
// It does two jobs. It resolves the `virtual:portal-*` specifiers to the modules this build
// generated - the validated model, the compile-time island entry, the theme stylesheet, the
// STAC adapter - so no generated source is ever written into a consumer's repository. And it
// records the module graph and the copied files, the evidence the enable/disable contract is
// checked against.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphRecord, NormalizeContext } from "./evidence.js";
import { normalizeModuleId } from "./evidence.js";
import { compareCodePoints } from "../util/order.js";

export interface VirtualSources {
  /** Absolute path of the per-build generated-module directory. */
  generatedRoot: string;
  modelJson: string;
  entrySource: string;
  /**
   * The separate-origin playground's own entry. Always mapped, because the child page template
   * names the specifier and the compiler resolves a page's scripts whether or not that page
   * emits a document. A portal without a playground gets a module that imports nothing, which
   * makes its absence a property of the graph rather than of a build failure.
   */
  playgroundEntrySource: string;
  themeCss: string;
  codeCss: string;
  /**
   * Absolute path of the mathematics stylesheet, when a site rendered an equation. Mapping the
   * real file lets the compiler hash it and copy its fonts; a site without mathematics gets an
   * empty stylesheet instead.
   */
  mathCssPath?: string;
  /**
   * Absolute path of the STAC host stylesheet, when the STAC component is enabled. A portal
   * without STAC gets an empty stylesheet, so the artifact contains no rule naming the embed.
   */
  stacCssPath?: string;
  /**
   * Absolute path of the Data Browser host stylesheet, when that component is enabled. A
   * portal without it gets an empty stylesheet, so the artifact has no rule naming the mount.
   */
  databrowserCssPath?: string;
  stacAdapter?: string;
}

export interface PortalPluginResult {
  plugin: unknown;
  graph: GraphRecord;
}

interface MinimalBundleChunk {
  type: string;
  fileName: string;
  isEntry?: boolean;
  modules?: Record<string, { renderedLength?: number; code?: string | null }>;
  imports?: string[];
  dynamicImports?: string[];
  /** Vite's own record of the stylesheets it linked to this chunk. */
  viteMetadata?: { importedCss?: Set<string> | string[] };
}

/**
 * Bundler region banners: `//#region <path to the module>` and `//#endregion`. The bundler
 * brackets each module's rendered code with these while assembling a chunk. They never reach
 * the artifact - the emitted chunks are byte-identical without them - but they *are* counted
 * in `renderedLength`, and the path inside them is relative to the compiler root, so it
 * changes with the output directory and with where the repository is checked out. Counting
 * them makes a recorded size a function of the caller's filesystem: identical inputs built to
 * `/tmp/a` and `/tmp/aa` differ by one byte per module, so two different
 * `component-evidence.json` files and two different artifacts. Measuring with the banners
 * removed leaves the module's own bytes.
 */
const REGION_BANNER = /^\s*\/\/#(?:region|endregion)\b.*$/gm;

function renderedBytes(
  module: { renderedLength?: number; code?: string | null } | undefined,
): number | undefined {
  if (!module) return undefined;
  if (typeof module.code === "string") {
    return Buffer.byteLength(module.code.replace(REGION_BANNER, "").trim(), "utf8");
  }
  return typeof module.renderedLength === "number" ? module.renderedLength : undefined;
}

/**
 * Materialize the generated modules on disk and hand back a plugin that maps the `virtual:`
 * specifiers onto them. Real files rather than `\0`-prefixed virtual ids on purpose: Vite's
 * CSS and asset pipelines key off a real extension, and a stylesheet that silently fails to
 * be hashed is a caching bug nobody sees.
 */
export function createPortalPlugin(
  sources: VirtualSources,
  normalize: NormalizeContext,
): PortalPluginResult {
  const files: Record<string, string> = {
    "portal-model.js": `export default ${sources.modelJson};`,
    "portal-entry.js": sources.entrySource,
    "portal-theme.css": sources.themeCss,
    "portal-code.css": sources.codeCss,
  };
  if (!sources.mathCssPath) files["portal-math.css"] = "/* no mathematics on this site */\n";
  // The STAC host stylesheet is component-owned, so it is mapped to the real file only when
  // the component is enabled. A portal built without STAC ships a stylesheet that names
  // nothing: the enablement matrix reads the artifact bytes, and a rule that merely never
  // matches is still a shipped trace.
  if (!sources.stacCssPath) files["portal-stac.css"] = "/* no STAC embed on this site */\n";
  if (!sources.databrowserCssPath) {
    files["portal-databrowser.css"] = "/* no Data Browser embed on this site */\n";
  }
  if (sources.stacAdapter) files["stac-adapter.js"] = sources.stacAdapter;
  if (sources.playgroundEntrySource) {
    files["portal-playground-entry.js"] = sources.playgroundEntrySource;
  }

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(sources.generatedRoot, name), content, "utf8");
  }

  const mapping: Record<string, string> = {
    "virtual:portal-model": join(sources.generatedRoot, "portal-model.js"),
    "virtual:portal-entry": join(sources.generatedRoot, "portal-entry.js"),
    "virtual:portal-theme.css": join(sources.generatedRoot, "portal-theme.css"),
    "virtual:portal-code.css": join(sources.generatedRoot, "portal-code.css"),
    "virtual:portal-math.css":
      sources.mathCssPath ?? join(sources.generatedRoot, "portal-math.css"),
    "virtual:portal-stac.css":
      sources.stacCssPath ?? join(sources.generatedRoot, "portal-stac.css"),
    "virtual:portal-databrowser.css":
      sources.databrowserCssPath ?? join(sources.generatedRoot, "portal-databrowser.css"),
  };
  if (sources.stacAdapter) {
    mapping["virtual:portal-stac-adapter"] = join(sources.generatedRoot, "stac-adapter.js");
  }
  if (sources.playgroundEntrySource) {
    mapping["virtual:portal-playground-entry"] = join(
      sources.generatedRoot,
      "portal-playground-entry.js",
    );
  }

  const graph: GraphRecord = {
    chunks: [],
    modules: [],
    copiedFiles: [],
    moduleBytes: {},
    chunkModuleBytes: {},
  };
  const modules = new Set<string>();

  const plugin = {
    name: "freva-portal-builder",
    enforce: "pre" as const,
    resolveId(id: string) {
      return mapping[id];
    },
    generateBundle(_options: unknown, bundle: Record<string, MinimalBundleChunk>) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        const rawIds = Object.keys(chunk.modules ?? {});
        if (process.env.FREVA_PORTAL_DEBUG_GRAPH === "1") {
          for (const id of rawIds.slice(0, 8)) process.stderr.write(`[graph] ${id}\n`);
        }
        const chunkModules = rawIds.map((id) => normalizeModuleId(id, normalize)).sort();
        for (const moduleId of chunkModules) modules.add(moduleId);
        // Per-module rendered size, so a shared chunk is attributed to the components that
        // contributed to it rather than charged whole to each. Per chunk, because only some
        // of these chunks reach the artifact and the rest must not be counted.
        const perChunk: Record<string, number> = graph.chunkModuleBytes[chunk.fileName] ?? {};
        for (const id of rawIds) {
          const bytes = renderedBytes(chunk.modules?.[id]);
          if (bytes !== undefined) {
            const key = normalizeModuleId(id, normalize);
            perChunk[key] = (perChunk[key] ?? 0) + bytes;
          }
        }
        graph.chunkModuleBytes[chunk.fileName] = perChunk;
        const css = chunk.viteMetadata?.importedCss;
        graph.chunks.push({
          file: chunk.fileName,
          isEntry: Boolean(chunk.isEntry),
          modules: [...new Set(chunkModules)],
          imports: [...(chunk.imports ?? [])].sort(compareCodePoints),
          dynamicImports: [...(chunk.dynamicImports ?? [])].sort(compareCodePoints),
          css: [...(css ?? [])].sort(compareCodePoints),
        });
      }
      graph.chunks.sort((a, b) => compareCodePoints(a.file, b.file));
      graph.modules = [...modules].sort();
    },
  };

  return { plugin, graph };
}

/**
 * The STAC adapter's `virtual:portal-stac-adapter` import must still resolve when STAC is
 * disabled *if* anything references it. Nothing does - the island is imported by the generated
 * entry only when the component is enabled - so a missing mapping here is the intended failure
 * rather than a silent empty module.
 */
export const STAC_ADAPTER_SPECIFIER = "virtual:portal-stac-adapter";
