// Normalizing the build graph into evidence.
//
// Two rules make this evidence worth anything. Module identity is *structured* - a package
// URL, a builder-relative path or a source-relative path - so the artifact never records the
// absolute path of somebody's laptop and two machines produce the same manifest. And absence
// is checked against the recorded graph and copy manifest, not against filenames: a disabled
// component's module can only arrive through a barrel, a CSS import or a shared chunk, and
// all three show up here.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Diagnostic } from "../diagnostics.js";
import { PACKAGE_ROOT } from "../util/package.js";
import type { ComponentEvidencePlan } from "../model/types.js";

export interface NormalizeContext {
  sourceRoot: string;
  /** Prepared STAC materials root, when STAC is enabled. */
  stacMaterialsRoot?: string;
  /** Where this build wrote its generated modules; never artifact identity. */
  generatedRoot?: string;
}

const packageCache = new Map<string, { name: string; version: string; dir: string } | undefined>();

/**
 * Walk up to the nearest `package.json` that names a package: one rule for `node_modules`, a
 * workspace symlink and a plain sibling checkout, instead of three path-shape heuristics.
 */
function owningPackage(file: string): { name: string; version: string; dir: string } | undefined {
  let current = dirname(file);
  const visited: string[] = [];
  for (;;) {
    const cached = packageCache.get(current);
    if (cached !== undefined || packageCache.has(current)) {
      for (const dir of visited) packageCache.set(dir, cached);
      return cached;
    }
    visited.push(current);
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name) {
          const found = { name: parsed.name, version: parsed.version ?? "0.0.0", dir: current };
          for (const dir of visited) packageCache.set(dir, found);
          return found;
        }
      } catch {
        // An unreadable package.json is not identity; keep walking up.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const dir of visited) packageCache.set(dir, undefined);
  return undefined;
}

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

/**
 * Turn a Rollup module id into a stable, caller-independent reference.
 * Anything that cannot be attributed becomes `unattributed:` rather than an
 * absolute path, so a manifest can never leak a temporary directory name.
 */
export function normalizeModuleId(id: string, ctx: NormalizeContext): string {
  const clean = id.replace(/^\0/, "").split("?")[0]!;

  if (clean.startsWith("virtual:")) return `builder:generated/${clean.slice("virtual:".length)}`;

  if (ctx.generatedRoot && clean.startsWith(ctx.generatedRoot)) {
    return `builder:generated/${toPosix(relative(ctx.generatedRoot, clean))}`;
  }

  if (ctx.stacMaterialsRoot && clean.startsWith(ctx.stacMaterialsRoot)) {
    return `stac-materials:${toPosix(relative(ctx.stacMaterialsRoot, clean))}`;
  }

  if (clean.startsWith(ctx.sourceRoot)) {
    return `source:${toPosix(relative(ctx.sourceRoot, clean))}`;
  }

  // The builder's own files, but not its installed dependencies.
  if (clean.startsWith(PACKAGE_ROOT) && !clean.includes(`${sep}node_modules${sep}`)) {
    return `builder:${toPosix(relative(PACKAGE_ROOT, clean))}`;
  }

  const owner = owningPackage(clean);
  if (owner) {
    return `pkg:npm/${owner.name.replace("@", "%40")}@${owner.version}#${toPosix(relative(owner.dir, clean))}`;
  }

  return `unattributed:${toPosix(clean).split("/").slice(-1)[0]}`;
}

export interface GraphRecord {
  chunks: {
    file: string;
    isEntry: boolean;
    modules: string[];
    /**
     * The chunks this one loads, static and dynamic, and the stylesheets the bundler linked to
     * it. Recorded so a transitive closure can be taken over the emitted files rather than
     * guessed from their names, which is what the separate-origin deployment list needs: that
     * list has to be exact in both directions, since a missing file is a playground that does
     * not start and a spare one is the portal's code served from the interpreter's origin.
     */
    imports?: string[];
    dynamicImports?: string[];
    css?: string[];
  }[];
  modules: string[];
  copiedFiles: string[];
  /**
   * Rendered bytes per module, summed over the chunks that survived into the artifact. Derived
   * from `chunkModuleBytes` after the server-render pass is discarded, never accumulated
   * across both compiles.
   */
  moduleBytes: Record<string, number>;
  /**
   * Rendered bytes per module, per emitting chunk. Astro compiles twice, and the server pass
   * embeds absolute source paths a browser never sees; summing both passes would make the
   * recorded sizes a function of where the repository is checked out, so two clean builds of
   * identical inputs in different directories would differ. Per-chunk attribution lets the sum
   * be taken over the chunks actually in the artifact, the only set that describes what a
   * visitor downloads. Build-time only: not part of `component-evidence.json`.
   */
  chunkModuleBytes: Record<string, Record<string, number>>;
}

export interface ComponentEvidence extends ComponentEvidencePlan {
  modules: string[];
  chunks: string[];
  copiedRoots: string[];
  copiedFiles: string[];
}

export interface EvidenceResult {
  components: ComponentEvidence[];
  graph: GraphRecord;
  diagnostics: Diagnostic[];
}

function ownedBy(plan: ComponentEvidencePlan, moduleId: string): boolean {
  return plan.ownedModuleRoots.some((root) => moduleId === root || moduleId.startsWith(root));
}

function copiedUnder(plan: ComponentEvidencePlan, file: string): boolean {
  return plan.ownedStaticRoots.some((root) => file === root || file.startsWith(`${root}/`));
}

/**
 * Build the evidence document and fail the build when a disabled component left anything
 * behind - the check D7 asks for; a CSS rule that hides the component satisfies none of it.
 */
export function buildEvidence(
  plans: ComponentEvidencePlan[],
  graph: GraphRecord,
  /**
   * Every file the compiler emitted, artifact-relative. Needed for `ownedEmittedNames`: a
   * Worker bundle is emitted BESIDE the module graph rather than in it, so neither
   * `graph.modules` nor `graph.chunks` mentions one, and a disabled feature that left an
   * interpreter's Worker in the artifact would otherwise pass every check here.
   */
  emittedFiles: readonly string[] = [],
): EvidenceResult {
  const diagnostics: Diagnostic[] = [];
  const components: ComponentEvidence[] = [];

  for (const plan of plans) {
    const modules = graph.modules.filter((m) => ownedBy(plan, m)).sort();
    const chunks = graph.chunks
      .filter((chunk) => chunk.modules.some((m) => ownedBy(plan, m)))
      .map((chunk) => chunk.file)
      .sort();
    const copiedFiles = graph.copiedFiles.filter((f) => copiedUnder(plan, f)).sort();
    const copiedRoots = plan.ownedStaticRoots.filter((root) =>
      graph.copiedFiles.some((f) => f === root || f.startsWith(`${root}/`)),
    );

    const emitted = (plan.ownedEmittedNames ?? []).flatMap((name) =>
      emittedFiles.filter(
        (file) => file.startsWith("_portal/") && file.slice("_portal/".length).startsWith(name),
      ),
    );

    if (!plan.enabled) {
      for (const file of emitted) {
        diagnostics.push({
          code: "FP1602",
          severity: "error",
          message:
            `Component '${plan.id}' is disabled but '${file}' was emitted into the artifact. ` +
            `A bundle the graph does not mention is still a bundle a reader can fetch.`,
        });
      }
      for (const moduleId of modules) {
        diagnostics.push({
          code: "FP1601",
          severity: "error",
          message:
            `Component '${plan.id}' is disabled but the module '${moduleId}' is in the build graph. ` +
            `A disabled component must leave no owned module behind, including through a barrel, a CSS import or a shared chunk.`,
        });
      }
      for (const file of copiedFiles) {
        diagnostics.push({
          code: "FP1602",
          severity: "error",
          message: `Component '${plan.id}' is disabled but '${file}' was copied into the artifact.`,
        });
      }
    }

    components.push({ ...plan, modules, chunks, copiedRoots, copiedFiles });
  }

  return { components, graph, diagnostics };
}
