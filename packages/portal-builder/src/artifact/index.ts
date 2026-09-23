// The build.
//
// Generation happens in a sibling temporary directory and the previous output is replaced
// atomically at the very end, so a failed build leaves the last good artifact exactly where it
// was - the property that lets CI run a build against a live document root without a
// maintenance window.

import { build as astroBuild } from "astro";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import type { DiagnosticBag } from "../diagnostics.js";
import { resolveModel, type ResolveOptions } from "../model/resolve.js";
import type { ResolvedPortalModel, ResolvedRoute } from "../model/types.js";
import { ASTRO_DIR, PACKAGE_ROOT, sha256 } from "../util/package.js";
import { compareCodePoints } from "../util/order.js";
import { buildEvidence, type GraphRecord } from "./evidence.js";
import {
  describePlaygroundDeployment,
  playgroundDeployReadme,
  type PlaygroundDeployment,
} from "./playground-deploy.js";
import { createPortalPlugin } from "./plugin.js";
import { generateEntryModule, generatePlaygroundEntryModule } from "./runtime-projection.js";
import {
  buildInfo,
  cacheClassFor,
  checksumFile,
  componentEvidenceManifest,
  hostPolicy,
  inputManifest,
  mimeForArtifactFile,
  portalManifest,
  type ArtifactFile,
  type ManifestInputs,
} from "./manifests.js";
import { validateAgainst } from "../config/schema.js";
import { checkBudgets } from "./budgets.js";
import type { ComponentEvidence } from "./evidence.js";
import { MATERIALS_MANIFEST } from "../model/python-materials.js";
import { containStylesheet } from "../components/stac-browser/containment.js";

export interface BuildOptions extends Omit<ResolveOptions, "outDir" | "temporaryDirs"> {
  outDir: string;
  /** Emitted into BUILDINFO/input-manifest when CI knows them. */
  builderImage?: ManifestInputs["builderImage"];
  sourceRevision?: string;
  publicEnvironment?: Record<string, string>;
  quiet?: boolean;
}

export interface BuildResult {
  diagnostics: DiagnosticBag;
  model?: ResolvedPortalModel;
  outDir?: string;
  files?: ArtifactFile[];
  graph?: GraphRecord;
  /**
   * What each component and feature owns in this artifact. Returned so a caller can measure
   * the build the way the build measures itself: the budget report attributes lazily loaded
   * chunks to the feature that pulled them in, and that attribution comes from here rather
   * than from a file-name guess.
   */
  evidence?: ComponentEvidence[];
  /**
   * How to deploy the separate-origin playground, when one was generated. Returned as well as
   * written, so a test can assert the file list is exact without re-deriving it - which would
   * only prove the test and the build agree with each other.
   */
  playgroundDeployment?: PlaygroundDeployment;
}

function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * Where the compiler is allowed to write while it works. Not next to `--out`: the compiler's
 * prerender step imports the modules it just emitted, and Node resolves those imports by
 * walking up from the *emitted file*, so a scratch directory with no `node_modules` above it
 * makes the builder's own dependencies unresolvable - the builder would then work only when
 * the output happened to sit inside an npm project, which a consumer cannot be expected to
 * know and is not true of `freva-portal-builder build --out /tmp/portal` from anywhere.
 * Working inside the installed package guarantees the resolution root is the package's own. If
 * that directory is read-only - a container that mounts it that way - the caller's own tree is
 * the fallback and the coupling comes back with it, which is why the preference is this way
 * round.
 */
function workingRoot(outDir: string): string {
  const inPackage = join(PACKAGE_ROOT, ".portal-build");
  try {
    mkdirSync(inPackage, { recursive: true });
    accessSync(inPackage, constants.W_OK);
    return mkdtempSync(join(inPackage, "build-"));
  } catch {
    return `${outDir}.work`;
  }
}

export async function buildSite(options: BuildOptions): Promise<BuildResult> {
  const outDir = options.outDir;
  const work = workingRoot(outDir);
  const tempOut = join(work, "artifact");
  const backup = `${outDir}.backup`;
  const generatedRoot = join(work, "generated");

  const resolved = await resolveModel({
    ...options,
    outDir,
    temporaryDirs: [tempOut, generatedRoot],
    // This resolution emits: a release build without a recorded epoch fails here.
    emitsArtifact: true,
  });

  const bag = resolved.diagnostics;
  if (!resolved.model || bag.failed(resolved.warningsAsErrors)) {
    return { diagnostics: bag };
  }
  const model = resolved.model;

  rmSync(backup, { recursive: true, force: true });
  mkdirSync(tempOut, { recursive: true });
  mkdirSync(generatedRoot, { recursive: true });

  // The resolved real root, because that is the path containment was proven against. Copying
  // through the configured path would re-open the symlink the verification just ruled out.
  const stacMaterialsRoot = resolved.stacAdapter?.materials.realRoot;
  const playgroundEntry = generatePlaygroundEntryModule(model);
  const { plugin, graph } = createPortalPlugin(
    {
      generatedRoot,
      modelJson: JSON.stringify(model),
      entrySource: generateEntryModule(model),
      playgroundEntrySource: playgroundEntry,
      themeCss: model.theme.css,
      codeCss: resolved.codeCss ?? "/* no highlighted code on this site */\n",
      ...(resolved.mathUsed ? { mathCssPath: mathStylesheet() } : {}),
      ...(model.enabledComponents.some((c) => c.kind === "databrowser")
        ? { databrowserCssPath: join(ASTRO_DIR, "src", "styles", "freva-databrowser.css") }
        : {}),
      ...(resolved.stacAdapter
        ? {
            stacAdapter: resolved.stacAdapter.source,
            stacCssPath: join(ASTRO_DIR, "src", "styles", "freva-stac.css"),
          }
        : {}),
    },
    {
      sourceRoot: options.sourceRoot,
      generatedRoot,
      ...(stacMaterialsRoot ? { stacMaterialsRoot } : {}),
    },
  );

  // An empty public directory: everything static is copied deliberately, with a
  // classification and a manifest entry, never by dropping files into `public/`.
  const emptyPublic = mkdtempSync(join(tmpdir(), "portal-public-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "portal-cache-"));

  // The compiler writes its own scratch tree (`.astro/`) relative to the *current directory*,
  // and its prerender step then imports the modules it emitted there. Node resolves those
  // imports by walking up from that file, so running the builder from a directory with no
  // `node_modules` above it leaves it unable to find its own dependencies. Standing in the
  // installed package for the compile fixes that; every path handed to the compiler is
  // already absolute, so nothing else changes meaning.
  const callerDirectory = process.cwd();
  process.chdir(PACKAGE_ROOT);
  try {
    await astroBuild({
      configFile: false,
      // The compiler root is the builder package, not the template directory: the island
      // sources live in `client/` and must resolve their dependencies from the package's own
      // `node_modules`, exactly as they will after an ordinary `npm install` of the builder.
      root: PACKAGE_ROOT,
      srcDir: join(ASTRO_DIR, "src"),
      publicDir: emptyPublic,
      outDir: tempOut,
      cacheDir,
      base: model.site.basePath,
      trailingSlash: "always",
      output: "static",
      // `_portal` rather than `assets`: a consumer legitimately mounts its own `/assets/`,
      // and two different cache classes must never share a directory.
      build: { format: "directory", assets: "_portal", inlineStylesheets: "never" },
      compressHTML: false,
      devToolbar: { enabled: false },
      logLevel: options.quiet ? "error" : "warn",
      vite: {
        logLevel: options.quiet ? "error" : "warn",
        plugins: [plugin as never],
        build: {
          sourcemap: false,
          // The interpreter's console, and the libraries only it uses, get a chunk of their
          // own. A MEASURED PROBLEM, not a preference: the bundler's runtime helpers are a
          // module like any other and land in whichever chunk it builds first - the
          // console's - and since every entry needs those helpers, every entry then
          // STATICALLY imports that chunk, so a portal whose playground runs on a separate
          // origin serves jQuery, jQuery Terminal, Prism and the whole console eagerly from
          // its own pages while the code that uses them runs elsewhere. Nothing in any source
          // file says so, only the emitted graph, which is why the check for it reads the
          // graph. Naming the console's own group fixes it, rather than naming the helpers',
          // whose id is synthetic and which the bundler declines to group: given a group of
          // its own the console can host nothing shared, and the helpers land in a chunk that
          // is nothing but plumbing, a static dependency every entry can afford. The list is
          // the console and its private dependencies, named because nothing else in a build
          // imports jQuery Terminal or Prism, so the group cannot take anything else with it.
          rollupOptions: {
            output: {
              advancedChunks: {
                groups: [
                  // A module BOTH halves need, kept out of the console's chunk.
                  // `transcript-limit.js` is one number - the console's output cap - and the
                  // embed protocol bounds its transcript messages by it, so the console and
                  // the bridge both import it. Left to itself the bundler puts it in the
                  // console's chunk, and the framed parent, which imports only the bridge,
                  // then statically imports the console again: the same failure as the
                  // runtime helpers through a different shared module. A group of its own is
                  // what makes it shareable.
                  {
                    name: "python-shared",
                    test: /[/\\]browser-python[/\\]dist[/\\]transcript-limit\./,
                  },
                  {
                    name: "python-console",
                    // The console is matched by its own path rather than by `node_modules/`:
                    // in a workspace checkout the package is a symlink whose real path has no
                    // `node_modules` in it at all. Splitting it from the libraries it uses is
                    // not merely untidy - Prism publishes itself as a global, so two chunks
                    // mean the console evaluates first and fails with `Prism is not defined`.
                    // One group, one chunk, one evaluation order.
                    test: /[/\\]browser-python[/\\]dist[/\\]console[/\\]|node_modules[/\\](?:jquery|jquery\.terminal|prismjs|wcwidth|clone|defaults)[/\\]/,
                  },
                ],
              },
            },
          },
        },
      },
    });
  } finally {
    process.chdir(callerDirectory);
    rmSync(emptyPublic, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }

  placeStatusPages(tempOut, model.routes);

  // Copy classified static material.
  const copiedFiles: string[] = [];
  for (const [file, bytes] of resolved.contents) {
    const target = join(tempOut, ...file.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    copiedFiles.push(file);
  }

  if (resolved.stacAdapter) {
    const materials = resolved.stacAdapter.materials;
    // The prepared tree is copied verbatim, EXCEPT its stylesheets, which are contained
    // first. Upstream's CSS is written for a document upstream owns - Bootstrap's reboot
    // styles `*`, `a`, `h1`-`h6`, `button`, `img` and `svg` by element name - and the portal
    // serves it into a document it shares with its own shell. `containStylesheet` narrows
    // every selector to the mount without changing its specificity;
    // `src/components/stac-browser/containment.ts` has the measurement and the reasoning
    // behind the two rewrite shapes. It happens HERE, at the copy, and not at any later step:
    // what lands in `tempOut` is what `collect()` hashes, budgets and writes into
    // `checksums.sha256`, so the contained bytes are the identified ones. A pass running
    // afterwards would leave the artifact's own verifier describing a file that is gone.
    const escapes: string[] = [];
    for (const entry of materials.manifest.files) {
      const target = join(tempOut, "stac", ...entry.path.split("/"));
      const source = join(materials.realRoot, ...entry.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      if (entry.path.endsWith(".css")) {
        const contained = containStylesheet(readFileSync(source, "utf8"));
        for (const selector of contained.escaped) escapes.push(`${entry.path}: ${selector}`);
        writeFileSync(target, contained.css);
      } else {
        cpSync(source, target);
      }
      copiedFiles.push(`stac/${entry.path}`);
    }
    if (escapes.length > 0) {
      // Assert the result rather than trust the rewrite. A selector that matches nothing is
      // silent in both directions, and so is one that still matches the shell: neither
      // complains when it is written. The pass is only worth having if a stylesheet it could
      // not contain stops the build instead of shipping.
      bag.add({
        code: "FP1606",
        severity: "error",
        message:
          `The prepared STAC stylesheet carries ${escapes.length} selector(s) that can still match ` +
          `outside the embed: ${escapes.slice(0, 5).join("; ")}${escapes.length > 5 ? "; …" : ""}.`,
        hint:
          "Those rules would restyle the portal's own header, navigation and prose. Either the " +
          "stylesheet used a selector shape the containment pass does not know, or it could not be " +
          "parsed at all.",
      });
    }
  }

  // The Python playground's materials, copied HERE, and the position is the whole point:
  // before `collect()`, before the manifests, before the budgets and before
  // `checksums.sha256`, so the wheels and add-on artefacts are hashed, listed, budgeted and
  // checksummed exactly like every other file in the artifact. Arriving later - copied in by
  // a deployment script after the builder finished - makes the artifact's own verifier report
  // `FP1603 freva-wheels/…whl: … is in the artifact but not in checksums.sha256`. Copying
  // them from the plan rather than from a directory listing is deliberate too: what lands in
  // the artifact is exactly what the pins say this configuration needs, so a materials
  // directory holding an extra add-on cannot smuggle it into a portal that did not ask.
  if (resolved.pythonMaterials) {
    const { realRoot, plan } = resolved.pythonMaterials;
    for (const file of plan.files) {
      const target = join(tempOut, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(realRoot, ...file.path.split("/")), target);
      copiedFiles.push(file.path);
    }
    // The preparation record travels with them. It is the only file here this build wrote
    // rather than fetched, and it says which configuration these artefacts were prepared for,
    // which is what makes an artifact self-describing about its own interpreter.
    const record = join(realRoot, MATERIALS_MANIFEST);
    if (existsSync(record)) {
      cpSync(record, join(tempOut, MATERIALS_MANIFEST));
      copiedFiles.push(MATERIALS_MANIFEST);
    }
  }

  graph.copiedFiles = [...copiedFiles].sort();

  // Astro compiles twice: once to render the pages and once for the browser. Only the second
  // is evidence about what a visitor downloads, and the honest way to tell them apart is to
  // keep the chunks that survived into the artifact rather than guess from a filename.
  graph.chunks = graph.chunks.filter((chunk) =>
    existsSync(join(tempOut, ...chunk.file.split("/"))),
  );
  graph.modules = [...new Set(graph.chunks.flatMap((chunk) => chunk.modules))].sort();
  // Sizes are summed over the surviving chunks only. Filtering an already summed total by
  // module id would keep the server pass's bytes for every module that also appears in the
  // browser bundle, so two identical builds in two different directories would differ.
  const sizes: Record<string, number> = {};
  for (const chunk of graph.chunks) {
    for (const [id, bytes] of Object.entries(graph.chunkModuleBytes[chunk.file] ?? {})) {
      sizes[id] = (sizes[id] ?? 0) + bytes;
    }
  }
  graph.moduleBytes = Object.fromEntries(
    Object.entries(sizes).sort(([a], [b]) => compareCodePoints(a, b)),
  );

  // Evidence, from the emitted file list as well as the graph: a Worker bundle is emitted
  // beside the graph rather than in it, and a disabled feature that left one behind would
  // otherwise pass every check.
  const evidence = buildEvidence([...model.componentEvidencePlan], graph, listFiles(tempOut));
  bag.merge(evidence.diagnostics);
  if (bag.failed(resolved.warningsAsErrors)) {
    rmSync(work, { recursive: true, force: true });
    return { diagnostics: bag };
  }

  // The separate-origin playground's deployment description, written BEFORE the manifests so
  // the two files it produces are themselves checksummed, budgeted and listed like everything
  // else in the artifact. A deployment description the artifact's own manifest did not cover
  // would be a file with no provenance.
  const deployment = describePlaygroundDeployment(
    model.playground,
    tempOut,
    graph,
    listFiles(tempOut),
  );
  if (deployment) {
    const dir = join(tempOut, "playground-origin");
    writeFileSync(join(dir, "deploy.json"), `${JSON.stringify(deployment, null, 2)}\n`, "utf8");
    writeFileSync(join(dir, "README.md"), playgroundDeployReadme(deployment), "utf8");
  }

  // Manifests.
  const statics = [...model.embeddableAssets, ...model.passiveDownloads, ...model.identityFiles];
  const collect = (): ArtifactFile[] =>
    listFiles(tempOut).map((path) => {
      const bytes = readFileSync(join(tempOut, ...path.split("/")));
      const known = statics.find((f) => f.file === path);
      return {
        path,
        bytes: bytes.byteLength,
        digest: sha256(bytes),
        mimeType: known?.mimeType ?? mimeForArtifactFile(path),
        cacheClass: cacheClassFor(path, model, statics),
        ...(known?.contentDisposition ? { contentDisposition: known.contentDisposition } : {}),
      };
    });

  // Astro inlines a small hoisted script rather than emitting a file: fine for delivery and
  // fatal for a CSP that only lists 'self', so the emitted HTML is read back and the literal
  // blocks are hashed into the policy. The artifact's CSP describes the artifact.
  const inline = collectInlineHashes(tempOut);

  const manifestInputs: ManifestInputs = {
    model,
    evidence,
    files: collect(),
    inlineScriptHashes: inline.scripts,
    inlineStyleHashes: inline.styles,
    // KaTeX's stylesheet carries its fonts as data: URLs, so the policy permits them only
    // when the artifact actually publishes it.
    mathUsed: resolved.mathUsed ?? false,
    rstUsed: resolved.rst.used,
    ...(resolved.rst.handshake ? { rstHelper: resolved.rst.handshake } : {}),
    ...(resolved.stacAdapter ? { stac: resolved.stacAdapter.materials } : {}),
    ...(options.builderImage ? { builderImage: options.builderImage } : {}),
    ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    ...(options.publicEnvironment ? { publicEnvironment: options.publicEnvironment } : {}),
  };

  const inputJson = `${JSON.stringify(inputManifest(manifestInputs), null, 2)}\n`;
  const write = (name: string, content: string): void =>
    writeFileSync(join(tempOut, name), content, "utf8");

  write("input-manifest.json", inputJson);
  write("portal-manifest.json", `${JSON.stringify(portalManifest(manifestInputs), null, 2)}\n`);
  write(
    "component-evidence.json",
    `${JSON.stringify(componentEvidenceManifest(evidence), null, 2)}\n`,
  );
  write("host-policy.json", `${JSON.stringify(hostPolicy(manifestInputs), null, 2)}\n`);
  write("BUILDINFO.json", `${JSON.stringify(buildInfo(manifestInputs, inputJson), null, 2)}\n`);

  // Our own manifests are validated against the published schemas: a manifest that does not
  // match its schema is a broken public contract, not a detail.
  for (const [name, schema] of [
    ["input-manifest.json", "inputManifest"],
    ["portal-manifest.json", "portalManifest"],
    ["component-evidence.json", "componentEvidence"],
    ["host-policy.json", "hostPolicy"],
    ["BUILDINFO.json", "buildinfo"],
  ] as const) {
    const parsed = JSON.parse(readFileSync(join(tempOut, name), "utf8")) as unknown;
    const result = validateAgainst(schema, parsed, name);
    bag.merge(result.diagnostics);
  }

  bag.merge(
    checkBudgets({
      files: manifestInputs.files,
      // The artifact itself is what says which assets a page asks for; see `budgets.ts`.
      artifactDir: tempOut,
      components: evidence.components,
      moduleBytes: graph.moduleBytes,
      preparedRoots: model.componentEvidencePlan.flatMap((plan) => plan.ownedStaticRoots),
      chunkEdges: graph.chunks,
    }),
  );

  const finalFiles = collect();
  write("checksums.sha256", checksumFile(finalFiles));

  if (bag.failed(resolved.warningsAsErrors)) {
    rmSync(work, { recursive: true, force: true });
    return { diagnostics: bag };
  }

  // Atomic publish: the previous artifact is moved aside first, so a failure here leaves
  // either the old tree or the new one, never a half-written mixture.
  if (existsSync(outDir)) renameSync(outDir, backup);
  mkdirSync(dirname(outDir), { recursive: true });
  try {
    renameSync(tempOut, outDir);
  } catch (error) {
    // The working root lives inside the installed package, often on a different filesystem
    // from `--out`; `rename` cannot cross one.
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(tempOut, outDir, { recursive: true });
  }
  rmSync(backup, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });

  const files = finalFiles.concat([
    {
      path: "checksums.sha256",
      bytes: statSync(join(outDir, "checksums.sha256")).size,
      digest: sha256(readFileSync(join(outDir, "checksums.sha256"))),
      mimeType: "text/plain; charset=utf-8",
      cacheClass: "revalidate",
    },
  ]);

  return {
    diagnostics: bag,
    model,
    outDir,
    files,
    graph,
    evidence: evidence.components,
    ...(deployment ? { playgroundDeployment: deployment } : {}),
  };
}

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
/**
 * `type` values a browser will actually execute. Everything else - `application/json`,
 * `application/ld+json`, `text/template` - is a data block: the browser never runs it, so
 * `script-src` never gates it, and hashing one would put a permission in the recorded policy
 * for something that needs none, with a hash that changes whenever the DATA changes, turning a
 * policy that describes the artifact's *code* into one that tracks its content. An absent or
 * empty `type` is a classic script, `module` is a script, and the two legacy JavaScript MIME
 * types are listed because they are still executed where they appear.
 */
const EXECUTABLE_SCRIPT_TYPES = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
  "importmap",
]);

function isExecutableScript(attributes: string): boolean {
  const type = /\btype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
  if (!type) return true;
  const value = (type[2] ?? type[3] ?? type[4] ?? "").trim().toLowerCase();
  return EXECUTABLE_SCRIPT_TYPES.has(value);
}
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

function collectInlineHashes(dir: string): { scripts: string[]; styles: string[] } {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  for (const path of listFiles(dir)) {
    if (!path.endsWith(".html")) continue;
    const text = readFileSync(join(dir, ...path.split("/")), "utf8");
    for (const match of text.matchAll(SCRIPT_BLOCK)) {
      const attrs = match[1] ?? "";
      const body = match[2] ?? "";
      if (/\bsrc\s*=/.test(attrs) || body.trim() === "") continue;
      if (!isExecutableScript(attrs)) continue;
      scripts.add(`sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
    }
    for (const match of text.matchAll(STYLE_BLOCK)) {
      const body = match[1] ?? "";
      if (body.trim() === "") continue;
      styles.add(`sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
    }
  }
  return { scripts: [...scripts].sort(), styles: [...styles].sort() };
}

/** The pinned engine's own stylesheet, resolved from the installed package. */
function mathStylesheet(): string {
  return createRequire(import.meta.url).resolve("katex/dist/katex.min.css");
}

export function artifactRelative(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

/**
 * Put each status document at the file name a host will ask for. Astro writes `/404` and
 * `/500` straight to `404.html` and `500.html` - it knows those two are status pages - and
 * every other route to `<pathname>/index.html`, because the build format is `directory`. A
 * host configured with `error_page 503 /503.html` wants a file at that exact path, so the rest
 * are moved and their now-empty directories removed. This is the only generated file the
 * builder renames, and it renames it to the name the route model already declared, so the
 * manifest, the checksums and the host policy all keep describing the artifact that exists.
 */
function placeStatusPages(root: string, routes: readonly ResolvedRoute[]): void {
  for (const route of routes) {
    if (route.kind !== "error") continue;
    const target = join(root, ...route.file.split("/"));
    if (existsSync(target)) continue;
    const directory = join(root, String(route.status));
    const generated = join(directory, "index.html");
    if (!existsSync(generated)) continue;
    renameSync(generated, target);
    rmSync(directory, { recursive: true, force: true });
  }
}
