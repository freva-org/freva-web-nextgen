#!/usr/bin/env node
/**
 * The FP-001 acceptance matrix, run for real.
 *
 * This script exists because a conformance table written by hand is a claim,
 * not evidence. Every row below is produced by running a command and recording
 * what it did: the argv, the exit status, how long it took, and the tail of its
 * output. A gate that cannot run - because it needs a container registry, a
 * credential or a consumer repository this machine does not have - is recorded
 * as `not-run` together with the exact missing input. It is never recorded as a
 * pass, and there is no code path here that can produce a pass without a
 * process having exited 0.
 *
 *   node scripts/acceptance.mjs                 # run everything that can run
 *   node scripts/acceptance.mjs --only compile,contracts
 *   node scripts/acceptance.mjs --out reports/fp001-acceptance.json
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = join(ROOT, "packages", "portal-builder");
const CLI = join(BUILDER, "bin", "freva-portal-builder.mjs");

/**
 * The gates a release must have *run*, not merely not failed.
 *
 * A `not-run` in this set is a failed release. That is the whole point of the
 * list: the previous version exited zero whenever nothing had failed, so a gate
 * that never ran - because a registry was unreachable, or a runner lacked a
 * browser - was indistinguishable from a gate that passed.
 */
const REQUIRED = new Set([
  "closure",
  "install",
  "compile",
  "contracts",
  "browser",
  "package",
  "hermeticity",
  "reproducibility",
  "verification",
  "container",
  "pilot",
]);

const argv = process.argv.slice(2);
let outFile = join(ROOT, "reports", "fp001-acceptance.json");
let only;
/** Named, explicit, and it marks the report non-releasable. Never a default. */
let allowNotRun = new Set();
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--out") outFile = resolve(argv[++i]);
  else if (argv[i] === "--only") only = new Set(argv[++i].split(","));
  else if (argv[i] === "--allow-not-run") allowNotRun = new Set(argv[++i].split(","));
  else {
    process.stderr.write(
      `acceptance: unknown argument '${argv[i]}'\n` +
        "usage: acceptance.mjs [--out <file>] [--only <gate,...>] [--allow-not-run <gate,...>]\n",
    );
    process.exit(2);
  }
}

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function capture(command, args, options = {}) {
  const outcome = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 128 * 1024 * 1024,
  });
  return {
    command: [command, ...args].join(" "),
    exitStatus: outcome.status === null ? -1 : outcome.status,
    stdout: outcome.stdout ?? "",
    stderr: outcome.stderr ?? "",
    error: outcome.error ? String(outcome.error.message) : undefined,
  };
}

function version(command, args) {
  const outcome = capture(command, args);
  if (outcome.exitStatus !== 0) return null;
  return `${outcome.stdout}${outcome.stderr}`.trim().split("\n")[0] ?? null;
}

const toolVersions = {
  node: process.version,
  npm: version("npm", ["--version"]),
  git: version("git", ["--version"]),
  python3: version("python3", ["--version"]),
  docutils: version("python3", ["-c", "import docutils;print(docutils.__version__)"]),
  docker: version("docker", ["--version"]),
  playwrightChromium: existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers")
    ? (process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers")
    : null,
};

const gates = [];
const tail = (text, lines = 25) => text.split("\n").slice(-lines).join("\n").trim();

function record(id, title, outcomes, extra = {}) {
  const failed = outcomes.find((o) => o.exitStatus !== 0);
  gates.push({
    id,
    title,
    status: failed ? "fail" : "pass",
    commands: outcomes.map((o) => ({
      command: o.command,
      exitStatus: o.exitStatus,
      output: tail(`${o.stdout}\n${o.stderr}`),
    })),
    ...extra,
  });
  process.stdout.write(`[acceptance] ${id}: ${failed ? "FAIL" : "pass"}\n`);
}

function skip(id, title, missingInput, detail) {
  gates.push({ id, title, status: "not-run", missingInput, detail, commands: [] });
  process.stdout.write(`[acceptance] ${id}: not-run (${missingInput})\n`);
}

const wanted = (id) => !only || only.has(id);

// -- source closure ---------------------------------------------------------
if (wanted("closure")) {
  record("closure", "Source closure", [
    capture(process.execPath, [join(BUILDER, "scripts", "source-closure.mjs")]),
  ]);
}

// -- install ----------------------------------------------------------------
/**
 * A clean extraction of the tracked tree, at a caller-chosen path.
 *
 * `git archive` rather than a copy: it produces exactly what the delivery
 * contains, so a gate that passes here is a gate that passes for somebody who
 * received only the archive.
 */
function cleanExtraction(label) {
  const dir = join(tmpdir(), `fp001-${label}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tarball = join(dir, "source.tar");
  const archived = capture("git", ["archive", "--format=tar", "-o", tarball, "HEAD"]);
  const extracted = capture("tar", ["-xf", tarball, "-C", dir]);
  rmSync(tarball, { force: true });
  return { dir, commands: [archived, extracted] };
}

if (wanted("install")) {
  // A real `npm ci` in a clean extraction, not `--dry-run` in a tree that
  // already has node_modules. `npm ci` is the frozen gate precisely because it
  // fails rather than rewriting a lockfile that does not match package.json,
  // and only a real run proves the tree it produces.
  const clean = cleanExtraction("install");
  const before = sha256(readFileSync(join(clean.dir, "package-lock.json")));
  const install = capture("npm", ["ci", "--no-audit", "--no-fund"], { cwd: clean.dir });
  const after = existsSync(join(clean.dir, "package-lock.json"))
    ? sha256(readFileSync(join(clean.dir, "package-lock.json")))
    : null;
  const unmodified = {
    command: "compare package-lock.json before and after npm ci",
    exitStatus: before === after ? 0 : 1,
    stdout: `${before} -> ${after}`,
    stderr: "",
  };
  // git reports any file the install touched, which is a stronger statement
  // than comparing one digest.
  const dirtyAfter = capture("git", ["status", "--porcelain"], { cwd: clean.dir });

  // The helper is resolved exactly the way the builder resolves it: an explicit
  // pin, then the canonical image's console script, then the repository's own
  // checkout. Importing it from an unqualified `python3` would test the machine
  // rather than the project.
  const helperSource = join(clean.dir, "tools", "portal-rst-renderer", "src");
  const rst = process.env.FREVA_PORTAL_RST
    ? capture(process.env.FREVA_PORTAL_RST, ["--help"])
    : capture(
        "python3",
        [
          "-c",
          "import freva_portal_rst, docutils; print(freva_portal_rst.__name__, docutils.__version__)",
        ],
        { env: { PYTHONPATH: helperSource, PYTHONDONTWRITEBYTECODE: "1" } },
      );

  record(
    "install",
    "Real npm ci in a clean extraction, lockfile unchanged, pinned RST helper",
    [...clean.commands, install, unmodified, rst],
    {
      extraction: clean.dir,
      lockfileDigestBefore: before,
      lockfileDigestAfter: after,
      lockfileUnmodified: before === after,
      treeCleanAfterInstall: dirtyAfter.stdout.trim() === "",
    },
  );
  rmSync(clean.dir, { recursive: true, force: true });
}

// -- compile ----------------------------------------------------------------
if (wanted("compile")) {
  record("compile", "Type-check: library, tests, client, Astro, Python helper", [
    capture("npm", ["run", "typecheck", "-w", "@freva-org/portal-builder"]),
    capture("python3", [
      "-m",
      "compileall",
      "-q",
      join(ROOT, "tools", "portal-rst-renderer", "src"),
    ]),
  ]);
}

// -- contracts --------------------------------------------------------------
if (wanted("contracts")) {
  const suite = capture("npx", ["vitest", "run", "--root", BUILDER, "--reporter", "basic"]);
  const counts = /Tests\s+(\d+) passed/.exec(`${suite.stdout}${suite.stderr}`);
  record(
    "contracts",
    "D1-D14 contracts, rendering profile, matrix, paths, security, STAC fixtures",
    [suite],
    {
      testsPassed: counts ? Number(counts[1]) : null,
    },
  );
}

// -- browser ----------------------------------------------------------------
if (wanted("browser")) {
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(browsers)) {
    skip(
      "browser",
      "Strict real-browser conformance",
      "a Playwright Chromium installation",
      `PLAYWRIGHT_BROWSERS_PATH '${browsers}' does not exist; run 'npx playwright install chromium'.`,
    );
  } else {
    record("browser", "Strict real-browser conformance", [
      capture("npm", ["run", "test:browser:strict", "-w", "@freva-org/portal-builder"]),
    ]);
  }
}

// -- package ----------------------------------------------------------------
if (wanted("package")) {
  record("package", "Pack, install from the tarball, build a fictional external consumer", [
    capture("npm", ["run", "test:packaging", "-w", "@freva-org/portal-builder"]),
  ]);
}

// -- hermeticity ------------------------------------------------------------
if (wanted("hermeticity")) {
  const out = join(tmpdir(), `fp001-hermetic-${process.pid}`);
  rmSync(out, { recursive: true, force: true });
  const deny = join(BUILDER, "tests", "helpers", "deny-network.cjs");
  const build = capture(
    process.execPath,
    [
      "--require",
      deny,
      CLI,
      "build",
      "--source-root",
      join(ROOT, "examples", "full-portal"),
      "--config",
      join(ROOT, "examples", "full-portal", "portal.yaml"),
      "--out",
      out,
      "--effective-at",
      "2026-08-18T00:00:00Z",
      "--quiet",
    ],
    { env: { SOURCE_DATE_EPOCH: "1760000000" } },
  );
  const settingsProbe = {
    command: "grep -R for a runtime settings or content lookup",
    exitStatus: 0,
    stdout: "",
    stderr: "",
  };
  if (build.exitStatus === 0) {
    const offenders = [];
    const walk = (dir, prefix = "") => {
      for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(dir, rel);
        else if (/\.(html|js|json)$/.test(rel)) {
          const text = readFileSync(join(dir, rel), "utf8");
          if (/\/api\/[a-z-]*\/?(settings|content)\b/i.test(text)) offenders.push(rel);
        }
      }
    };
    walk(out);
    settingsProbe.exitStatus = offenders.length === 0 ? 0 : 1;
    settingsProbe.stdout =
      offenders.length === 0
        ? "no runtime settings or content lookup in the artifact"
        : `runtime lookup in: ${offenders.join(", ")}`;
  } else {
    settingsProbe.exitStatus = 1;
    settingsProbe.stdout = "not evaluated: the network-denied build did not succeed";
  }
  record(
    "hermeticity",
    "Network-denied consumer build, no runtime settings/content lookup",
    [build, settingsProbe],
    {
      boundary:
        "A Node-level socket denial. It covers everything the builder does in process, " +
        "and it does not cover a native helper or a browser process, which have their own " +
        "sockets. The container gate is what covers those: it runs the same build inside " +
        "the canonical image with --network=none, which is enforced by the kernel.",
    },
  );
  rmSync(out, { recursive: true, force: true });
}

// -- reproducibility --------------------------------------------------------
if (wanted("reproducibility")) {
  // Two *clean extractions*, at absolute paths of different lengths, each
  // installed and built on its own. One checkout with two output directories
  // cannot detect a build whose result depends on where the source tree lives,
  // and the different lengths are what catches a path leaking into a recorded
  // value - a failure this project has actually had.
  const roots = ["r1", "r2-a-considerably-longer-source-directory-name"].map((suffix) =>
    join(tmpdir(), `fp001-repro-${process.pid}-${suffix}`),
  );
  const setup = [];
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const tarball = join(root, "source.tar");
    setup.push(capture("git", ["archive", "--format=tar", "-o", tarball, "HEAD"]));
    setup.push(capture("tar", ["-xf", tarball, "-C", root]));
    rmSync(tarball, { force: true });
    setup.push(capture("npm", ["ci", "--no-audit", "--no-fund"], { cwd: root }));
    // The prepared STAC materials are a network-enabled preparation output and
    // are not tracked, so each extraction is given the same prepared tree by
    // value. Its recorded tree digest is checked by the verification gate.
    setup.push(
      capture("cp", [
        "-R",
        join(ROOT, "packages", "stac-browser", "materials"),
        join(root, "packages", "stac-browser", "materials"),
      ]),
    );
    for (const workspace of [
      "@freva-org/freva-client-terminal",
      "@freva-org/databrowser",
      "@freva-org/ts-oidc-auth-client",
      "@freva-org/portal-builder",
    ]) {
      setup.push(capture("npm", ["run", "build", "-w", workspace], { cwd: root }));
    }
  }

  const builds = roots.map((root) => {
    const out = join(root, "artifact");
    return {
      out,
      run: capture(
        process.execPath,
        [
          join(root, "packages", "portal-builder", "bin", "freva-portal-builder.mjs"),
          "build",
          "--source-root",
          join(root, "examples", "full-portal"),
          "--config",
          join(root, "examples", "full-portal", "portal.yaml"),
          "--out",
          out,
          "--effective-at",
          "2026-08-18T00:00:00Z",
          "--quiet",
        ],
        { cwd: root, env: { SOURCE_DATE_EPOCH: "1760000000" } },
      ),
    };
  });

  const archives = builds.map(({ out }, i) => {
    const file = join(tmpdir(), `fp001-repro-archive-${process.pid}-${i + 1}.tar`);
    const run = capture(process.execPath, [CLI, "archive", "--dir", out, "--out", file]);
    return { run, file };
  });
  const digests = archives.map(({ file }) =>
    existsSync(file) ? sha256(readFileSync(file)) : null,
  );
  const identical = digests[0] !== null && digests[0] === digests[1];
  const comparison = {
    command: "compare two clean source trees by canonical release-archive digest",
    exitStatus: identical ? 0 : 1,
    stdout: `${digests[0]} vs ${digests[1]}`,
    stderr: "",
  };
  record(
    "reproducibility",
    "Two clean, differently located source trees produce identical canonical archives",
    [...setup, ...builds.map((b) => b.run), ...archives.map((a) => a.run), comparison],
    { sourceTrees: roots, archiveDigests: digests },
  );
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const { file } of archives) rmSync(file, { force: true });
}

// -- verification -----------------------------------------------------------
if (wanted("verification")) {
  const out = join(tmpdir(), `fp001-verify-${process.pid}`);
  rmSync(out, { recursive: true, force: true });
  const build = capture(
    process.execPath,
    [
      CLI,
      "build",
      "--source-root",
      join(ROOT, "examples", "full-portal"),
      "--config",
      join(ROOT, "examples", "full-portal", "portal.yaml"),
      "--out",
      out,
      "--effective-at",
      "2026-08-18T00:00:00Z",
      "--quiet",
    ],
    { env: { SOURCE_DATE_EPOCH: "1760000000" } },
  );
  const verify = capture(process.execPath, [CLI, "verify", "--dir", out]);
  const manifestDigests = {};
  if (build.exitStatus === 0) {
    for (const name of [
      "portal-manifest.json",
      "input-manifest.json",
      "component-evidence.json",
      "host-policy.json",
      "BUILDINFO.json",
      "checksums.sha256",
    ]) {
      const file = join(out, name);
      if (existsSync(file)) manifestDigests[name] = sha256(readFileSync(file));
    }
  }
  const bytes =
    build.exitStatus === 0
      ? readdirSync(out, { recursive: true }).filter((p) => {
          try {
            return statSync(join(out, String(p))).isFile();
          } catch {
            return false;
          }
        }).length
      : null;
  record(
    "verification",
    "Manifests validate structurally and match the artifact",
    [build, verify],
    {
      manifestDigests,
      fileCount: bytes,
    },
  );
  rmSync(out, { recursive: true, force: true });
}

// -- container --------------------------------------------------------------
if (wanted("container")) {
  const lock = join(ROOT, "container", "portal-builder", "base-images.lock");
  const runtime = toolVersions.docker ? (process.env.DOCKER ?? "docker") : null;
  const daemon = runtime ? capture(runtime, ["info", "--format", "{{.ServerVersion}}"]) : null;

  if (!runtime) {
    skip(
      "container",
      "Canonical image build and offline consumer build inside it",
      "a container runtime",
      "No docker/podman on PATH, so the canonical image cannot be built or run here.",
    );
  } else if (daemon.exitStatus !== 0) {
    skip(
      "container",
      "Canonical image build and offline consumer build inside it",
      "a running container daemon",
      `'${runtime} info' failed: ${tail(daemon.stderr, 3)}`,
    );
  } else if (!existsSync(lock)) {
    skip(
      "container",
      "Canonical image build and offline consumer build inside it",
      "container/portal-builder/base-images.lock",
      "Base-image digests are registry observations, never authored. Run container/portal-builder/resolve-base-digests.sh on a registry-connected machine, review the two references, and commit them.",
    );
  } else {
    const tag = `freva-portal-builder:acceptance-${process.pid}`;
    const build = capture("bash", [join(ROOT, "container", "portal-builder", "build.sh"), tag]);

    // The exact image that was built, by digest, so the consumer build below is
    // demonstrably the same bytes and the reference can be published.
    const inspect = capture(runtime, ["image", "inspect", tag, "--format", "{{json .}}"]);
    let image = null;
    if (inspect.exitStatus === 0) {
      try {
        const parsed = JSON.parse(inspect.stdout);
        image = {
          reference: tag,
          id: parsed.Id ?? null,
          repoDigests: parsed.RepoDigests ?? [],
          architecture: parsed.Architecture ?? null,
          os: parsed.Os ?? null,
        };
      } catch {
        image = null;
      }
    }

    // A real external consumer build, inside that image, with no network, a
    // read-only source mount and a separate output mount. RST, Mermaid and STAC
    // are all exercised because the full example enables all three.
    const workDir = join(tmpdir(), `fp001-container-${process.pid}`);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(join(workDir, "out"), { recursive: true });
    capture("cp", ["-R", join(ROOT, "examples", "full-portal"), join(workDir, "src")]);

    const runConsumer = capture(runtime, [
      "run",
      "--rm",
      "--network=none",
      "-e",
      "SOURCE_DATE_EPOCH=1760000000",
      "-v",
      `${join(workDir, "src")}:${join(workDir, "src")}:ro`,
      "-v",
      `${join(workDir, "out")}:${join(workDir, "out")}`,
      image?.id ? `${tag}` : tag,
      "build",
      "--source-root",
      join(workDir, "src"),
      "--config",
      join(workDir, "src", "portal.yaml"),
      "--out",
      join(workDir, "out", "portal"),
      "--effective-at",
      "2026-08-18T00:00:00Z",
      "--quiet",
    ]);

    const verifyInImage = capture(runtime, [
      "run",
      "--rm",
      "--network=none",
      "-v",
      `${join(workDir, "out")}:${join(workDir, "out")}:ro`,
      tag,
      "verify",
      "--dir",
      join(workDir, "out", "portal"),
    ]);

    const artifactChecksums = join(workDir, "out", "portal", "checksums.sha256");
    const artifact = {
      command: "the offline consumer build produced a complete artifact",
      exitStatus: existsSync(artifactChecksums) ? 0 : 1,
      stdout: existsSync(artifactChecksums)
        ? `checksums digest ${sha256(readFileSync(artifactChecksums))}`
        : "checksums.sha256 is absent",
      stderr: "",
    };

    record(
      "container",
      "Canonical image build and offline consumer build inside it",
      [build, inspect, runConsumer, verifyInImage, artifact],
      { image },
    );
    capture(runtime, ["image", "rm", "-f", tag]);
    rmSync(workDir, { recursive: true, force: true });
  }
}

// -- pilot ------------------------------------------------------------------
if (wanted("pilot")) {
  // The pilot is a build of somebody else's sources, so it needs somebody
  // else's sources. Everything it needs is named by an environment variable,
  // and every one of them is checked, so a missing input is reported by name
  // instead of turning into a green row.
  const docsRoot = process.env.WATERPARK_DOCS_ROOT;
  const overlay = process.env.PORTAL_PILOT_OVERLAY;
  const content = process.env.PORTAL_PILOT_CONTENT;
  const assets = process.env.PORTAL_PILOT_ASSETS;
  const docsSite = process.env.PORTAL_PILOT_DOCS_SITE;

  const missing = [];
  if (!docsRoot || !existsSync(docsRoot)) missing.push("WATERPARK_DOCS_ROOT");
  if (!overlay || !existsSync(overlay)) missing.push("PORTAL_PILOT_OVERLAY");
  if (!content || !existsSync(content)) missing.push("PORTAL_PILOT_CONTENT");
  if (!docsSite || !existsSync(docsSite)) missing.push("PORTAL_PILOT_DOCS_SITE");

  if (missing.length > 0) {
    skip(
      "pilot",
      "External-consumer smoke against consumer-owned documentation",
      missing.join(", "),
      "Follow packages/portal-builder/docs/external-consumer-playground.md: it stages a pilot overlay next to the consumer checkout, builds the documentation with the consumer's own generator, and sets these variables.",
    );
  } else {
    const stage = join(tmpdir(), `fp001-pilot-${process.pid}`);
    const out = join(tmpdir(), `fp001-pilot-out-${process.pid}`);
    const result = join(tmpdir(), `fp001-pilot-${process.pid}.json`);
    rmSync(stage, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
    const copies = [`${overlay}=portal`, `${content}=content`, `${docsSite}=reference-docs`];
    if (assets && existsSync(assets)) copies.push(`${assets}=assets`);
    // The published command, not a workspace script: the gate exercises what a
    // consumer would actually have after installing the package.
    const args = [
      join(BUILDER, "bin", "freva-portal-builder.mjs"),
      "smoke",
      "--stage",
      stage,
      ...copies.flatMap((copy) => ["--copy", copy]),
      "--config",
      "portal/portal.yaml",
      "--out",
      out,
      "--result",
      result,
    ];
    const smoke = capture(process.execPath, args, {
      env: { SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? "1760000000" },
    });
    const parsed = existsSync(result) ? JSON.parse(readFileSync(result, "utf8")) : null;
    record("pilot", "External-consumer smoke against consumer-owned documentation", [smoke], {
      consumerRoot: docsRoot,
      smokeResult: parsed
        ? {
            result: parsed.result,
            builder: parsed.builder,
            inputManifestDigest: parsed.inputManifestDigest,
            artifactChecksumsDigest: parsed.artifactChecksumsDigest,
            failedChecks: parsed.failedChecks,
            steps: parsed.steps.map((s) => ({ name: s.name, exitStatus: s.exitStatus })),
          }
        : null,
    });
    rmSync(out, { recursive: true, force: true });
    rmSync(result, { force: true });
  }
}

// -- report -----------------------------------------------------------------
const revision = capture("git", ["rev-parse", "HEAD"]);
const dirty = capture("git", ["status", "--porcelain"]);

// A required gate that `--only` skipped never ran either. Counting only the
// gates that recorded a `not-run` would let `--only closure` produce a report
// that calls itself releasable.
const recorded = new Set(gates.map((gate) => gate.id));
const requiredNotRun = [
  ...gates
    .filter((gate) => gate.status === "not-run" && REQUIRED.has(gate.id))
    .map((gate) => gate.id),
  ...[...REQUIRED].filter((id) => !recorded.has(id)),
].sort();
const waived = requiredNotRun.filter((id) => allowNotRun.has(id));
// The exit status judges the gates this run selected. A gate `--only` excluded
// was not attempted, so it is not this run's failure - but it does keep the
// report from claiming to be a release, which is what `releasable` is for.
const blocking = requiredNotRun.filter((id) => recorded.has(id) && !allowNotRun.has(id));
const failed = gates.filter((gate) => gate.status === "fail").map((gate) => gate.id);

const report = {
  schemaVersion: 1,
  kind: "fp001-acceptance",
  specification: "FP-001 v1.5",
  revision: revision.exitStatus === 0 ? revision.stdout.trim() : null,
  revisionNote:
    "The revision the gates ran against. When this report is then committed, the " +
    "commit that carries it is a child of that revision and differs from it only " +
    "by this file, which no gate reads as input.",
  workingTreeClean: dirty.exitStatus === 0 ? dirty.stdout.trim() === "" : null,
  sourceDateEpoch: process.env.SOURCE_DATE_EPOCH ?? null,
  platform: { os: process.platform, arch: process.arch },
  toolVersions,
  requiredGates: [...REQUIRED].sort(),
  gates,
  summary: {
    pass: gates.filter((g) => g.status === "pass").length,
    fail: failed.length,
    notRun: gates.filter((g) => g.status === "not-run").length,
  },
  /**
   * The single field a release decision reads. A required gate that did not run
   * is not a pass, and a waiver does not make it one - it only records that
   * somebody chose to continue anyway, and says so here.
   */
  releasable: failed.length === 0 && requiredNotRun.length === 0,
  failedGates: failed,
  requiredNotRun,
  waivedNotRun: waived,
  ...(requiredNotRun.length > 0
    ? {
        notReleasableBecause: requiredNotRun.map((id) => {
          const gate = gates.find((g) => g.id === id);
          return {
            gate: id,
            missingInput: gate?.missingInput ?? (gate ? null : "the gate was not selected to run"),
            detail: gate?.detail ?? (gate ? null : "excluded by --only"),
          };
        }),
      }
    : {}),
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`[acceptance] wrote ${outFile}\n`);
process.stdout.write(
  `[acceptance] ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.notRun} not-run\n`,
);
if (requiredNotRun.length > 0) {
  for (const id of requiredNotRun) {
    const gate = gates.find((g) => g.id === id);
    process.stdout.write(
      `[acceptance] REQUIRED GATE DID NOT RUN: ${id} - missing ${gate?.missingInput ?? "an unnamed input"}\n`,
    );
  }
}
if (waived.length > 0) {
  process.stdout.write(
    `[acceptance] waived by --allow-not-run: ${waived.join(", ")}. The report is marked NOT releasable.\n`,
  );
}
process.stdout.write(`[acceptance] releasable: ${report.releasable}\n`);

// Nonzero when anything failed, and nonzero when a required gate did not run
// unless it was explicitly waived. A waiver still leaves `releasable: false`.
process.exit(failed.length === 0 && blocking.length === 0 ? 0 : 1);
