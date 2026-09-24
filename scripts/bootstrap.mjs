#!/usr/bin/env node
/**
 * Prepare a checkout so that `npm test` can pass.
 *
 * Two prerequisites of the portal builder's suite are not npm packages, so
 * `npm install` cannot produce them and a fresh extraction fails without them:
 *
 *   1. The pinned RST helper. `portal-content-v1` names an exact helper version
 *      and an exact Docutils version, and the builder compares the whole
 *      handshake rather than accepting anything that speaks the protocol. Without
 *      it every RST test reports FP1701.
 *   2. The compiled workspace packages. Several tests run the CLI through
 *      `bin/freva-portal-builder.mjs`, which loads `dist/`.
 * STAC Browser is deliberately NOT one of them. Preparing it fetches and compiles a third-party
 * application and installs about 800 upstream dependencies, and a repository that did that on
 * every bootstrap would make everyone pay for a feature almost nobody enables. It is a separate,
 * explicit, network-enabled stage that a deployment runs only when it has enabled the
 * `stac-browser` component:
 *
 *   npm run stac:prepare -- --out <dir>
 *
 * The STAC tests that need materials skip themselves when none are present, so a bootstrap
 * without them is a complete, passing checkout rather than a broken one.
 *
 * Everything here is idempotent, so running it twice is cheap, and every step
 * reports what it decided rather than only what it did.
 *
 *   node scripts/bootstrap.mjs              # both
 *   node scripts/bootstrap.mjs --rst        # one step, by name
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(REPO, "tools", "portal-rst-renderer");
const VENV = join(TOOL, ".venv");
const WINDOWS = process.platform === "win32";
const BIN = join(VENV, WINDOWS ? "Scripts" : "bin");
const VENV_PYTHON = join(BIN, WINDOWS ? "python.exe" : "python3");
const VENV_SCRIPT = join(BIN, WINDOWS ? "freva-portal-rst.exe" : "freva-portal-rst");

/** The one place the pin is written down for this script. */
const DOCUTILS = "0.23";

const argv = process.argv.slice(2);
const only = new Set(argv.filter((a) => a.startsWith("--") && !a.startsWith("--no-")));
const skip = new Set(argv.filter((a) => a.startsWith("--no-")));
const wanted = (name) => !skip.has(`--no-${name}`) && (only.size === 0 || only.has(`--${name}`));

let failures = 0;

function step(title) {
  process.stdout.write(`\n• ${title}\n`);
}
function say(line) {
  process.stdout.write(`  ${line}\n`);
}
function fail(line, remedy) {
  failures += 1;
  process.stdout.write(`  ! ${line}\n`);
  if (remedy) process.stdout.write(`    ${remedy}\n`);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: REPO,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    ...options,
  });
}

/** A helper that answers the handshake with the pinned Docutils, or nothing. */
function handshakeOf(command, args = [], env) {
  const probe = run(command, args, {
    input: `${JSON.stringify({ op: "hello" })}\n`,
    env: env ?? process.env,
    timeout: 30_000,
  });
  const line = (probe.stdout ?? "").split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function describe(shake) {
  return `${shake.package ?? "?"} ${shake.version ?? "?"} (docutils ${shake.docutils ?? "?"})`;
}

// -- 1. the pinned RST helper ------------------------------------------------
function bootstrapRst() {
  step("RST helper (portal-content-v1 pins docutils " + DOCUTILS + ")");

  const pin = process.env.FREVA_PORTAL_RST;
  if (pin) {
    const pinned = handshakeOf(pin);
    if (pinned?.docutils === DOCUTILS) {
      say(`FREVA_PORTAL_RST names a helper that matches: ${describe(pinned)}`);
      return;
    }
    fail(
      `FREVA_PORTAL_RST is set to ${pin}, which does not answer with docutils ${DOCUTILS}.`,
      "A pin is exclusive - unset it to let the bootstrap create a virtual environment instead.",
    );
    return;
  }

  const onPath = handshakeOf("freva-portal-rst");
  if (onPath?.docutils === DOCUTILS) {
    say(`already on PATH: ${describe(onPath)}`);
    return;
  }

  if (existsSync(VENV_SCRIPT)) {
    const inVenv = handshakeOf(VENV_SCRIPT);
    if (inVenv?.docutils === DOCUTILS) {
      say(`already bootstrapped: ${describe(inVenv)}`);
      say(`interpreter: ${VENV_PYTHON}`);
      return;
    }
  }

  const python =
    process.env.PYTHON ??
    ["python3", "python"].find((c) => run(c, ["--version"]).status === 0) ??
    undefined;
  if (!python) {
    fail(
      "no python3 was found on PATH.",
      "Install Python 3.11 or newer, or set PYTHON=/path/to/python3.",
    );
    return;
  }
  say(`interpreter: ${python} (${(run(python, ["--version"]).stdout ?? "").trim()})`);

  if (!existsSync(VENV_PYTHON)) {
    say(`creating ${VENV}`);
    mkdirSync(TOOL, { recursive: true });
    const made = run(python, ["-m", "venv", VENV], { inherit: true });
    if (made.status !== 0) {
      fail(
        "could not create the virtual environment.",
        "On Debian/Ubuntu this usually means the python3-venv package is missing.",
      );
      return;
    }
  }

  say(`installing ${TOOL} with its pinned docutils`);
  const installed = run(VENV_PYTHON, ["-m", "pip", "install", "--quiet", "--upgrade", TOOL], {
    inherit: true,
  });
  if (installed.status !== 0) {
    fail(
      "pip could not install the helper.",
      `With no network available, install it yourself: pip install docutils==${DOCUTILS} && pip install ${TOOL}`,
    );
    return;
  }

  // setuptools scratches a `build/` tree into the source directory. It is not
  // an input to anything, and leaving it behind would only make `git status`
  // noisier for the next person.
  rmSync(join(TOOL, "build"), { recursive: true, force: true });

  const shake = handshakeOf(VENV_SCRIPT) ?? handshakeOf(VENV_PYTHON, ["-m", "freva_portal_rst"]);
  if (shake?.docutils !== DOCUTILS) {
    fail(
      `the installed helper answers docutils=${shake?.docutils ?? "nothing"}, not ${DOCUTILS}.`,
      "Delete tools/portal-rst-renderer/.venv and run this again.",
    );
    return;
  }
  say(`ready: ${describe(shake)}`);
}

// -- 2. compiled workspace packages ------------------------------------------
/*
 * Dependencies first, dependents last.
 *
 * Every package here is consumed from its `dist/`, which a clean extraction does not have: `npm ci`
 * links the workspaces but runs no build. So a package must be built before anything that imports
 * it, and `@freva-org/portal-builder` is last because it imports every one of the others.
 *
 * `@freva-org/dataset-tree` was missing from this list when the landing block that imports
 * `@freva-org/dataset-tree/snapshot` landed. Nothing noticed in a working checkout, where every
 * `dist/` was already on disk; a fresh clone or archive failed at the first portal-builder build
 * with an unresolved import. Adding a workspace dependency means adding it here.
 */
/*
 * DEPENDENCIES FIRST. `tests/contracts/repository-boundary.test.ts` reads this list and checks it
 * against every workspace manifest, so an entry in the wrong place is a failing test rather than a
 * stale `dist/` somebody debugs later.
 *
 * `@freva-org/data-inspector` moved ahead of `@freva-org/databrowser` when the Data Browser stopped
 * fetching the inspector from a CDN and started declaring it as an ordinary dependency. Built in
 * the old order it compiled against an inspector that had no `dist/` yet.
 */
const BUILD_ORDER = [
  "@freva-org/freva-client-terminal",
  // The in-page store inspector: a dependency of the Data Browser, and the panel the dataset-tree
  // block opens for a `.zarr` store.
  "@freva-org/data-inspector",
  "@freva-org/browser-python",
  "@freva-org/databrowser",
  "@freva-org/ts-oidc-auth-client",
  "@freva-org/dataset-tree",
  "@freva-org/portal-builder",
];

function bootstrapBuild() {
  step("workspace builds");
  if (!existsSync(join(REPO, "node_modules"))) {
    fail("node_modules is missing.", "Run npm install first.");
    return;
  }
  for (const pkg of BUILD_ORDER) {
    const built = run("npm", ["run", "build", "-w", pkg], { inherit: true });
    if (built.status !== 0) {
      fail(`npm run build -w ${pkg} failed.`);
      return;
    }
  }
  say("dist/ is current for every package the tests execute");
}

if (wanted("rst")) bootstrapRst();
if (wanted("build")) bootstrapBuild();

process.stdout.write(
  failures === 0
    ? "\nBootstrap complete. `npm test` should now pass from a clean extraction.\n"
    : `\n${failures} step(s) need attention; see the notes above.\n`,
);
process.exit(failures === 0 ? 0 : 1);
