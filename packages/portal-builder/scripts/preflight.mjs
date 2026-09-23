#!/usr/bin/env node
/**
 * What `npm test` needs that `npm install` cannot provide: the compiled `dist/` the CLI tests
 * execute, the pinned RST helper, and the prepared STAC Browser materials. Missing, they fail
 * as a hundred FP1701s, a handful of FP1604s or `Cannot find module .../dist/index.js` rather
 * than by name, so `dist/` is rebuilt here and the other two reported with their fix command.
 *
 * Set FREVA_SKIP_PREFLIGHT=1 to run the suite anyway.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "..", "..");

if (process.env.FREVA_SKIP_PREFLIGHT === "1") process.exit(0);

const problems = [];
/** Things worth saying that are not reasons to refuse to run. */
const notes = [];

/** Newest mtime under a directory, ignoring the usual noise. */
function newest(dir) {
  let latest = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else latest = Math.max(latest, statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return latest;
}

// dist: cheap and offline, so repair it rather than complain about it.
const distEntry = join(PKG, "dist", "index.js");
if (!existsSync(distEntry) || newest(join(PKG, "src")) > statSync(distEntry).mtimeMs) {
  process.stdout.write("preflight: compiling dist/ (the CLI tests execute it)\n");
  const built = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], {
    cwd: PKG,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (built.status !== 0)
    problems.push(["dist/ did not compile.", "npm run build -w @freva-org/portal-builder"]);
}

// The pinned RST helper.
const TOOL = join(REPO, "tools", "portal-rst-renderer");
const WINDOWS = process.platform === "win32";
const BIN = join(TOOL, ".venv", WINDOWS ? "Scripts" : "bin");

function speaks(command, args = [], env) {
  const probe = spawnSync(command, args, {
    input: `${JSON.stringify({ op: "hello" })}\n`,
    encoding: "utf8",
    timeout: 30_000,
    env: env ?? process.env,
  });
  const line = (probe.stdout ?? "").split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

// `FREVA_PORTAL_RST` is an exclusive pin, exactly as the builder treats it.
const rstCandidates = process.env.FREVA_PORTAL_RST
  ? [[process.env.FREVA_PORTAL_RST, []]]
  : [
      ["freva-portal-rst", []],
      [join(BIN, WINDOWS ? "freva-portal-rst.exe" : "freva-portal-rst"), []],
      [
        join(BIN, WINDOWS ? "python.exe" : "python3"),
        ["-m", "freva_portal_rst"],
        { ...process.env, PYTHONPATH: join(TOOL, "src"), PYTHONDONTWRITEBYTECODE: "1" },
      ],
      [
        process.env.PYTHON ?? "python3",
        ["-m", "freva_portal_rst"],
        { ...process.env, PYTHONPATH: join(TOOL, "src"), PYTHONDONTWRITEBYTECODE: "1" },
      ],
    ];

const helper = rstCandidates.map(([c, a, e]) => speaks(c, a, e)).find((s) => s?.docutils);
if (!helper) {
  problems.push([
    "the pinned RST helper is not installed, so every RST test would report FP1701.",
    "node scripts/bootstrap.mjs --rst          (or: pip install ./tools/portal-rst-renderer)",
  ]);
}

// Prepared STAC Browser materials: a note, not a prerequisite. Preparing STAC fetches and
// compiles a third-party application plus about 800 upstream dependencies, so demanding it
// would make every contributor pay for a feature almost nobody enables. The tests that read
// the materials skip themselves when there are none.
const stacMaterials =
  process.env.FREVA_PORTAL_STAC_MATERIALS ?? join(REPO, "packages", "stac-browser", "materials");
if (!existsSync(join(stacMaterials, "materials.json"))) {
  notes.push([
    "no prepared STAC Browser materials; the tests that need them will skip.",
    "npm run stac:prepare -- --out <dir>      (needs network; only a deployment that enables the component needs it)",
  ]);
}

for (const [what, how] of notes) {
  process.stdout.write(`note: ${what}\n      ${how}\n`);
}

if (problems.length > 0) {
  process.stderr.write("\nThis checkout is not ready to run the portal builder suite:\n\n");
  for (const [what, how] of problems) process.stderr.write(`  - ${what}\n      ${how}\n`);
  process.stderr.write(
    "\nAll of it at once:  node scripts/bootstrap.mjs\n" +
      "Run the suite anyway with FREVA_SKIP_PREFLIGHT=1.\n\n",
  );
  process.exit(1);
}
