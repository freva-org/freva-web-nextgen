/**
 * Publish workspace packages one at a time, in dependency order.
 *
 * `changeset publish` fires them off together, so a package can reach the
 * registry before something it needs. npm does not check that, and the result
 * installs cleanly for us - the workspace resolves locally - and not for
 * anyone else.
 *
 * Two kinds of edge count, because only one of them is in package.json:
 *   - declared `dependencies` / `peerDependencies` on another workspace package
 *   - a pinned `https://esm.sh/<pkg>@<version>` import in the source, which the
 *     browser fetches from npm at runtime
 *
 * A package publishes only once every edge is resolvable on npm at its pinned
 * version. Versions already on the registry are skipped, so re-running finishes
 * a partial release rather than failing. One package failing skips only the
 * packages that depend on it.
 *
 * Usage: node scripts/publish-packages.mjs [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const DRY = process.argv.includes("--dry-run");
const REGISTRY = "https://registry.npmjs.org";

/** Tie-break for packages with no edge between them: building blocks first. */
const PREFERRED = [
  "@freva-org/freva-client-terminal",
  "@freva-org/ts-oidc-auth-client",
  "@freva-org/data-inspector",
  "@freva-org/databrowser",
];

const log = (m) => process.stdout.write(`${m}\n`);
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts });

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Is this exact version on the registry? A network error is not a "no". */
function isPublished(name, version) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return (
        run("npm", ["view", `${name}@${version}`, "version", `--registry=${REGISTRY}`]).trim() ===
        version
      );
    } catch (err) {
      const text = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      if (/E404|no match(ing)? version|is not in this registry/i.test(text)) return false;
      if (attempt === 3) throw new Error(`npm view ${name}@${version} failed: ${text.trim()}`);
      sleep(2000 * attempt);
    }
  }
  return false;
}

/** The registry is read-through-cached, so a fresh version is not instantly visible. */
function waitForRegistry(name, version, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isPublished(name, version)) return true;
    sleep(5000);
  }
  return false;
}

function sourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|mjs|js)$/.test(full)) out.push(full);
  }
  return out;
}

const workspaces = readdirSync("packages")
  .map((d) => ({ dir: join("packages", d) }))
  .filter((w) => existsSync(join(w.dir, "package.json")))
  .map((w) => ({ ...w, pkg: JSON.parse(readFileSync(join(w.dir, "package.json"), "utf8")) }))
  .filter((w) => !w.pkg.private);

const byName = new Map(workspaces.map((w) => [w.pkg.name, w]));
const CDN = /https:\/\/esm\.sh\/(@[\w.-]+\/[\w.-]+)@([\w.-]+)/g;

/** Every workspace package this one needs on npm, with the version it pins. */
function edgesOf(w) {
  const found = new Map();
  const declared = { ...w.pkg.dependencies, ...w.pkg.peerDependencies };
  for (const [name, version] of Object.entries(declared)) {
    if (byName.has(name)) found.set(name, version);
  }
  for (const file of sourceFiles(join(w.dir, "src"))) {
    for (const [, name, version] of readFileSync(file, "utf8").matchAll(CDN)) {
      if (byName.has(name)) found.set(name, version);
    }
  }
  return [...found].map(([name, version]) => ({ name, version }));
}

function publishOrder() {
  const rank = (n) => (PREFERRED.indexOf(n) === -1 ? PREFERRED.length : PREFERRED.indexOf(n));
  const pending = [...workspaces].sort((a, b) => rank(a.pkg.name) - rank(b.pkg.name));
  const done = new Set();
  const ordered = [];
  while (pending.length) {
    const i = pending.findIndex((w) => edgesOf(w).every((e) => done.has(e.name)));
    if (i === -1) throw new Error(`Cycle among: ${pending.map((w) => w.pkg.name).join(", ")}`);
    const [w] = pending.splice(i, 1);
    done.add(w.pkg.name);
    ordered.push(w);
  }
  return ordered;
}

const ordered = publishOrder();
log("Publish order:");
for (const w of ordered) {
  const edges = edgesOf(w);
  log(
    `  ${w.pkg.name}@${w.pkg.version}${edges.length ? `  needs ${edges.map((e) => `${e.name}@${e.version}`).join(", ")}` : ""}`,
  );
}
log("");

const published = [];
const skipped = [];
const failed = new Set();

for (const w of ordered) {
  const { name, version } = w.pkg;
  const edges = edgesOf(w);

  const blocked = edges.filter((e) => failed.has(e.name)).map((e) => e.name);
  if (blocked.length) {
    log(`- ${name}@${version}: SKIPPED, waiting on ${blocked.join(", ")}`);
    failed.add(name);
    continue;
  }

  if (isPublished(name, version)) {
    log(`- ${name}@${version}: already on npm`);
    skipped.push(`${name}@${version}`);
    continue;
  }

  // In a dry run a package published earlier in this same pass counts as present,
  // so the plan reads as it would really unfold.
  const satisfied = (e) =>
    (DRY && published.includes(`${e.name}@${e.version}`)) || isPublished(e.name, e.version);
  const missing = edges.filter((e) => !satisfied(e));
  if (missing.length) {
    const list = missing.map((e) => `${e.name}@${e.version}`).join(", ");
    log(`- ${name}@${version}: FAILED, not installable yet - ${list} is not on npm`);
    failed.add(name);
    continue;
  }

  if (DRY) {
    log(`- ${name}@${version}: would publish`);
    published.push(`${name}@${version}`);
    continue;
  }

  try {
    log(`- ${name}@${version}: publishing...`);
    run("npm", ["publish", "--provenance", "--access=public"], { cwd: w.dir, stdio: "inherit" });
  } catch (err) {
    const text = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (/EPUBLISHCONFLICT|cannot publish over/i.test(text)) {
      log(`- ${name}@${version}: already on npm`);
      skipped.push(`${name}@${version}`);
      continue;
    }
    log(`- ${name}@${version}: FAILED\n${text.trim()}`);
    failed.add(name);
    continue;
  }

  if (!waitForRegistry(name, version)) {
    log(`- ${name}@${version}: published, but the registry has not served it yet`);
    failed.add(name);
    continue;
  }
  log(`- ${name}@${version}: published`);
  published.push(`${name}@${version}`);
}

log("");
if (published.length) log(`Published: ${published.join(", ")}`);
if (skipped.length) log(`Already published: ${skipped.join(", ")}`);
if (failed.size) log(`Failed: ${[...failed].join(", ")}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `published=${JSON.stringify(published)}\n`);
}
process.exit(failed.size ? 1 : 0);
