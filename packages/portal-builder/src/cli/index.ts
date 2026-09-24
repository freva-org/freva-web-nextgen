// The CLI: a closed command set and no modes. `validate` and `build` require an explicit
// `--source-root` because the trust anchor is not a thing to infer; `dev` may default it, and
// says so out loud.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ArgumentError, parseArgs, requireFlag, type ParsedArgs } from "./args.js";
import { HELP } from "./help.js";
import type { DiagnosticBag } from "../diagnostics.js";
import { formatHuman, toJson } from "../diagnostics.js";
import {
  canonicalizeInRoot,
  canonicalizeRoot,
  contains,
  PathViolation,
  resolveContained,
  toPosix,
} from "../config/paths.js";
import { resolveModel } from "../model/resolve.js";
import { buildSite } from "../artifact/index.js";
import { verifyArtifact } from "../verify/verify.js";
import { buildCanonicalArchive, recordedEpoch } from "../artifact/archive.js";
import { hostCheck } from "../verify/host-check.js";
import { createPreviewServer } from "../verify/preview.js";
import { migrateFile } from "./migrate.js";
import { packageInfo } from "../util/package.js";
import { runDev } from "./dev.js";
import { preparePlayground } from "./prepare-playground.js";
import { runSmoke, smokeOptions } from "./smoke.js";
import { validateAgainst } from "../config/schema.js";
import type { ManifestInputs } from "../artifact/manifests.js";

type ImageReference = NonNullable<ManifestInputs["builderImage"]>;

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

function report(bag: DiagnosticBag, args: ParsedArgs, io: CliIo): void {
  if (args.flags.diagnostics === "json") {
    io.out(`${toJson(bag)}\n`);
    return;
  }
  const text = formatHuman(bag);
  if (text) io.err(`${text}\n`);
}

/**
 * `SOURCE_DATE_EPOCH` is seconds since the Unix epoch, and only that. An ISO timestamp is the
 * mistake worth naming: `Number("2026-08-18T12:00:00Z")` is `NaN`, and a silent fallback would
 * stamp the artifact 1970 with nothing to say so.
 */
function sourceDateEpoch(): number | undefined {
  const raw = process.env.SOURCE_DATE_EPOCH;
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new ArgumentError(
      `SOURCE_DATE_EPOCH must be a non-negative integer number of seconds, not ${JSON.stringify(raw)}. ` +
        'Derive it from the commit: SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)".',
    );
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) {
    throw new ArgumentError("SOURCE_DATE_EPOCH is out of range.");
  }
  return value;
}

interface CommonInputs {
  sourceRoot: string;
  configPath: string;
}

function resolveInputs(args: ParsedArgs, io: CliIo, allowDefaultRoot: boolean): CommonInputs {
  const configFlag = requireFlag(args, "config", "Point it at the portal.yaml to build.");
  let rootFlag =
    typeof args.flags["source-root"] === "string" ? args.flags["source-root"] : undefined;
  if (!rootFlag) {
    if (!allowDefaultRoot) {
      throw new ArgumentError(
        "--source-root is required for validate and build. Every input must be contained by an explicit trusted root.",
      );
    }
    rootFlag = process.cwd();
    io.err(`notice: --source-root defaults to ${rootFlag} for dev only.\n`);
  }
  const sourceRoot = canonicalizeRoot(rootFlag);
  // `canonicalizeRoot` resolved the root; the --config flag has not been. Both have to name
  // the same namespace before either is compared with the other.
  const configPath = canonicalizeInRoot(sourceRoot, configFlag);
  // The config itself must be contained, checked the same way as every other input.
  resolveContained(sourceRoot, sourceRoot, relativeFrom(sourceRoot, configPath));
  return { sourceRoot, configPath };
}

/**
 * The resolved OCI identity of the image that ran this build (AR-011). CI knows the index
 * digest it asked for *and* the platform manifest/config it actually got; both go into the
 * artifact, because two platform resolutions of one index are two different builder inputs.
 */
function parseBuilderImage(value: string | boolean | undefined): ImageReference | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ArgumentError("--builder-image must be a JSON object describing the resolved image.");
  }
  const candidate = { kind: "image", ...(parsed as Record<string, unknown>) };
  const result = validateAgainst("materialReference", candidate, "--builder-image");
  if (!result.valid) {
    throw new ArgumentError(
      `--builder-image is not a valid image reference: ${result.diagnostics.map((d) => d.message).join(" ")}`,
    );
  }
  const image = candidate as unknown as ImageReference & { kind: string };
  const { reference, indexDigest, manifestDigest, configDigest, platform } = image;
  return { reference, indexDigest, manifestDigest, configDigest, platform };
}

function relativeFrom(root: string, target: string): string {
  // `contains` rather than a prefix test: `/a/bc` is not inside `/a/b`, and both paths are
  // already in the canonical namespace by the time they arrive here.
  if (!contains(root, target) || root === target) {
    throw new PathViolation("FP1001", `--config is outside --source-root: ${target}`, target);
  }
  return toPosix(relative(root, target));
}

export async function run(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.err(`${(error as Error).message}\n`);
    return 2;
  }

  if (args.flags.help || args.command === "help") {
    io.out(HELP);
    return 0;
  }
  if (args.flags.version || args.command === "version") {
    io.out(`${packageInfo().name} ${packageInfo().version}\n`);
    return 0;
  }

  /**
   * `--stac-materials <dir>`: the prepared tree this build is to consume. Absent unless stated;
   * an enabled `stac-browser` component with no materials is a build failure with a named
   * remedy, because looking around for a directory is how a deployment ships last week's STAC.
   */
  function stacMaterialsOption(args: ParsedArgs): { stacMaterialsDir?: string } {
    const given = args.flags["stac-materials"];
    return typeof given === "string" && given.length > 0
      ? { stacMaterialsDir: resolve(given) }
      : {};
  }

  /**
   * `--python-materials <dir>`: the prepared playground assets this build is to serve. Same
   * contract as `--stac-materials`. Given them, the artifact serves the wheels and add-on
   * artefacts from its own path, so nothing in `portal.yaml` has to name a host - which is what
   * lets one source configuration be correct in a preview and in production at the same time.
   */
  function pythonMaterialsOption(args: ParsedArgs): { pythonMaterialsDir?: string } {
    const given = args.flags["python-materials"];
    return typeof given === "string" && given.length > 0
      ? { pythonMaterialsDir: resolve(given) }
      : {};
  }

  try {
    switch (args.command) {
      case "validate": {
        const { sourceRoot, configPath } = resolveInputs(args, io, false);
        const result = await resolveModel({
          sourceRoot,
          configPath,
          ...(typeof args.flags["effective-at"] === "string"
            ? { effectiveAt: args.flags["effective-at"] }
            : {}),
          ...(sourceDateEpoch() !== undefined ? { sourceDateEpoch: sourceDateEpoch()! } : {}),
          ...stacMaterialsOption(args),
          ...pythonMaterialsOption(args),
          release: true,
        });
        report(result.diagnostics, args, io);
        if (result.diagnostics.failed(result.warningsAsErrors)) return 1;
        io.out(
          `ok: ${result.model?.routes.length ?? 0} routes, ` +
            `${result.model?.enabledComponents.length ?? 0} enabled components.\n`,
        );
        return 0;
      }

      case "build": {
        const { sourceRoot, configPath } = resolveInputs(args, io, false);
        const out = resolve(
          requireFlag(args, "out", "Where the artifact directory should be written."),
        );
        const epoch = sourceDateEpoch();
        const builderImage = parseBuilderImage(args.flags["builder-image"]);
        const result = await buildSite({
          sourceRoot,
          configPath,
          outDir: out,
          release: true,
          ...stacMaterialsOption(args),
          ...pythonMaterialsOption(args),
          quiet: args.flags.quiet === true,
          ...(typeof args.flags["effective-at"] === "string"
            ? { effectiveAt: args.flags["effective-at"] }
            : {}),
          ...(epoch !== undefined ? { sourceDateEpoch: epoch } : {}),
          ...(typeof args.flags["source-revision"] === "string"
            ? { sourceRevision: args.flags["source-revision"] }
            : {}),
          ...(builderImage ? { builderImage } : {}),
        });
        report(result.diagnostics, args, io);
        if (!result.outDir) return 1;
        io.out(`built: ${result.files?.length ?? 0} files in ${result.outDir}\n`);
        return 0;
      }

      // `prepare-playground` - the ONE command in this CLI that opens a socket. Everything
      // else here is offline by construction, because a build that could fetch is a build
      // whose output depends on when it ran. Preparation is a separate stage with its own
      // command, exactly as the STAC materials are, and `build` is handed the result.
      case "prepare-playground": {
        const { sourceRoot, configPath } = resolveInputs(args, io, false);
        return await preparePlayground(
          {
            sourceRoot,
            configPath,
            outDir: resolve(
              requireFlag(args, "out", "Where the prepared materials should be written."),
            ),
            force: args.flags.force === true,
            dryRun: args.flags["dry-run"] === true,
          },
          io,
        );
      }

      // `stac-plan` - does this configuration need the preparation stage, and with what? The
      // deployment routine asks before deciding whether to run a network-enabled job. It is
      // deliberately a question about the CONFIGURATION and not a second feature flag: the
      // closed `stac-browser` component's `enabled` field is the only place deployment intent
      // is expressed, and this reads it rather than duplicating it. It validates the whole
      // configuration first, so "no preparation needed" is an answer about a portal that is
      // actually buildable.
      case "stac-plan": {
        const { sourceRoot, configPath } = resolveInputs(args, io, false);
        const result = await resolveModel({
          sourceRoot,
          configPath,
          ...(typeof args.flags["effective-at"] === "string"
            ? { effectiveAt: args.flags["effective-at"] }
            : {}),
          // The plan cannot need the output of the stage it is deciding whether to run.
          skipStacMaterials: true,
          release: true,
        });
        if (result.diagnostics.failed(result.warningsAsErrors)) {
          report(result.diagnostics, args, io);
          return 1;
        }
        const stac = (result.model?.components ?? []).find((c) => c.kind === "stac-browser");
        const plan = {
          schemaVersion: 1 as const,
          preparationRequired: Boolean(stac?.enabled),
          component: stac ? { id: stac.id, enabled: stac.enabled } : null,
        };
        if (args.flags.diagnostics === "json") {
          io.out(`${JSON.stringify(plan)}\n`);
        } else if (plan.preparationRequired) {
          io.out(
            `stac-browser '${plan.component?.id}' is enabled: prepare materials before building.\n` +
              `  npm run stac:prepare -- --out <dir>\n` +
              `  freva-portal-builder build ... --stac-materials <dir>\n`,
          );
        } else {
          io.out("stac-browser is not enabled: no preparation needed; build offline.\n");
        }
        return 0;
      }

      case "dev": {
        const { sourceRoot, configPath } = resolveInputs(args, io, true);
        const port = Number(args.flags.port ?? 4321);
        return await runDev({ sourceRoot, configPath, port, io });
      }

      case "preview": {
        const dir = resolve(
          requireFlag(args, "dir", "Point it at an existing artifact directory."),
        );
        const port = Number(args.flags.port ?? 4321);
        const server = createPreviewServer({ dir, port });
        await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
        io.out(
          `preview: http://127.0.0.1:${port}/ - a local convenience server. ` +
            `It is not proof of canonical-URL, TLS, access-log or CDN conformance; use host-check for that.\n`,
        );
        await new Promise(() => undefined);
        return 0;
      }

      case "archive": {
        const dir = resolve(
          requireFlag(args, "dir", "Point it at an existing artifact directory."),
        );
        const epoch = sourceDateEpoch() ?? recordedEpoch(dir);
        const compress = args.flags.compress === true;
        const out = typeof args.flags.out === "string" ? resolve(args.flags.out) : undefined;
        const result = buildCanonicalArchive({
          dir,
          sourceDateEpoch: epoch,
          compress,
          ...(out ? { out } : {}),
        });
        if (args.flags.diagnostics === "json") {
          io.out(`${JSON.stringify({ schemaVersion: 1, archive: result }, null, 2)}\n`);
        } else {
          io.out(
            `archive: ${result.digest} (${result.entries} entries, ${result.bytes} bytes)` +
              `${result.path ? ` -> ${result.path}` : ""}\n`,
          );
        }
        return 0;
      }

      case "verify": {
        const dir = resolve(
          requireFlag(args, "dir", "Point it at an existing artifact directory."),
        );
        const bag = verifyArtifact(dir);
        report(bag, args, io);
        return bag.errors.length > 0 ? 1 : 0;
      }

      case "host-check": {
        const dir = resolve(
          requireFlag(args, "dir", "Point it at the artifact that was deployed."),
        );
        const url = requireFlag(args, "url", "The deployed site base URL.");
        const bag = await hostCheck({ dir, url });
        report(bag, args, io);
        return bag.errors.length > 0 ? 1 : 0;
      }

      case "smoke": {
        // Somebody else's sources, staged into a disposable root and built.
        // Nonzero unless everything, including staging, succeeded.
        const result = runSmoke(smokeOptions(args), io);
        return result.result === "pass" ? 0 : 1;
      }

      case "migrate": {
        const from = resolve(requireFlag(args, "from", "A saved runtime UI manifest JSON file."));
        const out = resolve(requireFlag(args, "out", "Where to write the candidate YAML tree."));
        const result = migrateFile(from);
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "portal.yaml"), result.portalYaml, "utf8");
        if (result.landingYaml) {
          mkdirSync(join(out, "landings"), { recursive: true });
          writeFileSync(join(out, "landings", "home.yaml"), result.landingYaml, "utf8");
        }
        writeFileSync(
          join(out, "migration-loss-report.json"),
          `${JSON.stringify(result.loss, null, 2)}\n`,
          "utf8",
        );
        io.out(
          `migrated: ${out}/portal.yaml with ${result.loss.entries.length} unsupported field(s) reported in migration-loss-report.json\n`,
        );
        return result.loss.entries.length > 0 ? 0 : 0;
      }

      default:
        io.err(`Unknown command '${args.command}'.\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ArgumentError) {
      io.err(`${error.message}\n`);
      return 2;
    }
    if (error instanceof PathViolation) {
      io.err(`error ${error.code}: ${error.message}\n`);
      return 1;
    }
    io.err(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return 1;
  }
}

export { parseArgs };
export const CLI_DIRNAME = dirname(new URL(import.meta.url).pathname);
