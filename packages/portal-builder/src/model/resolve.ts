/**
 * Input graph to `ResolvedPortalModel`.
 *
 * Everything that can fail because of what a consumer wrote fails here, before a single output
 * byte exists: containment, schema, service semantics, component dependencies, route collisions,
 * announcement intervals, subsite policies and the whole content graph. What comes out is frozen,
 * and the generation stage that consumes it cannot reach back to the filesystem.
 */

import { readFileSync, realpathSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { BuildFailure, DiagnosticBag, type Diagnostic } from "../diagnostics.js";
import { loadYaml } from "../config/yaml.js";
import { validateAgainst, SCHEMA_FILES } from "../config/schema.js";
import {
  assertDisjointTrees,
  canonicalizeInRoot,
  canonicalizeIntended,
  normalizeSitePath,
  PathViolation,
  resolveContained,
  toPosix,
  type ContainedPath,
} from "../config/paths.js";
import type {
  LandingDocument,
  PortalConfig,
  RawComponent,
  RawDatasetTreePython,
  RawLandingBlock,
  RawLink,
  SubsitePolicyDocument,
} from "../config/types.js";
import { effectiveLimits, loadProfile } from "../rendering/profile.js";
import { sanitizeSvgFile } from "../rendering/svg.js";
import {
  ContentPipeline,
  discoverPages,
  type ContentSourceSpec,
  type FragmentRequest,
} from "../rendering/content.js";
import type { RstHandshake } from "../rendering/rst/client.js";
import { RouteCollision, RouteRegistry } from "../routes/derive.js";
import { STATUS_PAGES } from "./status-pages.js";
import { decideFooterBadge, publishFooterBadge } from "./footer-badge.js";
import { publishCosmosScene } from "./cosmos-scene.js";
import {
  DATASET_TREE_EVIDENCE,
  PYTHON_PLAYGROUND_EVIDENCE,
  liveDatasetTreeBlock,
  loadDatasetTreeCatalog,
  resolveDatasetTreeS3,
  resolvePlaygroundArtifact,
} from "./dataset-tree.js";
// The two constants the child artifact is generated against, taken from the package that owns
// them rather than restated: the protocol version is what the child's handshake offers and the
// parent checks, and the runtime URL is what the child's own CSP has to allow. A copy here would
// be a number that silently stops matching on a dependency bump.
import { DEFAULT_PYODIDE_INDEX_URL } from "@freva-org/browser-python";
import {
  planPythonMaterials,
  verifyPythonMaterials,
  type PythonMaterialsPlan,
} from "./python-materials.js";
import { resolvePlaygroundAssets, type PlaygroundAssetSources } from "./playground-assets.js";
import { resolvePackagePolicy } from "./package-policy.js";
import {
  checkPlaygroundAgreement,
  resolvePlaygroundSettings,
  type PlaygroundClaim,
} from "./python-playground.js";
import { EMBED_PROTOCOL_VERSION } from "@freva-org/browser-python/embed";
import { candidatesFrom, deriveSectionNavigation } from "./section-navigation.js";
import { registrationFor } from "../components/registry.js";
import { derivePathPrefix, generateAdapterModule } from "../components/stac-browser/adapter.js";
import {
  loadStacMaterials,
  verifyMaterials,
  type PreparedStacMaterials,
} from "../components/stac-browser/materials.js";
import { UNAPPLIED_TOKENS, resolveThemeCss, themeNames } from "../themes/registry.js";
import { collectMountedFiles, mimeForAsset, type MountedRoot } from "./assets.js";
import { collectSubsite } from "./subsites.js";
import { resolveLink, type LinkContext } from "./links.js";
import {
  normalizeAuthBase,
  normalizeDatabrowserBase,
  normalizeStacCatalogUrl,
  parseCanonicalUrl,
  siteFile,
  siteUrl,
} from "./urls.js";
import {
  deepFreeze,
  type AuthOptions,
  type ComponentEvidencePlan,
  type ComponentKind,
  type DatabrowserOptions,
  type DatasetTreeBlockData,
  type DatasetTreeS3Source,
  type InputRecord,
  type PlaygroundArtifactExample,
  type PythonPlaygroundData,
  type RegisteredContentExample,
  type RenderedFragment,
  type ResolvedAnnouncement,
  type ResolvedBlock,
  type ResolvedComponent,
  type ResolvedIdentityAsset,
  type ResolvedLanding,
  type ResolvedLink,
  type ResolvedPortalModel,
  type ResolvedRoute,
  type ResolvedService,
  type ResolvedStaticFile,
  type ResolvedSubsite,
  type SearchIntentV1,
  type StacOptions,
  type PlaygroundSettings,
} from "./types.js";
import { packageInfo, packagePurl, schemaDigest, sha256 } from "../util/package.js";
import { serializeSearchIntentV1 } from "@freva-org/databrowser/intent";
import { compareCodePoints } from "../util/order.js";
import { deriveNavOutline, nestHeadings } from "./nav-outline.js";

export interface ResolveOptions {
  /** Canonical trusted source root. */
  sourceRoot: string;
  /** Absolute path of `portal.yaml`, already contained. */
  configPath: string;
  /** Intended output tree; checked for disjointness before anything is created. */
  outDir?: string;
  /** Intended temporary and backup trees. */
  temporaryDirs?: string[];
  effectiveAt?: string;
  sourceDateEpoch?: number;
  /** `dev` relaxes exactly two things: loopback HTTP services and a wall clock. */
  dev?: boolean;
  release?: boolean;
  /**
   * True when this resolution will produce an artifact. `validate` reads and reports; only
   * `build` emits, and only an emitting release build needs a recorded timestamp.
   */
  emitsArtifact?: boolean;
  /**
   * The prepared STAC materials directory, named by whoever prepared it. Only an enabled
   * `stac-browser` component reads it. An argument rather than a lookup, so a build consumes the
   * tree this deployment prepared and not one left at a well-known path by a previous run.
   */
  stacMaterialsDir?: string;
  /**
   * The prepared Python playground materials, named by whoever prepared them. The same contract
   * as {@link ResolveOptions.stacMaterialsDir}, for the same reason: a build that went looking
   * for a well-known directory would happily ship last week's wheels. Absent unless stated, and a
   * playground that needs files this build was not given is a diagnostic with a named remedy
   * rather than a silent fallback to a URL on somebody else's CDN.
   */
  pythonMaterialsDir?: string;
  /**
   * Answer questions about the configuration without needing prepared STAC materials. Used by
   * `stac-plan` and by nothing that emits: the plan's job is to say whether the preparation stage
   * has to run, so it cannot need that stage's output. Everything else is still resolved and
   * reported, so a plan is only produced for a portal that would otherwise build.
   */
  skipStacMaterials?: boolean;
}

// The name a route shows, when the deployment already stated one. A component route carries
// three: the page title in the shell and the browser tab, the chrome title the mounted
// application draws in its own header, and - for STAC - the title the portal projects onto the
// root document. Untied, one page ends up with three names, and the only one a search engine or a
// browser tab shows is the framework's generic default. The registry default is the last resort:
// `title` on the component first, because naming the route is its only job, then the
// root-document title, then the application's chrome title. A deployment that states none still
// gets "Catalog".
function statedComponentTitle(raw: RawComponent): string | undefined {
  const options = raw.options as
    | { rootPage?: { title?: string }; chrome?: { title?: string } }
    | undefined;
  return options?.rootPage?.title ?? options?.chrome?.title;
}

/**
 * The same rule for the description, which is the meta description and the shell's summary.
 * `rootPage.intro` is deliberately not a source: it is rendered HTML for a region of the page, it
 * can be paragraphs long, and a meta description assembled by stripping its tags would be a
 * fabricated summary rather than a stated one.
 */
function statedComponentDescription(raw: RawComponent): string | undefined {
  const options = raw.options as { rootPage?: { description?: string } } | undefined;
  // The schema already refuses an empty string here, so there is no "stated nothing" value to
  // distinguish from an absent one.
  return options?.rootPage?.description;
}

export interface ResolveResult {
  model?: ResolvedPortalModel;
  diagnostics: DiagnosticBag;
  warningsAsErrors: boolean;
  /** Published bytes for every non-generated artifact file. */
  contents: Map<string, Buffer>;
  /** The highlighting stylesheet, when any code block was highlighted. */
  codeCss?: string;
  /** The generated STAC adapter module, when STAC is enabled. */
  stacAdapter?: { source: string; materials: PreparedStacMaterials };
  /** Whether any RST was rendered, and by which exact helper. */
  rst: { used: boolean; handshake?: RstHandshake };
  /** Whether the mathematics stylesheet has to be emitted. */
  mathUsed?: boolean;
  /**
   * The portal-level playground settings, as resolved - independent of whether any page uses one.
   * `model.playground` is a different thing: the separate-origin artifact's description, present
   * only for a portal that configured `playgroundOrigin`. What `prepare-playground` needs is the
   * configuration itself - which profile, which add-ons - so it can decide what to download for a
   * portal that has not been built yet and may have no runnable page at all.
   */
  portalPlayground?: PlaygroundSettings;
  /**
   * The verified Python materials this build will incorporate, when it was given any. `realRoot`
   * is the canonical directory - the path containment was proven against - so the copy cannot be
   * routed back through a symlink the check just ruled out.
   */
  pythonMaterials?: { realRoot: string; plan: PythonMaterialsPlan };
}

const CREDENTIAL_PATTERN =
  /(client[_-]?secret|password|passwd|api[_-]?key|secret[_-]?key|private[_-]?key|bearer\s+[A-Za-z0-9._-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i;

export async function resolveModel(opts: ResolveOptions): Promise<ResolveResult> {
  const bag = new DiagnosticBag();
  const contents = new Map<string, Buffer>();
  const inputs: InputRecord[] = [];
  const { profile, digest: profileDigest, name: profileName } = loadProfile();
  const sourceRoot = opts.sourceRoot;
  // The root is canonical (`canonicalizeRoot`); the configuration path arrives as the caller
  // spelled it. Bring it into the same namespace once, here, so every containment, disjointness
  // and relative-path computation below compares like with like on platforms whose temporary or
  // home directory is reached through a symlink.
  const configPath = canonicalizeInRoot(sourceRoot, opts.configPath);
  const configRel = toPosix(relativeTo(sourceRoot, configPath));

  const configBytes = readFileSync(configPath);
  inputs.push({
    path: configRel,
    role: "config",
    digest: sha256(configBytes),
    bytes: configBytes.byteLength,
  });

  const parsed = loadYaml<PortalConfig>(configBytes.toString("utf8"), configRel);
  bag.merge(parsed.diagnostics);
  if (!parsed.value)
    return { diagnostics: bag, warningsAsErrors: true, contents, rst: { used: false } };

  const schemaResult = validateAgainst("portal", parsed.value, configRel, parsed.positionOf);
  bag.merge(schemaResult.diagnostics);
  if (!schemaResult.valid)
    return { diagnostics: bag, warningsAsErrors: true, contents, rst: { used: false } };

  const config = parsed.value;
  const warningsAsErrors = config.rendering?.diagnostics?.warningsAsErrors ?? false;
  const limits = effectiveLimits(profile, config.rendering?.limits);

  // Reproducibility inputs. A release build that quietly used epoch 0 would still be reproducible
  // and still wrong: the archive timestamps would claim 1970 and nothing would say so. `validate`
  // does not emit an artifact, so it does not need one.
  if (opts.release && opts.emitsArtifact && opts.sourceDateEpoch === undefined) {
    bag.error(
      "FP1801",
      "A release build requires a numeric SOURCE_DATE_EPOCH (seconds since the Unix epoch).",
      {
        file: configRel,
        hint: 'Derive it from the commit, for example: SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)".',
      },
    );
  }

  // Retired runtime surface.
  reportRetiredFields(configBytes.toString("utf8"), configRel, bag);
  scanForCredentials(config, configRel, bag);

  // Canonical URL.
  const canonical = parseCanonicalUrl(config.site.canonicalUrl);
  if (!canonical.ok) {
    bag.error("FP1207", canonical.error ?? "Invalid site.canonicalUrl.", {
      file: configRel,
      pointer: "/site/canonicalUrl",
    });
    return { diagnostics: bag, warningsAsErrors, contents, rst: { used: false } };
  }

  // Containment.
  const contained = (
    declared: string,
    pointer: string,
    mustExist = true,
  ): ContainedPath | undefined => {
    try {
      return resolveContained(sourceRoot, configPath, declared, { mustExist });
    } catch (err) {
      if (err instanceof PathViolation) {
        bag.error(err.code, err.message, { file: configRel, pointer });
        return undefined;
      }
      throw err;
    }
  };

  /**
   * Every site-logical path in configuration goes through here, so an ambiguous
   * one becomes a diagnostic with a pointer rather than an exception.
   */
  const sitePath = (raw: string, pointer: string, what: string): string | undefined => {
    try {
      return normalizeSitePath(raw, what);
    } catch (err) {
      if (err instanceof PathViolation) {
        bag.error(err.code, err.message, { file: configRel, pointer });
        return undefined;
      }
      throw err;
    }
  };

  const inputRootsForDisjointness: { absolute: string; label: string }[] = [
    { absolute: configPath, label: `the configuration ${configRel}` },
  ];

  const contentSpecs: ContentSourceSpec[] = [];
  for (const [index, source] of (config.rendering?.sources ?? []).entries()) {
    const root = contained(source.root, `/rendering/sources/${index}/root`);
    if (!root) continue;
    const mount = sitePath(source.mount, `/rendering/sources/${index}/mount`, "content mount");
    if (!mount) continue;
    contentSpecs.push({
      root: { absolute: root.absolute, relative: root.relative, mount },
      include: source.files?.include ?? [],
      exclude: source.files?.exclude ?? [],
    });
    inputRootsForDisjointness.push({
      absolute: root.absolute,
      label: `content root ${root.relative}`,
    });
  }

  const assetRoots: MountedRoot[] = [];
  for (const [index, entry] of (config.rendering?.assets ?? []).entries()) {
    const root = contained(entry.root, `/rendering/assets/${index}/root`);
    if (!root) continue;
    const mount = sitePath(entry.mount, `/rendering/assets/${index}/mount`, "asset mount");
    if (!mount) continue;
    assetRoots.push({ absolute: root.absolute, relative: root.relative, mount });
    inputRootsForDisjointness.push({
      absolute: root.absolute,
      label: `asset root ${root.relative}`,
    });
  }

  const downloadRoots: MountedRoot[] = [];
  for (const [index, entry] of (config.rendering?.downloads ?? []).entries()) {
    const root = contained(entry.root, `/rendering/downloads/${index}/root`);
    if (!root) continue;
    const mount = sitePath(entry.mount, `/rendering/downloads/${index}/mount`, "download mount");
    if (!mount) continue;
    downloadRoots.push({ absolute: root.absolute, relative: root.relative, mount });
    inputRootsForDisjointness.push({
      absolute: root.absolute,
      label: `download root ${root.relative}`,
    });
  }

  // Complete the transitive input graph before checking disjointness. AR-001 says "every
  // transitive input, before any write", and the failure it prevents is destructive: a landing
  // file living below the requested output directory is discovered late, so a check over the
  // declared roots alone would pass and the atomic publish would replace the tree containing it.
  // This pass resolves paths and parses landing documents and reports nothing - an input it
  // cannot resolve is diagnosed by the authoritative pass below, and reporting twice is worse.
  const declaredLate = collectDeclaredInputs(sourceRoot, configPath, config);
  for (const entry of declaredLate) {
    inputRootsForDisjointness.push(entry);
  }

  // AR-001: output/temp/backup disjoint from every input, before any write.
  const outputTrees: { absolute: string; label: string }[] = [];
  if (opts.outDir)
    outputTrees.push({ absolute: canonicalizeIntended(opts.outDir), label: "the output tree" });
  for (const tmp of opts.temporaryDirs ?? []) {
    outputTrees.push({ absolute: canonicalizeIntended(tmp), label: "the temporary tree" });
  }
  outputTrees.push(
    ...(opts.outDir
      ? [{ absolute: canonicalizeIntended(`${opts.outDir}.backup`), label: "the backup tree" }]
      : []),
  );
  try {
    assertDisjointTrees(outputTrees, inputRootsForDisjointness);
  } catch (err) {
    if (err instanceof PathViolation) bag.error(err.code, err.message, { file: configRel });
    else throw err;
    return { diagnostics: bag, warningsAsErrors, contents, rst: { used: false } };
  }

  // Theme.
  const presetName = config.theme?.preset ?? "default";
  if (!themeNames().includes(presetName)) {
    bag.error(
      "FP1201",
      `Unknown theme preset '${presetName}'. Registered: ${themeNames().join(", ")}.`,
      {
        file: configRel,
        pointer: "/theme/preset",
      },
    );
    return { diagnostics: bag, warningsAsErrors, contents, rst: { used: false } };
  }
  const theme = resolveThemeCss(presetName, config.theme?.tokens);
  // A token the schema accepts, the build reports nothing about, and the stylesheet never sees.
  // Four of the seven colour tokens drive properties the design owns in both themes, and the
  // resolver drops them; without this a deployment sets `colorSurface`, sees a clean build, and
  // has no way to learn the value went nowhere.
  for (const token of theme.unapplied) {
    bag.warn(
      "FP1212",
      `Theme token '${token}' is accepted by the schema but not applied: '${UNAPPLIED_TOKENS[token]}' is the design's in both themes, and a preset value written for one theme would repaint the other.`,
      {
        file: configRel,
        pointer: `/theme/tokens/${token}`,
        hint: "Remove it, or change the preset. The tokens that do reach the stylesheet are colorAccent, colorAccentContrast and colorBorder.",
      },
    );
  }

  // Identity assets.
  const identityFiles: ResolvedStaticFile[] = [];
  const identity = (
    declared: string,
    pointer: string,
    name: "logo" | "favicon",
  ): ResolvedIdentityAsset | undefined => {
    const path = contained(declared, pointer);
    if (!path) return undefined;
    const bytes = readFileSync(path.absolute);
    const mime = mimeForAsset(path.absolute, profile);
    if (!mime) {
      bag.error(
        "FP1401",
        `Site ${name} '${path.relative}' is not on the embeddable MIME allowlist.`,
        {
          file: configRel,
          pointer,
        },
      );
      return undefined;
    }
    let published = bytes;
    let inline: string | undefined;
    if (extname(path.absolute).toLowerCase() === ".svg") {
      const result = sanitizeSvgFile(bytes, path.relative, profile);
      bag.merge(result.diagnostics);
      if (!result.ok) return undefined;
      published = Buffer.from(result.svg, "utf8");
      inline = result.svg;
    }
    const outFile = `identity/${name}${extname(path.absolute).toLowerCase()}`;
    contents.set(outFile, published);
    inputs.push({
      path: path.relative,
      role: "identity",
      digest: sha256(bytes),
      bytes: bytes.byteLength,
    });
    identityFiles.push({
      file: outFile,
      url: `${canonical.basePath}${outFile}`,
      source: path.relative,
      mimeType: mime,
      bytes: published.byteLength,
      digest: sha256(published),
      cacheClass: "revalidate",
      kind: "identity",
      ...(inline ? { sanitized: true } : {}),
    });
    return {
      url: `${canonical.basePath}${outFile}`,
      file: outFile,
      mimeType: mime,
      source: path.relative,
      ...(inline ? { inlineSvg: inline } : {}),
    };
  };

  const logo = identity(config.site.identity.logo, "/site/identity/logo", "logo");
  const favicon = identity(config.site.identity.favicon, "/site/identity/favicon", "favicon");

  // Assets and downloads.
  const assetResult = collectMountedFiles(assetRoots, {
    kind: "asset",
    basePath: canonical.basePath,
    canonicalUrl: canonical.canonicalUrl,
    profile,
    limits,
  });
  bag.merge(assetResult.diagnostics);
  for (const [file, bytes] of assetResult.contents) contents.set(file, bytes);
  inputs.push(...assetResult.inputs);

  const downloadResult = collectMountedFiles(downloadRoots, {
    kind: "download",
    basePath: canonical.basePath,
    canonicalUrl: canonical.canonicalUrl,
    profile,
    limits,
  });
  bag.merge(downloadResult.diagnostics);
  for (const [file, bytes] of downloadResult.contents) contents.set(file, bytes);
  inputs.push(...downloadResult.inputs);

  // Trusted subsites.
  const subsites: ResolvedSubsite[] = [];
  for (const [index, declared] of (config.trustedSubsites ?? []).entries()) {
    const tree = contained(declared.source, `/trustedSubsites/${index}/source`);
    const policyPath = contained(declared.policy, `/trustedSubsites/${index}/policy`);
    if (!tree || !policyPath) continue;
    const policyBytes = readFileSync(policyPath.absolute);
    const policyParsed = loadYaml<SubsitePolicyDocument>(
      policyBytes.toString("utf8"),
      policyPath.relative,
    );
    bag.merge(policyParsed.diagnostics);
    if (!policyParsed.value) continue;
    const policyValid = validateAgainst(
      "subsitePolicy",
      policyParsed.value,
      policyPath.relative,
      policyParsed.positionOf,
    );
    bag.merge(policyValid.diagnostics);
    if (!policyValid.valid) continue;
    inputs.push({
      path: policyPath.relative,
      role: "subsite-policy",
      digest: sha256(policyBytes),
      bytes: policyBytes.byteLength,
    });
    const subsiteMount = sitePath(
      declared.mount,
      `/trustedSubsites/${index}/mount`,
      "subsite mount",
    );
    if (!subsiteMount) continue;
    const result = collectSubsite(
      {
        absolute: tree.absolute,
        relative: tree.relative,
        mount: subsiteMount,
        policy: policyParsed.value,
        policySource: policyPath.relative,
        policyDigest: sha256(policyBytes),
      },
      profile,
      canonical.basePath,
    );
    bag.merge(result.diagnostics);
    inputs.push(...result.inputs);
    for (const [file, bytes] of result.contents) contents.set(file, bytes);
    if (result.subsite) subsites.push(result.subsite);
    inputRootsForDisjointness.push({
      absolute: tree.absolute,
      label: `trusted subsite ${tree.relative}`,
    });
  }

  // Announcements.
  const announcements = resolveAnnouncements(config, configRel, opts, bag);

  // Services.
  const services = new Map<string, ResolvedService>();
  for (const [id, raw] of Object.entries(config.services ?? {})) {
    const pointer = `/services/${id}`;
    if (raw.kind === "databrowser" || raw.kind === "auth") {
      const check =
        raw.kind === "databrowser"
          ? normalizeDatabrowserBase(raw.baseUrl ?? "", opts.dev ?? false)
          : normalizeAuthBase(raw.baseUrl ?? "", opts.dev ?? false);
      if (!check.ok) {
        bag.error("FP1205", `Service '${id}': ${check.error}`, {
          file: configRel,
          pointer: `${pointer}/baseUrl`,
        });
        continue;
      }
      services.set(id, {
        id,
        kind: raw.kind,
        url: check.value,
        origin: check.origin,
        authentication: raw.kind === "databrowser" ? (raw.authentication ?? "none") : "none",
      });
    } else {
      const check = normalizeStacCatalogUrl(raw.catalogUrl ?? "", opts.dev ?? false);
      if (!check.ok) {
        bag.error("FP1205", `Service '${id}': ${check.error}`, {
          file: configRel,
          pointer: `${pointer}/catalogUrl`,
        });
        continue;
      }
      services.set(id, {
        id,
        kind: "stac",
        url: check.value,
        origin: check.origin,
        authentication: "none",
      });
    }
  }

  // Components.
  const routes = new RouteRegistry();
  const componentList: ResolvedComponent[] = [];
  const usedServices = new Set<string>();
  const kindCount = new Map<ComponentKind, number>();
  let authComponent: ResolvedComponent | undefined;
  let stacMaterials: PreparedStacMaterials | undefined;

  const componentEntries = Object.entries(config.components ?? {}).sort(([a], [b]) =>
    compareCodePoints(a, b),
  );
  for (const [id, raw] of componentEntries) {
    const pointer = `/components/${id}`;
    const registration = registrationFor(raw.kind);
    const count = (kindCount.get(raw.kind) ?? 0) + 1;
    kindCount.set(raw.kind, count);
    if (raw.enabled && count > registration.maxInstances) {
      bag.error(
        "FP1209",
        `v1 permits at most ${registration.maxInstances} enabled instance of kind '${raw.kind}'; the current integrations use page-global state.`,
        { file: configRel, pointer },
      );
      continue;
    }

    let service: ResolvedService | undefined;
    if (raw.enabled) {
      if (!raw.service) {
        bag.error("FP1203", `Component '${id}' is enabled but references no service.`, {
          file: configRel,
          pointer,
        });
        continue;
      }
      service = services.get(raw.service);
      if (!service) {
        bag.error("FP1201", `Component '${id}' references the unknown service '${raw.service}'.`, {
          file: configRel,
          pointer: `${pointer}/service`,
        });
        continue;
      }
      if (service.kind !== registration.requiredServiceKind) {
        bag.error(
          "FP1204",
          `Component '${id}' of kind '${raw.kind}' requires a '${registration.requiredServiceKind}' service, but '${raw.service}' is a '${service.kind}' service.`,
          { file: configRel, pointer: `${pointer}/service` },
        );
        continue;
      }
      usedServices.add(service.id);
    }

    let route: string | undefined;
    if (registration.routed) {
      route = sitePath(
        raw.route ?? registration.defaultRoute ?? `/${id}/`,
        `${pointer}/route`,
        "component route",
      );
      if (!route) continue;
    }

    const component: ResolvedComponent = {
      id,
      kind: raw.kind,
      enabled: raw.enabled,
      ...(service ? { serviceId: service.id } : {}),
      ...(route ? { route } : {}),
      title: raw.title ?? statedComponentTitle(raw) ?? registration.defaultTitle,
      description:
        raw.description ?? statedComponentDescription(raw) ?? registration.defaultDescription,
      options: {},
    };

    if (raw.kind === "databrowser") {
      const options: DatabrowserOptions = {
        defaultFlavour: raw.options?.defaultFlavour ?? "freva",
        fixedFacets: raw.options?.fixedFacets ?? {},
        // Every default here is what the widget does when told nothing, so a portal that states
        // none of them is byte-identical to one built before these existed.
        defaultLayout: raw.options?.defaultLayout ?? "browse",
        overview: {
          order: raw.options?.overview?.order ?? [],
          // null, not [] - an empty list would mean "no main blocks at all", while the absence of
          // the option means "whatever the service calls primary".
          mainFacets: raw.options?.overview?.mainFacets ?? null,
        },
        scopeRemovable: raw.options?.scopeRemovable ?? false,
      };
      component.options = options;
      if (raw.enabled && service?.authentication === "required") {
        const authEnabled = componentEntries.some(
          ([, other]) => other.kind === "auth" && other.enabled,
        );
        if (!authEnabled) {
          bag.error(
            "FP1203",
            `Service '${service.id}' declares authentication: required, so an auth component must be enabled.`,
            { file: configRel, pointer: `${pointer}/service` },
          );
        }
      }
    } else if (raw.kind === "stac-browser") {
      // A component-owned image, validated always and published only when the component is on.
      // Written once because there are two kinds - the chrome image, and a mark beside a
      // provider's name - with identical requirements: an embeddable type, an SVG through the
      // sanitizer, a hashed copy under `identity/`, an input-manifest entry. Two copies is how
      // the second one ends up missing the sanitizer call.
      const publishComponentImage = (
        relativePath: string,
        imagePointer: string,
        outPrefix: string,
        what: string,
      ): string | undefined => {
        const image = contained(relativePath, imagePointer);
        if (!image) return undefined;
        const bytes = readFileSync(image.absolute);
        const mime = mimeForAsset(image.absolute, profile);
        if (!mime) {
          bag.error("FP1401", `${what} '${image.relative}' is not an embeddable asset type.`, {
            file: configRel,
            pointer: imagePointer,
          });
          return undefined;
        }
        let published = bytes;
        if (extname(image.absolute).toLowerCase() === ".svg") {
          const result = sanitizeSvgFile(bytes, image.relative, profile);
          bag.merge(result.diagnostics);
          if (result.ok) published = Buffer.from(result.svg, "utf8");
        }
        if (!raw.enabled) return undefined;
        const outFile = `identity/${outPrefix}${basename(image.relative)}`;
        contents.set(outFile, published);
        inputs.push({
          path: image.relative,
          role: "component-asset",
          digest: sha256(bytes),
          bytes: bytes.byteLength,
        });
        identityFiles.push({
          file: outFile,
          url: `${canonical.basePath}${outFile}`,
          source: image.relative,
          mimeType: mime,
          bytes: published.byteLength,
          digest: sha256(published),
          cacheClass: "revalidate",
          kind: "identity",
        });
        return `${canonical.basePath}${outFile}`;
      };

      const chromeImage = raw.options?.chrome?.image
        ? contained(raw.options.chrome.image, `${pointer}/options/chrome/image`)
        : undefined;
      let imageUrl: string | undefined;
      if (chromeImage) {
        const bytes = readFileSync(chromeImage.absolute);
        const mime = mimeForAsset(chromeImage.absolute, profile);
        if (!mime) {
          bag.error(
            "FP1401",
            `STAC chrome image '${chromeImage.relative}' is not an embeddable asset type.`,
            {
              file: configRel,
              pointer: `${pointer}/options/chrome/image`,
            },
          );
        } else {
          let published = bytes;
          if (extname(chromeImage.absolute).toLowerCase() === ".svg") {
            const result = sanitizeSvgFile(bytes, chromeImage.relative, profile);
            bag.merge(result.diagnostics);
            if (result.ok) published = Buffer.from(result.svg, "utf8");
          }
          // Validated always; published only when the component is enabled. The validation has
          // to run either way: a configuration naming a missing, non-embeddable or hostile file
          // is wrong whether or not the component is switched on, and the sanitizer in particular
          // must see the file, so a disabled component cannot park an unscanned SVG in the tree.
          // But an artifact built for a deployment that did not ask for STAC must contain no file
          // attributable to STAC, and a published `identity/stac-*.svg` is exactly that.
          const outFile = `identity/stac-${basename(chromeImage.relative)}`;
          if (raw.enabled) {
            contents.set(outFile, published);
            inputs.push({
              path: chromeImage.relative,
              role: "component-asset",
              digest: sha256(bytes),
              bytes: bytes.byteLength,
            });
            identityFiles.push({
              file: outFile,
              url: `${canonical.basePath}${outFile}`,
              source: chromeImage.relative,
              mimeType: mime,
              bytes: published.byteLength,
              digest: sha256(published),
              cacheClass: "revalidate",
              kind: "identity",
            });
            imageUrl = `${canonical.basePath}${outFile}`;
          }
        }
      }
      const rawRoot = raw.options?.rootPage;
      const options: StacOptions = {
        chrome: {
          ...(raw.options?.chrome?.title ? { title: raw.options.chrome.title } : {}),
          ...(imageUrl ? { imageUrl } : {}),
          footerLinks: raw.options?.chrome?.footerLinks ?? [],
        },
        access: {
          externalCatalogs: "deny",
          // Normalized to origins, deduplicated and ordered, because this list is compared
          // against a tile URL's origin in the browser and merged into a CSP directive in the
          // artifact; a trailing path or a differing case would make the two disagree.
          basemapOrigins: [
            ...new Set(
              (raw.options?.access?.basemapOrigins ?? []).flatMap((origin) => {
                try {
                  return [new URL(origin).origin];
                } catch {
                  // The schema requires an https URL, so this is unreachable from validated
                  // configuration; dropping rather than throwing keeps a future schema relaxation
                  // from turning a bad string into a crash.
                  return [];
                }
              }),
            ),
          ].sort(compareCodePoints),
        },
        // The presentation overrides for the root catalogue. `intro` is a path and becomes
        // `introHtml` later, once the content pipeline has rendered and sanitized the fragment;
        // everything else is carried straight through, deduplicated where the schema permits
        // repeats. Absent means "use what the API returned": no title, description, licence,
        // provider or keyword here is fabricated - a value is present because a deployment wrote
        // it.
        rootPage: {
          ...(rawRoot?.title ? { title: rawRoot.title } : {}),
          ...(rawRoot?.description ? { description: rawRoot.description } : {}),
          ...(rawRoot?.keywords?.length
            ? {
                keywords: [...new Set(rawRoot.keywords.map((word) => word.trim()))].filter(Boolean),
              }
            : {}),
          ...(rawRoot?.license ? { license: rawRoot.license } : {}),
          ...(rawRoot?.providers?.length
            ? {
                providers: rawRoot.providers.map((provider, index) => {
                  // STAC has no provider logo, so this one is the portal's own: a local file,
                  // put through the same publication as the chrome image and projected onto the
                  // root document's provider entries, where the patched `Providers` view draws
                  // it. The alternative is a stylesheet keyed on each provider's URL, which a
                  // deployment has no way to ship.
                  const logo = provider.logo
                    ? publishComponentImage(
                        provider.logo,
                        `${pointer}/options/rootPage/providers/${index}/logo`,
                        "stac-provider-",
                        "STAC provider logo",
                      )
                    : undefined;
                  return {
                    name: provider.name,
                    ...(provider.url ? { url: provider.url } : {}),
                    ...(provider.roles?.length ? { roles: [...new Set(provider.roles)] } : {}),
                    ...(logo ? { logo } : {}),
                  };
                }),
              }
            : {}),
        },
        linkPolicy: {
          canonicalizeAdvertisedRoot: raw.options?.linkPolicy?.canonicalizeAdvertisedRoot ?? false,
          hiddenRelations: raw.options?.linkPolicy?.hiddenRelations ?? [],
          // Deduplicated, and normalized to the spelling a browser would produce, so the runtime
          // comparison is against the same shape on both sides.
          rootAliases: [
            ...new Set(
              (raw.options?.linkPolicy?.rootAliases ?? []).map((alias) => {
                try {
                  return new URL(alias).href;
                } catch {
                  return alias;
                }
              }),
            ),
          ],
        },
        historyMode: "hash",
        pathPrefix: derivePathPrefix(canonical.basePath, route ?? "/catalog/"),
        catalogUrl: service?.url ?? "",
      };
      component.options = options;
      if (raw.enabled && !opts.skipStacMaterials) {
        const loaded = loadStacMaterials(opts.stacMaterialsDir);
        for (const diagnostic of loaded.diagnostics) bag.add(diagnostic);
        if (loaded.materials) {
          bag.merge(verifyMaterials(loaded.materials));
          stacMaterials = loaded.materials;
        }
      }
    } else {
      const callbackPath = sitePath(
        raw.options?.callbackPath ?? "/auth/callback/",
        `${pointer}/options/callbackPath`,
        "auth callback path",
      );
      if (!callbackPath) continue;
      const credentialOrigins = new Set<string>();
      for (const s of services.values()) {
        if (s.kind === "databrowser" && s.authentication !== "none" && s.origin)
          credentialOrigins.add(s.origin);
        if (s.kind === "auth" && s.origin) credentialOrigins.add(s.origin);
      }
      for (const origin of raw.options?.additionalResourceOrigins ?? [])
        credentialOrigins.add(origin);
      const options: AuthOptions = {
        callbackPath,
        redirectUri: siteUrl(canonical.canonicalUrl, callbackPath),
        ...(raw.options?.expectedIssuer ? { expectedIssuer: raw.options.expectedIssuer } : {}),
        bearerResourceOrigins: [...credentialOrigins].sort(),
        additionalResourceOrigins: [...(raw.options?.additionalResourceOrigins ?? [])].sort(),
      };
      component.options = options;
      if (raw.enabled) authComponent = component;
    }

    componentList.push(component);
  }

  const components = new Map(componentList.map((c) => [c.id, c]));
  const enabledComponents = componentList.filter((c) => c.enabled);

  for (const [id] of services) {
    if (!usedServices.has(id)) {
      bag.info(
        "FP1206",
        `Service '${id}' is not referenced by an enabled component and is not emitted.`,
        {
          file: configRel,
          pointer: `/services/${id}`,
        },
      );
    }
  }

  // Landings.
  const landingDocs = new Map<string, { doc: LandingDocument; path: string; source: string }>();
  for (const [id, entry] of Object.entries(config.landings ?? {}).sort(([a], [b]) =>
    compareCodePoints(a, b),
  )) {
    const pointer = `/landings/${id}`;
    const file = contained(entry.source, `${pointer}/source`);
    if (!file) continue;
    const bytes = readFileSync(file.absolute);
    inputs.push({
      path: file.relative,
      role: "landing",
      digest: sha256(bytes),
      bytes: bytes.byteLength,
    });
    const doc = loadYaml<LandingDocument>(bytes.toString("utf8"), file.relative);
    bag.merge(doc.diagnostics);
    if (!doc.value) continue;
    const valid = validateAgainst("landing", doc.value, file.relative, doc.positionOf);
    bag.merge(valid.diagnostics);
    if (!valid.valid) continue;
    const landingPath = sitePath(entry.path, `${pointer}/path`, "landing path");
    if (!landingPath) continue;
    landingDocs.set(id, { doc: doc.value, path: landingPath, source: file.relative });
  }

  // Route registration order: landings, components, technical routes.
  const register = (path: string, owner: string): boolean => {
    try {
      routes.add(path, owner);
      return true;
    } catch (err) {
      if (err instanceof RouteCollision) {
        bag.error("FP1208", err.message, { file: configRel });
        return false;
      }
      throw err;
    }
  };

  for (const [id, landing] of landingDocs) register(landing.path, `landing ${id}`);
  for (const component of enabledComponents) {
    if (component.route) register(component.route, `component ${component.id}`);
    for (const technical of registrationFor(component.kind).technicalRoutes(
      component.options as Record<string, unknown>,
    )) {
      const path = sitePath(technical, `/components/${component.id}`, "technical route");
      if (path) register(path, `component ${component.id} (technical)`);
    }
  }
  for (const subsite of subsites) {
    if (routes.has(subsite.mount)) {
      bag.error(
        "FP1208",
        `Trusted subsite mount '${subsite.mount}' collides with a generated route.`,
        {
          file: configRel,
        },
      );
    }
  }

  // Content.
  const fragmentRequests = new Map<string, FragmentRequest>();
  const addFragment = (
    declared: string,
    pointer: string,
    referencedBy: string,
    relativeTo?: string,
  ): string | undefined => {
    let path: ContainedPath | undefined;
    try {
      path = resolveContained(sourceRoot, relativeTo ?? configPath, declared, {
        mustExist: true,
      });
    } catch (err) {
      if (err instanceof PathViolation) {
        bag.error(err.code, err.message, { file: configRel, pointer });
        return undefined;
      }
      throw err;
    }
    fragmentRequests.set(path.relative, {
      source: path.relative,
      absolute: path.absolute,
      referencedBy,
    });
    return path.relative;
  };

  const headerProse = config.chrome?.header?.prose
    ? addFragment(config.chrome.header.prose, "/chrome/header/prose", "chrome.header")
    : undefined;
  const footerProse = config.chrome?.footer?.prose
    ? addFragment(config.chrome.footer.prose, "/chrome/footer/prose", "chrome.footer")
    : undefined;

  const landingProse = new Map<string, string>();
  for (const [id, landing] of landingDocs) {
    landing.doc.blocks.forEach((block, index) => {
      if (block.type === "prose" && block.source) {
        const key = `${id}:${index}`;
        const rel = addFragment(
          block.source,
          `/blocks/${index}/source`,
          `landing ${id}`,
          join(sourceRoot, landing.source),
        );
        if (rel) landingProse.set(key, rel);
      }
    });
  }

  // Dataset-tree catalogues, read in a pass of their own before the blocks resolve. Same shape as
  // the prose pass above and for the same reason: a block references a project file, the file has
  // to come through `resolveContained()` relative to the landing that named it, and the input
  // manifest has to record it. Doing that inside `resolveBlock` would hand the block resolver a
  // filesystem, which every other file-shaped block avoids.
  const landingCatalogs = new Map<string, DatasetTreeBlockData>();
  /** Live blocks, held until the portal's own playground settings are known. See below. */
  const pendingTreePython: {
    key: string;
    instanceId: string;
    s3: DatasetTreeS3Source;
    expand: readonly string[];
    statusLabel: string | undefined;
    python: RawDatasetTreePython | undefined;
    file: string;
    pointer: string;
  }[] = [];
  for (const [id, landing] of landingDocs) {
    landing.doc.blocks.forEach((block, index) => {
      if (block.type !== "dataset-tree") return;
      const pointer = `/blocks/${index}`;
      // Exactly one source mode, checked here as well as in the schema. The schema's `oneOf` says
      // the same thing better, but a `oneOf` failure reads as a list of alternatives none of which
      // matched; this is the sentence a reader can act on.
      if (block.catalog && block.s3) {
        bag.error("FP1104", "A dataset-tree block takes either `catalog` or `s3`, not both.", {
          file: landing.source,
          pointer,
          hint: "`catalog` embeds a build-time snapshot; `s3` browses a gateway live. A block is one or the other.",
        });
        return;
      }
      if (!block.catalog && !block.s3) {
        bag.error("FP1104", "A dataset-tree block needs a `catalog` or an `s3` source.", {
          file: landing.source,
          pointer,
        });
        return;
      }
      if (block.s3) {
        const source = resolveDatasetTreeS3(block.s3, { file: landing.source, pointer }, bag);
        if (!source) return;
        // Deferred, because a live block's playground may inherit the portal's. A dataset-tree
        // block's `python` stanza cannot express add-ons, connect origins, credential persistence
        // or asset locations - by design, since those are portal-wide - so a block resolved on
        // its own would take the defaults and then fail the page's agreement check. Inheritance
        // needs the portal's resolved settings, which carry the asset URLs this build computed;
        // those exist below, so the call moves below with them. The source itself is resolved
        // here, where its diagnostics belong in reading order.
        pendingTreePython.push({
          key: `${id}:${index}`,
          instanceId: `${id}-${index}`,
          s3: source,
          expand: block.expand ?? [],
          statusLabel: block.statusLabel,
          python: block.python,
          file: landing.source,
          pointer,
        });
        return;
      }
      // Narrowed by the two checks above: the block has a catalogue and no `s3`. The assertion is
      // the narrowing TypeScript cannot carry across the `forEach` callback boundary.
      const catalogPath = block.catalog as string;
      let file: ContainedPath;
      try {
        file = resolveContained(sourceRoot, join(sourceRoot, landing.source), catalogPath, {
          mustExist: true,
        });
      } catch (err) {
        if (err instanceof PathViolation) {
          bag.error(err.code, err.message, { file: landing.source, pointer: `${pointer}/catalog` });
          return;
        }
        throw err;
      }
      const loaded = loadDatasetTreeCatalog({
        absolute: file.absolute,
        relative: file.relative,
        declaredIn: landing.source,
        pointer,
        instanceId: `${id}-${index}`,
        expand: block.expand ?? [],
        statusLabel: block.statusLabel,
        python: block.python,
        bag,
      });
      if (!loaded) return;
      inputs.push({
        path: file.relative,
        role: "config",
        digest: loaded.digest,
        bytes: loaded.bytes,
      });
      landingCatalogs.set(`${id}:${index}`, loaded.data);
    });
  }

  const stacIntro = new Map<string, string>();
  for (const [id, raw] of componentEntries) {
    if (raw.kind !== "stac-browser" || !raw.options?.rootPage?.intro) continue;
    const rel = addFragment(
      raw.options.rootPage.intro,
      `/components/${id}/options/rootPage/intro`,
      `component ${id}`,
    );
    if (rel) stacIntro.set(id, rel);
  }

  const discovered = discoverPages(contentSpecs, new Set(fragmentRequests.keys()));
  bag.merge(discovered.diagnostics);

  const staticFileUrls = new Map<string, string>();
  const assetsBySource = new Map<string, string>();
  for (const file of [...assetResult.files, ...downloadResult.files, ...identityFiles]) {
    staticFileUrls.set(`/${file.file}`, file.url);
    assetsBySource.set(file.source, file.url);
  }

  // The portal-level playground, resolved before any content is rendered. Its only job at this
  // point is to answer one question for the renderer: does `try-in-python` mean anything on this
  // portal? A marked block in a portal without this stanza is parsed, diagnosed like any other
  // fence, and rendered as ordinary copyable code - no identity, no digest, no button, and
  // nothing of the interpreter in the artifact.
  const playgroundWhere = { file: configRel, pointer: "/pythonPlayground" };
  const resolvedPlayground = resolvePlaygroundSettings(
    config.pythonPlayground,
    playgroundWhere,
    bag,
  );

  // The materials, and then where the assets come from - in that order, because the second answer
  // depends on the first. Both are computed here, next to the stanza they are about, but the
  // asset diagnostics are held in a bag of their own and merged only once it is known that some
  // page uses the playground: a portal that enables `pythonPlayground` and marks nothing ships no
  // interpreter, so telling its author to prepare wheels would be advice about a file that will
  // not exist.
  let pythonMaterials: { realRoot: string; plan: PythonMaterialsPlan } | undefined;
  const assetBag = new DiagnosticBag();
  let playgroundAssets: PlaygroundAssetSources = {};
  if (resolvedPlayground) {
    const plan = planPythonMaterials(resolvedPlayground);
    const given = opts.pythonMaterialsDir ?? process.env.FREVA_PORTAL_PYTHON_MATERIALS;
    if (given && given.length > 0) {
      const realRoot = realpathSync(resolve(given));
      const problems = verifyPythonMaterials(realRoot, plan);
      if (problems.length > 0) {
        // Fatal, and in the main bag rather than the deferred one: a build was handed a directory
        // and the directory is not what it claims to be. That is wrong whether or not any page
        // uses the playground, and carrying on with a URL is never the answer.
        bag.error(
          "FP1605",
          `The Python materials at ${given} are not the ones this portal needs.`,
          {
            ...playgroundWhere,
            hint:
              `${problems.slice(0, 4).join("\n")}` +
              (problems.length > 4 ? `\n… and ${problems.length - 4} more` : "") +
              `\nPrepare them for THIS configuration:\n` +
              `  freva-portal-builder prepare-playground --source-root <dir> --config <portal.yaml> --out ${given}`,
          },
        );
      } else {
        pythonMaterials = { realRoot, plan };
      }
    }
    playgroundAssets = resolvePlaygroundAssets({
      settings: resolvedPlayground,
      materialsIncorporated: Boolean(pythonMaterials),
      basePath: canonical.basePath,
      file: configRel,
      pointer: "/pythonPlayground",
      bag: assetBag,
    });
  }

  // The settings the rest of the build sees carry the resolved asset locations, not the raw ones,
  // so a page's configuration, the recorded policy and the help panel all name the place the
  // files are actually served from - which, when this build was handed materials, is this
  // portal's own path rather than a URL somebody typed into a YAML file and has to change per
  // environment, such as a committed `http://127.0.0.1:4321/`.
  const portalPlayground = resolvedPlayground
    ? {
        ...resolvedPlayground,
        ...(playgroundAssets.wheelhouse ? { wheelhouseUrl: playgroundAssets.wheelhouse.url } : {}),
        ...(playgroundAssets.addons ? { addonBaseUrl: playgroundAssets.addons.url } : {}),
        packagePolicy: resolvePackagePolicy(
          {
            ...(resolvedPlayground.runtimeIndexUrl
              ? { runtimeIndexUrl: resolvedPlayground.runtimeIndexUrl }
              : {}),
            ...(playgroundAssets.wheelhouse?.origin === "configured" ||
            playgroundAssets.wheelhouse?.origin === "beside-runtime"
              ? { wheelhouseUrl: playgroundAssets.wheelhouse.url }
              : {}),
            ...(playgroundAssets.addons?.origin === "configured" ||
            playgroundAssets.addons?.origin === "beside-runtime"
              ? { addonBaseUrl: playgroundAssets.addons.url }
              : {}),
          },
          DEFAULT_PYODIDE_INDEX_URL,
          // The mode and the profile the deployment resolved to. Re-resolving the policy must not
          // re-decide either: the profile is what adds a package index, so taking the default
          // here would build a page whose `connect-src` and whose interpreter disagree.
          resolvedPlayground.network,
          resolvedPlayground.profile,
        ),
      }
    : undefined;
  // The live blocks' playgrounds, now that there is something for them to inherit. A dataset-tree
  // block's `python` stanza is deliberately narrower than the portal's - it cannot name add-ons,
  // connect origins, credential persistence or asset locations, because those are decisions about
  // the portal rather than one block - so resolved alone a block takes the default for each, and
  // a page carrying both stanzas fails its own agreement check with the portal saying
  // `addons: [dask]` and the block `[]` about one interpreter. So a block inherits the portal's
  // resolved settings and overrides only the fields it wrote: `python: { enabled: true }` beside
  // a portal stanza is then exactly "this tree uses the portal's playground". A block that writes
  // a field the portal disagrees with is still reported by `checkPlaygroundAgreement`.
  for (const pending of pendingTreePython) {
    landingCatalogs.set(
      pending.key,
      liveDatasetTreeBlock({
        instanceId: pending.instanceId,
        s3: pending.s3,
        expand: pending.expand,
        statusLabel: pending.statusLabel,
        python: pending.python,
        file: pending.file,
        pointer: pending.pointer,
        bag,
        ...(portalPlayground ? { inherit: portalPlayground } : {}),
      }),
    );
  }

  const pipeline = new ContentPipeline(profile, limits, Boolean(portalPlayground));
  const contentResult = await pipeline.run(
    discovered.docs,
    [...fragmentRequests.values()],
    {
      routes: new Set(routes.paths),
      files: staticFileUrls,
      subsiteMounts: subsites.map((s) => s.mount),
      assetsBySource,
      routeOwner: new Map(),
      basePath: canonical.basePath,
    },
    register,
  );

  // What each page actually registered, now that the content has been rendered. A landing's
  // runnable snippets are its prose blocks'; a documentation page's are its own. This has to come
  // after `pipeline.run`, which is also why the page-level agreement check below sits here: the
  // question "does this page use the portal's playground" cannot be answered before the page has
  // been read.
  const runnableByFragment = new Map<string, RegisteredContentExample[]>();
  for (const [source, fragment] of contentResult.fragments) {
    if (fragment.runnable && fragment.runnable.length > 0) {
      runnableByFragment.set(source, fragment.runnable);
    }
  }
  const landingRunnable = new Map<string, RegisteredContentExample[]>();
  for (const [id, landing] of landingDocs) {
    const found: RegisteredContentExample[] = [];
    landing.doc.blocks.forEach((_block, index) => {
      const source = landingProse.get(`${id}:${index}`);
      if (source) found.push(...(runnableByFragment.get(source) ?? []));
    });
    if (found.length > 0) landingRunnable.set(id, found);
  }
  // Chrome prose is not a page, and a marker there is refused rather than honoured. A header or
  // footer fragment is on every document a portal emits, so a runnable snippet in one would put
  // an interpreter, a Worker and a widened policy on the 404 page. That is not something an
  // author asks for by writing `try-in-python` under a heading, so it is a build error naming the
  // file rather than a capability that quietly spreads.
  for (const [pointer, source] of [
    ["/chrome/header/prose", headerProse],
    ["/chrome/footer/prose", footerProse],
  ] as const) {
    if (source && runnableByFragment.has(source)) {
      bag.error("FP1221", "A runnable code block cannot live in header or footer prose.", {
        file: source,
        pointer,
        hint:
          "Chrome prose appears on every page, including the error documents, so a run control " +
          "there would put an interpreter on all of them. Move the snippet into a page or a " +
          "landing prose block.",
      });
    }
  }

  // ONE PORTAL, ONE PLAYGROUND, and the page-level check below is not enough to say so.
  //
  // A portal emits ONE playground: one child artifact when `playgroundOrigin` is set, built from
  // whichever page the walk reached first, and one site-wide `csp.portal` whose `connect-src` is
  // the UNION of every page's origins. Two pages asking for different profiles therefore produce
  // a build that succeeds and an artifact that is wrong in both directions at once - the page
  // asking for `freva-client` gets a child prepared for `xarray-zarr` and no package index, and
  // the page asking for `xarray-zarr` gets a header permitting an index its own help panel says
  // is not enabled. Neither page can tell.
  //
  // Serving genuinely different profiles would mean a CSP per route and a child artifact per
  // profile. Until that exists the honest answer is to refuse, which is what this does.
  const portalClaims: PlaygroundClaim[] = [];

  for (const [id, landing] of landingDocs) {
    // One page, one playground. Everything except the examples has to agree across the page's
    // Python-enabled blocks, because there is one window, one interpreter and one session limit,
    // and the alternative to requiring agreement is a precedence rule - a silent answer to a
    // question the author did not know they had asked.
    const claims: PlaygroundClaim[] = [];
    landing.doc.blocks.forEach((_block, index) => {
      const settings = landingCatalogs.get(`${id}:${index}`)?.python;
      if (!settings) return;
      claims.push({
        describe: `the dataset-tree block at /blocks/${index}`,
        pointer: `/blocks/${index}/python`,
        settings,
      });
    });
    // The portal's own stanza is a claim too, and only when this page actually uses it. Enabling
    // `pythonPlayground` does not by itself put an interpreter on a page - the runnable snippet
    // does - so the stanza joins the agreement check only for a page that has one.
    if (portalPlayground && landingRunnable.has(id)) {
      claims.push({
        describe: "the portal's pythonPlayground",
        pointer: "/blocks",
        settings: portalPlayground,
      });
    }
    checkPlaygroundAgreement(claims, landing.source, bag);
    // One claim per page carries into the portal-wide check. The page's own claims have just
    // been compared with each other, so any of them stands for the page; reporting every block
    // of every page against every other would bury the one line an author has to change.
    const [representative] = claims;
    if (representative) {
      portalClaims.push({
        describe: `${representative.describe} on ${landing.source}`,
        pointer: representative.pointer,
        settings: representative.settings,
        file: landing.source,
      });
    }
  }
  // ACROSS PAGES, reported against the page that differs rather than against the first one: the
  // first is not more correct, but it is the one every other is compared with, so naming the
  // differing page is what points at a line somebody can change.
  checkPlaygroundAgreement(portalClaims, portalClaims[0]?.file ?? "portal.yaml", bag);
  bag.merge(contentResult.diagnostics);
  inputs.push(
    ...contentResult.inputs.map((i) => ({
      path: i.path,
      role: i.role,
      digest: i.digest,
      bytes: i.bytes,
    })),
  );

  for (const asset of assetResult.files) {
    // An asset that is also the site identity or a component's chrome image is referenced, even
    // though the reference is in configuration rather than prose.
    if (
      !contentResult.referencedAssets.has(asset.url) &&
      !identityFiles.some((f) => f.source === asset.source)
    ) {
      bag.warn("FP1408", `Asset '${asset.source}' is never referenced by any page or landing.`, {
        file: asset.source,
      });
    }
  }

  // Landing blocks.
  const landings: ResolvedLanding[] = [];
  const linkCtxBase = {
    basePath: canonical.basePath,
    landings: new Map<string, ResolvedLanding>(),
    components,
    knownPaths: new Set(routes.paths),
    subsiteMounts: subsites.map((s) => s.mount),
    staticFiles: new Set(staticFileUrls.keys()),
  };

  // Landings must be resolvable by name from links, so the map is populated with shells first and
  // filled in as each landing resolves.
  for (const [id, landing] of landingDocs) {
    linkCtxBase.landings.set(id, {
      id,
      path: landing.path,
      title: landing.doc.title,
      blocks: [],
      source: landing.source,
    });
  }

  for (const [id, landing] of landingDocs) {
    const blocks: ResolvedBlock[] = [];
    landing.doc.blocks.forEach((raw, index) => {
      const ctx: LinkContext = {
        ...linkCtxBase,
        pointer: `/blocks/${index}`,
        file: landing.source,
      };
      const resolved = resolveBlock(raw, index, id, ctx, {
        components,
        fragments: contentResult.fragments,
        landingProse,
        landingCatalogs,
        bag,
        basePath: canonical.basePath,
      });
      if (resolved) blocks.push(resolved);
    });
    const resolvedLanding: ResolvedLanding = {
      id,
      path: landing.path,
      title: landing.doc.title,
      ...(landing.doc.description ? { description: landing.doc.description } : {}),
      blocks,
      source: landing.source,
    };
    landings.push(resolvedLanding);
    linkCtxBase.landings.set(id, resolvedLanding);
  }

  // Chrome and navigation.
  const resolveLinks = (raws: RawLink[] | undefined, pointerBase: string): ResolvedLink[] => {
    const out: ResolvedLink[] = [];
    (raws ?? []).forEach((raw, index) => {
      const result = resolveLink(raw, {
        ...linkCtxBase,
        pointer: `${pointerBase}/${index}`,
        file: configRel,
      });
      bag.merge(result.diagnostics);
      if (result.link) out.push(result.link);
    });
    return out;
  };

  // The footer badge, which an enabled footer has unless it says otherwise. Resolved here rather
  // than in the artifact writer because "is there a badge" is a *model* question: the footer
  // template, the entry module and the enablement evidence all read the answer and must get the
  // same one. Note the order - the decision is made before the footer object is built, from the
  // same `enabled` that object will carry, so a disabled footer cannot end up with a badge
  // published behind it.
  const footerEnabled = config.chrome?.footer?.enabled ?? true;
  const badgeChoice = decideFooterBadge(footerEnabled, config.chrome?.footer?.badge);
  const badgePublication = publishFooterBadge(badgeChoice, canonical.basePath, bag);
  if (badgePublication) {
    for (const [file, bytes] of badgePublication.contents) contents.set(file, bytes);
    inputs.push(...(badgePublication.inputs as typeof inputs));
  }

  // The Cosmos scene's artwork, on the same terms as the badge: published only when the resolved
  // theme asked for that backdrop, so every other preset's artifact contains none of it and the
  // enablement tests can read the contents and prove it.
  const cosmosPublication = publishCosmosScene(theme.backdrop, canonical.basePath, bag);
  if (cosmosPublication) {
    for (const [file, bytes] of cosmosPublication.contents) contents.set(file, bytes);
    inputs.push(...(cosmosPublication.inputs as typeof inputs));
  }

  const chrome = {
    header: {
      enabled: config.chrome?.header?.enabled ?? true,
      links: resolveLinks(config.chrome?.header?.links, "/chrome/header/links"),
      ...(headerProse && contentResult.fragments.has(headerProse)
        ? { prose: contentResult.fragments.get(headerProse)! }
        : {}),
    },
    footer: {
      enabled: footerEnabled,
      groups: (config.chrome?.footer?.groups ?? []).map((group, index) => ({
        title: group.title,
        links: resolveLinks(group.links, `/chrome/footer/groups/${index}/links`),
      })),
      legalLinks: resolveLinks(config.chrome?.footer?.legalLinks, "/chrome/footer/legalLinks"),
      ...(footerProse && contentResult.fragments.has(footerProse)
        ? { prose: contentResult.fragments.get(footerProse)! }
        : {}),
      ...(badgePublication ? { badge: badgePublication.badge } : {}),
    },
  };

  const navigation = {
    header: resolveLinks(config.navigation?.header, "/navigation/header"),
    footer: resolveLinks(config.navigation?.footer, "/navigation/footer"),
  };

  // STAC root intro.
  for (const component of componentList) {
    if (component.kind !== "stac-browser") continue;
    const rel = stacIntro.get(component.id);
    if (!rel) continue;
    const fragment = contentResult.fragments.get(rel);
    if (fragment) {
      (component.options as StacOptions).rootPage = {
        ...(component.options as StacOptions).rootPage,
        introHtml: fragment.html,
      };
    }
  }

  // Routes.
  /**
   * A page's playground: the portal's settings, plus what *this* page registered. Returns
   * undefined for a page with nothing runnable on it, which is what keeps the capability off
   * every page that does not use it. The examples carry only identity and digest - the source
   * stays in the document's own copy control, or in the separate origin's manifest.
   */
  const pagePlayground = (
    examples: readonly RegisteredContentExample[] | undefined,
  ): PythonPlaygroundData | undefined => {
    if (!portalPlayground || !examples || examples.length === 0) return undefined;
    return {
      ...portalPlayground,
      examples: examples
        .map((example) => ({ id: example.id, sha256: example.sha256, title: example.title }))
        .sort((a, b) => compareCodePoints(a.id, b.id)),
    };
  };

  const allRoutes: ResolvedRoute[] = [];
  for (const landing of landings) {
    const runnable = landingRunnable.get(landing.id);
    const python = pagePlayground(runnable);
    allRoutes.push({
      path: landing.path,
      file: siteFile(landing.path),
      url: siteUrl(canonical.canonicalUrl, landing.path),
      kind: "landing",
      title: landing.title,
      ...(landing.description ? { description: landing.description } : {}),
      landingId: landing.id,
      ...(python ? { python } : {}),
      ...(runnable ? { runnable } : {}),
    });
  }
  // Section navigation, derived here rather than during rendering. This is the first point at
  // which every content page and its final route are known: a page's route can be moved by
  // frontmatter, and a section's links have to be the resolved public URLs even though its
  // membership comes from the source tree. Deriving it earlier would link to routes not yet
  // decided; deriving it in the template would mean an Astro page reading the filesystem, which
  // nothing in this build does. The navigation links are passed in so a section can borrow a
  // label the deployment already chose - a name only, membership never depends on the header.
  const pageTitle = (page: (typeof contentResult.pages)[number]): string =>
    page.fragment.title ?? config.site.title;
  const sections = deriveSectionNavigation(
    candidatesFrom(contentResult.pages, pageTitle),
    [...navigation.header, ...navigation.footer],
    canonical.basePath,
  );

  for (const page of contentResult.pages) {
    const section = sections.get(page.doc.source);
    const toc = page.fragment.toc
      ? page.fragment.headings.filter((hd) => hd.depth >= 2 && hd.depth <= 3)
      : [];
    allRoutes.push({
      path: page.route,
      file: siteFile(page.route),
      url: siteUrl(canonical.canonicalUrl, page.route),
      kind: "content",
      title: pageTitle(page),
      ...(page.fragment.description ? { description: page.fragment.description } : {}),
      content: page.fragment,
      ...(pagePlayground(page.fragment.runnable)
        ? { python: pagePlayground(page.fragment.runnable)! }
        : {}),
      ...(page.fragment.runnable && page.fragment.runnable.length > 0
        ? { runnable: page.fragment.runnable }
        : {}),
      source: page.doc.source,
      toc,
      // Nested here for the same reason `navOutline` is: an `.astro` template may import a type
      // from this model and nothing else, and `[...route].astro` was calling `nestHeadings`.
      ...(toc.length > 0 ? { tocTree: nestHeadings(toc) } : {}),
      ...(section ? { sectionNavigation: section } : {}),
    });
  }
  for (const component of enabledComponents) {
    if (!component.route) continue;
    allRoutes.push({
      path: component.route,
      file: siteFile(component.route),
      url: siteUrl(canonical.canonicalUrl, component.route),
      kind: "component",
      title: component.title,
      description: component.description,
      componentId: component.id,
    });
  }
  if (authComponent) {
    const options = authComponent.options as AuthOptions;
    allRoutes.push({
      path: options.callbackPath,
      file: siteFile(options.callbackPath),
      url: options.redirectUri,
      kind: "auth-callback",
      title: "Signing in",
      componentId: authComponent.id,
    });
  }
  // One document per HTTP status a static host can actually hand back. A host is configured to
  // serve a file for a status - `error_page 503 /503.html` in nginx, `ErrorDocument` in Apache, a
  // custom error response in a CDN - and if that file does not exist the visitor gets the
  // origin's own default: an unstyled page from software they have never heard of, with no way
  // back to the site. Generating them costs one small document each. They are pages, not a
  // redirect: the status code has to survive, so the body is served *at* the URL that failed.
  for (const status of STATUS_PAGES) {
    allRoutes.push({
      path: `/${status.code}.html`,
      file: `${status.code}.html`,
      url: `${canonical.canonicalUrl}${status.code}.html`,
      kind: "error",
      status: status.code,
      reason: status.reason,
      retry: status.retry,
      title: status.title,
      description: status.summary,
    });
  }
  allRoutes.sort((a, b) => compareCodePoints(a.path, b.path));

  // Evidence plan and host policy.
  const componentEvidencePlan: ComponentEvidencePlan[] = componentList.map((component) => {
    const registration = registrationFor(component.kind);
    return {
      id: component.id,
      kind: component.kind,
      enabled: component.enabled,
      ownedModuleRoots: [...registration.ownedModuleRoots],
      ownedStaticRoots: [...registration.ownedStaticRoots],
      assetNamespaces: [...registration.assetNamespaces],
      allowedSharedModules: [...registration.allowedSharedModules],
      routes: [
        ...(component.enabled && component.route ? [component.route] : []),
        ...(component.enabled
          ? registration.technicalRoutes(component.options as Record<string, unknown>)
          : []),
      ],
      emittedServiceIds: component.enabled && component.serviceId ? [component.serviceId] : [],
    };
  });

  // One more evidence plan, for the dataset-tree block. It is not a component and has no service,
  // route or options, but "prove it is absent" is the same question and this is the machinery
  // that answers it. `enabled` is computed from the resolved landings rather than from the raw
  // configuration, so a block that failed validation and was dropped counts as absent.
  const datasetTreeEnabled = landings.some((landing) =>
    landing.blocks.some((block) => block.type === "dataset-tree"),
  );
  componentEvidencePlan.push({
    ...DATASET_TREE_EVIDENCE,
    ownedModuleRoots: [...DATASET_TREE_EVIDENCE.ownedModuleRoots],
    ownedStaticRoots: [...DATASET_TREE_EVIDENCE.ownedStaticRoots],
    assetNamespaces: [...DATASET_TREE_EVIDENCE.assetNamespaces],
    allowedSharedModules: [...DATASET_TREE_EVIDENCE.allowedSharedModules],
    enabled: datasetTreeEnabled,
    routes: [],
    emittedServiceIds: [],
  });

  // And one for the playground, which is enabled by a stanza inside the block rather than by the
  // block. A portal that browses an archive and does not offer to run anything must be provably
  // free of an interpreter, which is a different question from whether it has a tree.
  const pythonEnabled =
    landings.some((landing) =>
      landing.blocks.some((block) => block.type === "dataset-tree" && block.datasetTree?.python),
    ) ||
    // …or a page that registered a runnable snippet. Not "the stanza is present": a portal that
    // enables `pythonPlayground` and marks nothing must still be provably free of an interpreter,
    // which is the case the warning below is about.
    allRoutes.some((route) => Boolean(route.python));
  // Now the asset diagnostics, because only now is it known whether they are about anything. Held
  // back rather than emitted where they were computed: a portal that enables the stanza and marks
  // nothing ships no interpreter, no Worker and no widened policy, so telling its author the
  // wheels have nowhere to come from would be advice about files nothing will fetch. The FP1222
  // warning below is the right diagnostic for that portal.
  if (pythonEnabled) bag.merge(assetBag);
  if (portalPlayground && !allRoutes.some((route) => Boolean(route.python))) {
    bag.warn("FP1222", "pythonPlayground is enabled, but no page has a runnable code block.", {
      file: configRel,
      pointer: "/pythonPlayground",
      hint:
        "Mark a Python block with `try-in-python` (Markdown) or `:try-in-python:` (RST). Until " +
        "something is marked this configuration changes nothing: the build emits no interpreter, " +
        "no Worker and no widened policy.",
    });
  }
  componentEvidencePlan.push({
    ...PYTHON_PLAYGROUND_EVIDENCE,
    ownedModuleRoots: [...PYTHON_PLAYGROUND_EVIDENCE.ownedModuleRoots],
    ownedStaticRoots: [...PYTHON_PLAYGROUND_EVIDENCE.ownedStaticRoots],
    ownedEmittedNames: [...PYTHON_PLAYGROUND_EVIDENCE.ownedEmittedNames],
    assetNamespaces: [...PYTHON_PLAYGROUND_EVIDENCE.assetNamespaces],
    allowedSharedModules: [...PYTHON_PLAYGROUND_EVIDENCE.allowedSharedModules],
    enabled: pythonEnabled,
    routes: [],
    emittedServiceIds: [],
  });

  const emittedServices = componentList
    .filter((c) => c.enabled && c.serviceId)
    .map((c) => services.get(c.serviceId!)!)
    .filter((s): s is ResolvedService => Boolean(s));

  // The separate-origin playground, resolved once for the whole portal. Collected across every
  // landing rather than per page, because what is generated is one deployable document with one
  // merged manifest: a press on any page names an id, and the child has to know all of them.
  // Blocks that did not ask for a second origin contribute nothing.
  const playgroundBlocks: {
    pointer: string;
    file: string;
    python: PythonPlaygroundData;
    examples: readonly PlaygroundArtifactExample[];
    dataOrigin?: string;
  }[] = [];
  for (const landing of landings) {
    landing.blocks.forEach((block, index) => {
      const data = block.datasetTree;
      if (!data?.python?.playgroundOrigin) return;
      playgroundBlocks.push({
        pointer: `/blocks/${index}`,
        file: landing.source,
        python: data.python,
        examples: data.playgroundExamples ?? [],
        ...(data.s3?.origin ? { dataOrigin: data.s3.origin } : {}),
      });
    });
  }
  // Runnable documentation joins the same merged manifest. One child artifact per portal, one
  // manifest, one verification: a press on a documentation page and a press in a dataset tree are
  // the same message to the same origin, and the child cannot hold two registries without one of
  // them being wrong for whoever pressed.
  for (const route of allRoutes) {
    if (!route.python?.playgroundOrigin || !route.runnable) continue;
    playgroundBlocks.push({
      pointer: route.path,
      file: route.source ?? route.path,
      python: route.python,
      examples: route.runnable.map((example) => ({
        id: example.id,
        title: example.title,
        source: example.source,
        sha256: example.sha256,
      })),
    });
  }
  const playground = resolvePlaygroundArtifact({
    blocks: playgroundBlocks,
    hostOrigin: canonical.origin,
    protocolVersion: EMBED_PROTOCOL_VERSION,
    runtimeIndexUrl: DEFAULT_PYODIDE_INDEX_URL,
    bag,
  });

  const pkg = packageInfo();
  const model: ResolvedPortalModel = {
    ...(playground ? { playground } : {}),
    site: {
      id: config.site.id,
      title: config.site.title,
      ...(config.site.subtitle ? { subtitle: config.site.subtitle } : {}),
      language: config.site.language,
      canonicalUrl: canonical.canonicalUrl,
      basePath: canonical.basePath,
      origin: canonical.origin,
      identity: {
        logo: logo ?? { url: "", file: "", mimeType: "", source: "" },
        favicon: favicon ?? { url: "", file: "", mimeType: "", source: "" },
      },
      ...(config.site.institution ? { institution: config.site.institution } : {}),
    },
    theme: {
      preset: presetName,
      tokens: theme.tokens,
      css: theme.css,
      ...(theme.backdrop ? { backdrop: theme.backdrop } : {}),
      ...(cosmosPublication ? { sceneAssetBase: cosmosPublication.assetBase } : {}),
    },
    chrome,
    services: emittedServices,
    components: componentList,
    enabledComponents,
    componentEvidencePlan,
    navigation,
    // The narrow chrome's two-level tree, derived once, here: an `.astro` template importing a
    // *value* from `src/` resolves in this checkout and fails in every consumer's build, because
    // the published package ships `dist/`, so the template reads a field instead. The header's
    // own tabs, not `navigation.header`: the home link is drawn separately and the panel's own
    // "Home" row is its equivalent, so including it here would put it in twice.
    navOutline: deriveNavOutline(
      [...navigation.header, ...chrome.header.links].filter(
        (link) => link.href !== canonical.basePath,
      ),
      allRoutes,
    ),
    landings,
    routes: allRoutes,
    embeddableAssets: assetResult.files,
    passiveDownloads: downloadResult.files,
    identityFiles,
    trustedSubsiteMounts: subsites,
    announcements,
    hostPolicy: {
      ...(authComponent
        ? { authCallbackPath: (authComponent.options as AuthOptions).callbackPath }
        : {}),
      downloadPrefixes: downloadRoots.map((r) => r.mount),
      subsiteMounts: subsites.map((s) => s.mount),
    },
    buildIdentity: {
      builderName: pkg.name,
      builderVersion: pkg.version,
      builderPurl: packagePurl(),
      sourceDateEpoch: opts.sourceDateEpoch ?? 0,
      ...(opts.effectiveAt ? { effectiveAt: opts.effectiveAt } : {}),
      release: opts.release ?? false,
      schemaDigests: {
        portal: schemaDigest(SCHEMA_FILES.portal),
        landing: schemaDigest(SCHEMA_FILES.landing),
        subsitePolicy: schemaDigest(SCHEMA_FILES.subsitePolicy),
      },
      profileDigest,
      profileName,
    },
    inputs: dedupeInputs(inputs),
    referencedFiles: [...contentResult.referencedAssets].sort(),
  };

  if (!logo || !favicon) {
    bag.error("FP1006", "Site identity assets could not be resolved.", {
      file: configRel,
      pointer: "/site/identity",
    });
  }

  const result: ResolveResult = {
    diagnostics: bag,
    warningsAsErrors,
    contents,
    mathUsed: contentResult.mathUsed,
    rst: {
      used: pipeline.helperUsed,
      ...(pipeline.helperHandshake ? { handshake: pipeline.helperHandshake } : {}),
    },
    ...(contentResult.codeCss ? { codeCss: contentResult.codeCss } : {}),
    // Reported whether or not any page uses it, and whether or not the build succeeded, because
    // `prepare-playground` runs before a portal is buildable: a deployment that has not fetched
    // its wheels cannot pass a build that needs them, so preparation must not depend on one.
    ...(portalPlayground ? { portalPlayground } : {}),
    ...(pythonMaterials && pythonEnabled ? { pythonMaterials } : {}),
  };
  if (!bag.failed(warningsAsErrors)) {
    result.model = deepFreeze(model);
    if (stacMaterials) {
      const stac = enabledComponents.find((c) => c.kind === "stac-browser");
      if (stac) {
        const options = stac.options as StacOptions;
        result.stacAdapter = {
          source: generateStacAdapter(options, stacMaterials, canonical.basePath),
          materials: stacMaterials,
        };
      }
    }
  }
  return result;
}

interface DeclaredInput {
  absolute: string;
  label: string;
}

/**
 * Every individual file and tree the configuration reaches, resolved for containment only.
 * "Reaches" includes the indirect ones: a landing document names prose sources, and a landing
 * document that is itself unreadable contributes nothing here, because the authoritative pass
 * will report it properly.
 */
function collectDeclaredInputs(
  sourceRoot: string,
  configPath: string,
  config: PortalConfig,
): DeclaredInput[] {
  const found: DeclaredInput[] = [];

  const add = (
    declaredIn: string,
    declared: string | undefined,
    label: string,
  ): ContainedPath | undefined => {
    if (!declared) return undefined;
    try {
      const path = resolveContained(sourceRoot, declaredIn, declared, { mustExist: true });
      found.push({ absolute: path.absolute, label: `${label} ${path.relative}` });
      return path;
    } catch {
      // Unresolvable here is not a verdict; the authoritative pass owns that.
      return undefined;
    }
  };

  add(configPath, config.site.identity.logo, "site logo");
  add(configPath, config.site.identity.favicon, "site favicon");
  add(configPath, config.chrome?.header?.prose, "header prose");
  add(configPath, config.chrome?.footer?.prose, "footer prose");

  for (const component of Object.values(config.components ?? {})) {
    add(configPath, component.options?.chrome?.image, "component chrome image");
    add(configPath, component.options?.rootPage?.intro, "component root intro");
    // A provider's mark is a reference like any other: named in configuration, published by the
    // build. Left out of this pass it is published and reported as an asset nothing references.
    for (const provider of component.options?.rootPage?.providers ?? []) {
      add(configPath, provider.logo, "STAC provider logo");
    }
  }

  for (const subsite of config.trustedSubsites ?? []) {
    add(configPath, subsite.source, "trusted subsite tree");
    add(configPath, subsite.policy, "trusted subsite policy");
  }

  for (const landing of Object.values(config.landings ?? {})) {
    const file = add(configPath, landing.source, "landing");
    if (!file) continue;
    let document: LandingDocument | undefined;
    try {
      const parsed = loadYaml<LandingDocument>(readFileSync(file.absolute, "utf8"), file.relative);
      document = parsed.value;
    } catch {
      document = undefined;
    }
    for (const block of document?.blocks ?? []) {
      if (block.type === "prose") add(file.absolute, block.source, "landing prose");
    }
  }

  return found;
}

function generateStacAdapter(
  options: StacOptions,
  materials: PreparedStacMaterials,
  basePath: string,
): string {
  return generateAdapterModule({
    options,
    entryUrl: `${basePath}stac/${materials.manifest.entry}`,
    styleUrls: (materials.manifest.styles ?? []).map((style) => `${basePath}stac/${style}`),
    // The prepared patch set mounts into a fixed element id and fails closed if it is absent, so
    // the generated route must use exactly that id.
    mountId: materials.manifest.mountId ?? "stac-browser-mount",
  });
}

function dedupeInputs(inputs: InputRecord[]): InputRecord[] {
  const map = new Map<string, InputRecord>();
  for (const input of inputs) map.set(`${input.role}:${input.path}`, input);
  return [...map.values()].sort(
    (a, b) => compareCodePoints(a.path, b.path) || compareCodePoints(a.role, b.role),
  );
}

function relativeTo(root: string, target: string): string {
  const rel = target.startsWith(root) ? target.slice(root.length).replace(/^[/\\]/, "") : target;
  return rel;
}

function resolveAnnouncements(
  config: PortalConfig,
  configRel: string,
  opts: ResolveOptions,
  bag: DiagnosticBag,
): ResolvedAnnouncement[] {
  const declared = config.announcements ?? [];
  const dated = declared.filter((a) => a.startsAt || a.endsAt);
  const seen = new Set<string>();
  for (const [index, entry] of declared.entries()) {
    if (seen.has(entry.id)) {
      bag.error("FP1303", `Duplicate announcement id '${entry.id}'.`, {
        file: configRel,
        pointer: `/announcements/${index}/id`,
      });
    }
    seen.add(entry.id);
    if (entry.startsAt && entry.endsAt && Date.parse(entry.startsAt) >= Date.parse(entry.endsAt)) {
      bag.error("FP1302", `Announcement '${entry.id}' has startsAt >= endsAt.`, {
        file: configRel,
        pointer: `/announcements/${index}`,
      });
    }
  }

  if (dated.length === 0) {
    if (opts.effectiveAt && !opts.dev) {
      bag.error("FP1304", "--effective-at was supplied but no dated announcement uses it.", {
        file: configRel,
      });
    }
    return declared.map(toResolvedAnnouncement);
  }

  let effective: number;
  if (opts.effectiveAt) {
    effective = Date.parse(opts.effectiveAt);
    if (Number.isNaN(effective)) {
      bag.error("FP1301", `--effective-at '${opts.effectiveAt}' is not an RFC 3339 instant.`, {
        file: configRel,
      });
      return [];
    }
  } else if (opts.dev) {
    effective = Date.now();
  } else {
    bag.error(
      "FP1301",
      "This configuration contains a dated announcement, so validate and build require --effective-at <RFC3339>.",
      {
        file: configRel,
        hint: "CI may derive it from SOURCE_DATE_EPOCH explicitly; the builder never reads a wall clock for a release.",
      },
    );
    return [];
  }

  return declared
    .filter((entry) => {
      const start = entry.startsAt ? Date.parse(entry.startsAt) : Number.NEGATIVE_INFINITY;
      const end = entry.endsAt ? Date.parse(entry.endsAt) : Number.POSITIVE_INFINITY;
      return start <= effective && effective < end;
    })
    .map(toResolvedAnnouncement);
}

function toResolvedAnnouncement(
  entry: NonNullable<PortalConfig["announcements"]>[number],
): ResolvedAnnouncement {
  return {
    id: entry.id,
    message: entry.message,
    level: entry.level,
    dismissible: entry.dismissible ?? true,
  };
}

interface BlockResolveDeps {
  components: Map<string, ResolvedComponent>;
  fragments: Map<string, RenderedFragment>;
  landingProse: Map<string, string>;
  /** Catalogues already read and validated, keyed `<landing>:<block index>`. */
  landingCatalogs: Map<string, DatasetTreeBlockData>;
  bag: DiagnosticBag;
  basePath: string;
}

function resolveBlock(
  raw: RawLandingBlock,
  index: number,
  landingId: string,
  ctx: LinkContext,
  deps: BlockResolveDeps,
): ResolvedBlock | undefined {
  const links = (
    list: (RawLink & { title?: string; summary?: string })[] | undefined,
  ): ResolvedLink[] => {
    const out: ResolvedLink[] = [];
    (list ?? []).forEach((entry, i) => {
      const result = resolveLink(entry, { ...ctx, pointer: `${ctx.pointer}/items/${i}` });
      deps.bag.merge(result.diagnostics);
      if (result.link) out.push(result.link);
    });
    return out;
  };

  switch (raw.type) {
    case "hero": {
      const actions: ResolvedLink[] = [];
      (raw.actions ?? []).forEach((action, i) => {
        const result = resolveLink(action, { ...ctx, pointer: `${ctx.pointer}/actions/${i}` });
        deps.bag.merge(result.diagnostics);
        if (result.link) actions.push(result.link);
      });
      return {
        type: "hero",
        heading: raw.heading!,
        ...(raw.summary ? { summary: raw.summary } : {}),
        actions,
      };
    }
    case "prose": {
      const rel = deps.landingProse.get(`${landingId}:${index}`);
      const fragment = rel ? deps.fragments.get(rel) : undefined;
      if (!fragment) return undefined;
      return { type: "prose", ...(raw.heading ? { heading: raw.heading } : {}), prose: fragment };
    }
    case "cards": {
      const cards = (raw.items ?? []).map((item, i) => {
        const hasTarget = item.landing || item.component || item.href;
        if (!hasTarget)
          return { title: item.title!, ...(item.summary ? { summary: item.summary } : {}) };
        const result = resolveLink(
          { ...item, label: item.title! },
          { ...ctx, pointer: `${ctx.pointer}/items/${i}` },
        );
        deps.bag.merge(result.diagnostics);
        return {
          title: item.title!,
          ...(item.summary ? { summary: item.summary } : {}),
          ...(result.link ? { link: result.link } : {}),
        };
      });
      return { type: "cards", ...(raw.heading ? { heading: raw.heading } : {}), cards };
    }
    case "links":
      return {
        type: "links",
        ...(raw.heading ? { heading: raw.heading } : {}),
        actions: links(raw.items),
      };
    case "callout":
      return {
        type: "callout",
        level: raw.level ?? "note",
        ...(raw.heading ? { heading: raw.heading } : {}),
        body: raw.body!,
      };
    case "component-link": {
      const result = resolveLink(
        { label: raw.label!, component: raw.component! },
        { ...ctx, pointer: `${ctx.pointer}/component` },
      );
      deps.bag.merge(result.diagnostics);
      if (!result.link) return undefined;
      return {
        type: "component-link",
        link: result.link,
        ...(raw.summary ? { summary: raw.summary } : {}),
      };
    }
    case "component-search": {
      const component = deps.components.get(raw.component!);
      if (!component) {
        deps.bag.error(
          "FP1201",
          `component-search targets the unknown component '${raw.component}'.`,
          {
            file: ctx.file,
            pointer: ctx.pointer,
          },
        );
        return undefined;
      }
      if (!component.enabled) {
        deps.bag.info(
          "FP1202",
          `component-search targeting the disabled component '${raw.component}' is omitted.`,
          {
            file: ctx.file,
            pointer: ctx.pointer,
          },
        );
        return undefined;
      }
      if (component.kind !== "databrowser" || !component.route) {
        deps.bag.error(
          "FP1201",
          `component-search only targets an enabled databrowser component.`,
          {
            file: ctx.file,
            pointer: ctx.pointer,
          },
        );
        return undefined;
      }
      const componentOptions = component.options as DatabrowserOptions;
      const facets: Record<string, string[]> = {};
      const merged = { ...componentOptions.fixedFacets, ...(raw.fixedFacets ?? {}) };
      for (const [key, value] of Object.entries(merged)) {
        facets[key] = Array.isArray(value) ? value : [value];
      }
      const intent: SearchIntentV1 = {
        v: 1,
        flavour: raw.flavour ?? componentOptions.defaultFlavour,
        ...(Object.keys(facets).length ? { facets } : {}),
      };
      // Serialized through the Data Browser package's own typed helper, so the landing and the
      // component cannot disagree about the wire form.
      const hiddenQuery = serializeSearchIntentV1(intent);
      return {
        type: "component-search",
        ...(raw.heading ? { heading: raw.heading } : {}),
        search: {
          componentId: component.id,
          action: `${deps.basePath.replace(/\/$/, "")}${component.route}`,
          placeholder: raw.placeholder ?? "Search data",
          submitLabel: raw.submitLabel ?? "Search",
          intent,
        },
        summary: hiddenQuery,
      };
    }
    case "dataset-tree": {
      // The catalogue was read, validated and counted in the pre-pass; anything wrong with it has
      // been reported against the file it is wrong in. A missing entry here therefore means "that
      // block failed", and the block is dropped rather than rendered as an empty shell.
      const data = deps.landingCatalogs.get(`${landingId}:${index}`);
      if (!data) return undefined;
      return {
        type: "dataset-tree",
        ...(raw.heading ? { heading: raw.heading } : {}),
        ...(raw.summary ? { summary: raw.summary } : {}),
        datasetTree: data,
      };
    }
    default:
      return undefined;
  }
}

const RETIRED_FIELDS: { pattern: RegExp; name: string; replacement: string }[] = [
  {
    pattern: /\bhtml-fragment\b/,
    name: "html-fragment",
    replacement: "a Markdown or RST prose source",
  },
  {
    pattern: /\bsandbox-html\b/,
    name: "sandbox-html",
    replacement: "a declared static-docs-v1 trusted subsite",
  },
  {
    pattern: /\bpublic_extensions\b/,
    name: "public_extensions",
    replacement: "a typed service or component option",
  },
  {
    pattern: /\buiId\b/,
    name: "uiId",
    replacement: "nothing: v1 has no runtime settings identity",
  },
  {
    pattern: /\bdeployment-config\.json\b/,
    name: "deployment-config.json",
    replacement: "build-time service declarations",
  },
];

/** Migration diagnostics: a retired runtime field names its replacement. */
function reportRetiredFields(text: string, file: string, bag: DiagnosticBag): void {
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const field of RETIRED_FIELDS) {
      if (field.pattern.test(line)) {
        bag.error("FP1501", `'${field.name}' has no build-time representation in FP-001 v1.`, {
          file,
          position: { line: index + 1 },
          hint: `Use ${field.replacement}.`,
        });
      }
    }
  });
}

function scanForCredentials(config: PortalConfig, file: string, bag: DiagnosticBag): void {
  const walk = (value: unknown, pointer: string): void => {
    if (typeof value === "string") {
      if (CREDENTIAL_PATTERN.test(value)) {
        bag.error("FP1210", "This value looks like a credential. Frontend artifacts are public.", {
          file,
          pointer,
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${pointer}/${index}`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (CREDENTIAL_PATTERN.test(key)) {
          bag.error("FP1210", `Configuration key '${key}' looks like a credential holder.`, {
            file,
            pointer,
          });
        }
        walk(item, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
      }
    }
  };
  walk(config, "");
}

export { BuildFailure };
export type { Diagnostic };
