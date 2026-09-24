// The `smoke` command: build somebody else's sources, safely, and say what happened in a
// machine-readable way (R4).
//
// A consumer's sources live in the consumer's repository, and FP-001 gives a build exactly one
// trusted source root and refuses a symlink that leaves it, so the only honest way to test
// another tree is to copy the parts under test into a disposable staging root and build
// *that*. This command does the copying, runs validate/build/verify against the staged root,
// and writes a result. It is published rather than a repository script because a consumer
// cannot run a script that was never packaged, and it is generic: everything that varies is an
// argument, and a branch on a consumer's name would be the first line of the project-specific
// code path FP-001 exists to prevent.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ArgumentError, type ParsedArgs } from "./args.js";
import type { CliIo } from "./index.js";

const CLI_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "freva-portal-builder.mjs",
);

const sha256 = (bytes: Buffer): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export interface SmokeStep {
  name: string;
  command: string;
  exitStatus: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface SmokeResult {
  schemaVersion: 1;
  kind: "external-consumer-smoke";
  result: "pass" | "fail";
  stage: string;
  out: string;
  config: string;
  sourceDateEpoch: string | null;
  effectiveAt: string | null;
  staged: { source: string; destination: string; files: number; refused: number }[];
  refusedDuringStaging: string[];
  builder: {
    name: string | null;
    version: string | null;
    purl: string | null;
    image: unknown;
  } | null;
  inputManifestDigest: string | null;
  artifactChecksumsDigest: string | null;
  steps: SmokeStep[];
  failedChecks: string[];
}

/**
 * Copy a tree by value, refusing anything that is not a directory or a regular file. A symlink
 * is refused rather than dereferenced: dereferencing would import whatever it points at into
 * the trust root, the escape the single-source-root rule exists to forbid.
 */
function copyTree(from: string, to: string, report: string[]): void {
  const stats = lstatSync(from);
  if (stats.isSymbolicLink()) {
    report.push(`refused symlink ${from}`);
    return;
  }
  if (stats.isFile()) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    report.push(`file ${to}`);
    return;
  }
  if (!stats.isDirectory()) {
    report.push(`refused non-regular ${from}`);
    return;
  }
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    copyTree(join(from, entry.name), join(to, entry.name), report);
  }
}

function readArtifactJson(dir: string, name: string): Record<string, unknown> | undefined {
  const file = join(dir, name);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export interface SmokeOptions {
  stage: string;
  out: string;
  config: string;
  copies: string[];
  result?: string;
  effectiveAt?: string;
  keep: boolean;
}

export function smokeOptions(args: ParsedArgs): SmokeOptions {
  const need = (name: string): string => {
    const value = args.flags[name];
    if (typeof value !== "string" || value === "") {
      throw new ArgumentError(`smoke requires --${name}`);
    }
    return value;
  };
  const copies = args.repeated?.copy ?? [];
  const options: SmokeOptions = {
    stage: resolveAbsolute(need("stage")),
    out: resolveAbsolute(need("out")),
    config: need("config"),
    copies,
    keep: args.flags.keep === true,
  };
  if (typeof args.flags.result === "string") options.result = resolveAbsolute(args.flags.result);
  if (typeof args.flags["effective-at"] === "string") {
    options.effectiveAt = args.flags["effective-at"];
  }
  return options;
}

function resolveAbsolute(value: string): string {
  return isAbsolute(value) ? value : join(process.cwd(), value);
}

/**
 * Run the whole smoke sequence. Returns the result; the caller decides the process exit
 * status, which is nonzero unless `result` is `pass`.
 */
export function runSmoke(options: SmokeOptions, io: CliIo): SmokeResult {
  const stageWithSep = options.stage.endsWith(sep) ? options.stage : options.stage + sep;
  const outWithSep = options.out.endsWith(sep) ? options.out : options.out + sep;
  if (outWithSep.startsWith(stageWithSep) || stageWithSep.startsWith(outWithSep)) {
    throw new ArgumentError(
      "--out must be outside --stage; an output tree inside an input tree is not a build",
    );
  }
  if (existsSync(options.stage) && readdirSync(options.stage).length > 0) {
    throw new ArgumentError(`--stage '${options.stage}' is not empty; use a fresh directory`);
  }

  mkdirSync(options.stage, { recursive: true });
  rmSync(options.out, { recursive: true, force: true });

  const staged: SmokeResult["staged"] = [];
  const refused: string[] = [];

  for (const spec of options.copies) {
    const split = spec.lastIndexOf("=");
    if (split <= 0) throw new ArgumentError(`--copy needs <source>=<destination>, got '${spec}'`);
    const source = spec.slice(0, split);
    const destination = spec.slice(split + 1);
    if (isAbsolute(destination) || destination.split("/").includes("..")) {
      throw new ArgumentError(
        `--copy destination '${destination}' must be a relative path inside the stage`,
      );
    }
    if (!existsSync(source)) throw new ArgumentError(`--copy source '${source}' does not exist`);
    const report: string[] = [];
    copyTree(realpathSync(source), join(options.stage, ...destination.split("/")), report);
    for (const line of report) if (line.startsWith("refused")) refused.push(line);
    staged.push({
      source,
      destination,
      files: report.filter((line) => line.startsWith("file ")).length,
      refused: report.filter((line) => line.startsWith("refused")).length,
    });
  }

  const configPath = join(options.stage, ...options.config.split("/"));
  if (!existsSync(configPath)) {
    throw new ArgumentError(`--config '${options.config}' is not in the stage after copying`);
  }

  const steps: SmokeStep[] = [];
  const run = (name: string, argv: string[]): boolean => {
    const started = process.hrtime.bigint();
    const outcome = spawnSync(process.execPath, [CLI_ENTRY, ...argv], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const durationMs = Number((process.hrtime.bigint() - started) / 1000000n);
    const step: SmokeStep = {
      name,
      command: [process.execPath, CLI_ENTRY, ...argv].join(" "),
      exitStatus: outcome.status === null ? -1 : outcome.status,
      durationMs,
      stdout: (outcome.stdout ?? "").split("\n").slice(-40).join("\n"),
      stderr: (outcome.stderr ?? "").split("\n").slice(-40).join("\n"),
    };
    steps.push(step);
    io.out(`[smoke] ${name}: exit ${step.exitStatus} (${durationMs} ms)\n`);
    if (step.exitStatus !== 0) io.err(`${step.stderr}\n`);
    return step.exitStatus === 0;
  };

  const common = ["--source-root", options.stage, "--config", configPath];
  if (options.effectiveAt) common.push("--effective-at", options.effectiveAt);

  let ok = run("validate", ["validate", ...common]);
  if (ok) ok = run("build", ["build", ...common, "--out", options.out]);
  if (ok) ok = run("verify", ["verify", "--dir", options.out]);

  const buildinfo = readArtifactJson(options.out, "BUILDINFO.json");
  const builder = buildinfo?.builder as Record<string, unknown> | undefined;
  const inputManifest = join(options.out, "input-manifest.json");
  const checksums = join(options.out, "checksums.sha256");

  const result: SmokeResult = {
    schemaVersion: 1,
    kind: "external-consumer-smoke",
    // A refusal during staging is a failure, full stop. A file that could not be staged is a
    // file the build did not see, so the artifact does not describe the inputs anybody meant.
    result: ok && refused.length === 0 ? "pass" : "fail",
    stage: options.stage,
    out: options.out,
    config: options.config,
    sourceDateEpoch: process.env.SOURCE_DATE_EPOCH ?? null,
    effectiveAt: options.effectiveAt ?? null,
    staged,
    refusedDuringStaging: refused,
    builder: buildinfo
      ? {
          name: (builder?.name as string) ?? null,
          version: (builder?.version as string) ?? null,
          purl: (builder?.purl as string) ?? null,
          image: builder?.image ?? null,
        }
      : null,
    inputManifestDigest: existsSync(inputManifest) ? sha256(readFileSync(inputManifest)) : null,
    // The digest of the checksum list, which transitively covers every byte in the artifact.
    // Not the release-archive digest: that also covers file order and modes, and comes from
    // `freva-portal-builder archive`.
    artifactChecksumsDigest: existsSync(checksums) ? sha256(readFileSync(checksums)) : null,
    steps,
    failedChecks: [
      ...steps.filter((step) => step.exitStatus !== 0).map((step) => step.name),
      ...(refused.length > 0 ? ["staging"] : []),
    ],
  };

  if (options.result) {
    mkdirSync(dirname(options.result), { recursive: true });
    writeFileSync(options.result, `${JSON.stringify(result, null, 2)}\n`);
    io.out(`[smoke] wrote ${options.result}\n`);
  } else {
    io.out(`${JSON.stringify(result, null, 2)}\n`);
  }

  if (!options.keep) {
    rmSync(options.stage, { recursive: true, force: true });
    io.out("[smoke] removed the staging root\n");
  }

  return result;
}
