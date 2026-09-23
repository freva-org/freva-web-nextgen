/**
 * The licence inventory for what this package distributes.
 *
 * "Distributes" is doing real work in that sentence. The builder is a build tool: most of its
 * dependency tree runs during a build and never reaches a reader. What reaches a reader is the
 * browser code the compiler bundles into a consumer artifact, the files the builder copies into
 * one, and the prepared third-party materials the image carries. Conflating the two is how a
 * licence report becomes misleading, so they are enumerated separately and labelled.
 *
 * Naming `@freva-org/databrowser` without the packages it pulls into the same bundle is not a
 * bill of materials, so the distributed set is the transitive closure resolved from the
 * repository's own `package-lock.json` - the file that decides what is actually installed -
 * rather than from whatever happens to be in `node_modules` today. Its roots stay written down,
 * because "which packages reach a reader" is a fact about the code and not something a script
 * can infer safely; `tests/packaging/licence-inventory.test.ts` derives them from the component
 * registry and the browser sources and fails when the two disagree.
 *
 * This is tooling output. It is not a legal opinion and not approval to redistribute.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "../..");
const OUT = join(PKG, "reports");
mkdirSync(OUT, { recursive: true });

const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));

/**
 * Package roots whose bytes reach a reader, and why each one does. Everything reachable from
 * these through the lockfile is distributed too, which is what makes the closure below
 * meaningful. `freva-client-terminal` is deliberately absent: it reaches an artifact through
 * the Data Browser rather than through this package, so the closure finds it anyway.
 */
const DISTRIBUTED_ROOTS = {
  "@freva-org/databrowser": "imported by the Data Browser island",
  "@freva-org/dataset-tree": "imported by the dataset-tree landing block",
  "@freva-org/data-inspector":
    "loaded on demand when a reader presses Inspect on a store - a chunk this artifact serves, " +
    "even though a visitor who never presses it never fetches one",
  "@freva-org/browser-python":
    "loaded on demand by the dataset-tree block's Python playground - a chunk a reader " +
    "downloads only after pressing Try in Python, which is still a chunk this artifact serves",
  "@freva-org/ts-oidc-auth-client": "imported by the auth island",
  "@freva-org/freva-badge": "its dist/ is copied into every artifact as _badge/",
  katex: "its stylesheet, and the fonts inlined in it, are published with the artifact",
};

/**
 * Everything the lockfile says those roots pull in. Resolution follows npm's own rule - look
 * under the dependent, then walk up towards the root - because a hoisted tree can hold two
 * versions of one package and the answer depends on who is asking. Development and optional
 * dependencies are not followed: a consumer never installs them.
 */
function distributedClosure(lock) {
  const packages = lock.packages ?? {};
  const resolveFrom = (dependentPath, name) => {
    const segments = dependentPath === "" ? [] : dependentPath.split("/");
    for (let i = segments.length; i >= 0; i -= 1) {
      const prefix = segments.slice(0, i).join("/");
      const candidate = `${prefix ? `${prefix}/` : ""}node_modules/${name}`;
      if (packages[candidate]) return candidate;
    }
    return undefined;
  };

  const seen = new Map();
  const queue = [];
  for (const name of Object.keys(DISTRIBUTED_ROOTS)) {
    const path = resolveFrom("packages/portal-builder", name) ?? resolveFrom("", name);
    if (path) queue.push(path);
  }
  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    const entry = packages[path];
    if (!entry) continue;
    seen.set(path, entry);
    // Follow a workspace link to its directory so the closure sees the package, not the symlink.
    const real = entry.link && entry.resolved ? entry.resolved : path;
    for (const name of Object.keys({
      ...(packages[real]?.dependencies ?? entry.dependencies ?? {}),
      ...(packages[real]?.peerDependencies ?? entry.peerDependencies ?? {}),
    })) {
      const next = resolveFrom(real, name);
      if (next && !seen.has(next)) queue.push(next);
    }
    if (real !== path && !seen.has(real)) queue.push(real);
  }

  const out = new Map();
  const MARKER = "node_modules/";
  for (const [path, entry] of seen) {
    // A link aliases a workspace directory; the workspace itself is in `seen` with the version
    // and licence.
    if (entry.link) continue;
    const at = path.lastIndexOf(MARKER);
    // Workspaces are keyed by directory ("packages/databrowser"); only a node_modules path
    // encodes the package name in the key.
    const name = at >= 0 ? path.slice(at + MARKER.length) : (entry.name ?? path);
    const version = entry.version ?? "unresolved";
    out.set(`${name}@${version}`, { name, version, license: entry.license ?? undefined });
  }
  return out;
}

function readPackage(name) {
  const candidates = [
    join(PKG, "node_modules", ...name.split("/"), "package.json"),
    join(REPO, "node_modules", ...name.split("/"), "package.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate))
      return { json: JSON.parse(readFileSync(candidate, "utf8")), dir: dirname(candidate) };
  }
  return undefined;
}

function licenceOf(entry) {
  if (!entry) return "UNKNOWN";
  const { license, licenses } = entry.json;
  if (typeof license === "string") return license;
  if (license?.type) return license.type;
  if (Array.isArray(licenses)) return licenses.map((l) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

const lockPath = join(REPO, "package-lock.json");
if (!existsSync(lockPath)) {
  throw new Error(
    `No ${lockPath}. The inventory is resolved from the lockfile - the file that decides what is ` +
      "actually installed - rather than from whatever node_modules happens to hold.",
  );
}
const closure = distributedClosure(JSON.parse(readFileSync(lockPath, "utf8")));

const components = [];
const emitted = new Set();
for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
  const entry = readPackage(name);
  const reason = DISTRIBUTED_ROOTS[name];
  const version = entry?.json.version ?? "unresolved";
  emitted.add(`${name}@${version}`);
  // A direct dependency can be distributed WITHOUT being a named root: another root pulls it
  // into an artifact. `@freva-org/freva-client-terminal` is exactly that - the Data Browser and
  // the Python playground both import it. So the role follows the flag, not the root list alone.
  const reached = [...closure.values()].some((c) => c.name === name);
  components.push({
    name,
    range,
    version,
    license: licenceOf(entry),
    distributed: Boolean(reason) || reached,
    role: reason
      ? reason
      : reached
        ? "reached from a distributed package; bundled into the consumer artifact"
        : "build-time only; not distributed to a reader",
  });
}
for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
  const entry = readPackage(name);
  const version = entry?.json.version ?? "unresolved";
  emitted.add(`${name}@${version}`);
  components.push({
    name,
    range,
    version,
    license: licenceOf(entry),
    distributed: false,
    role: "development and test tooling",
  });
}
// Everything the distributed roots reach beyond this package's direct dependencies: packages a
// reader receives all the same.
for (const [key, entry] of closure) {
  if (emitted.has(key)) continue;
  const resolved = readPackage(entry.name);
  components.push({
    name: entry.name,
    range: "(transitive)",
    version: entry.version,
    license: entry.license ?? licenceOf(resolved),
    distributed: true,
    role: "reached from a distributed package; bundled into the consumer artifact",
  });
}

// Prepared STAC materials: third-party bytes the image carries and an artifact copies when the
// component is enabled.
const stacPin = join(REPO, "packages", "stac-browser", "upstream.json");
const stacMaterials = join(REPO, "packages", "stac-browser", "materials", "materials.json");
let stac;
if (existsSync(stacPin)) {
  const pin = JSON.parse(readFileSync(stacPin, "utf8"));
  stac = {
    name: pin.name,
    version: pin.tag,
    commit: pin.commit,
    license: pin.license,
    distributed: true,
    role: "prepared third-party application, copied when the STAC component is enabled",
    preparedDigest: existsSync(stacMaterials)
      ? JSON.parse(readFileSync(stacMaterials, "utf8")).treeDigest
      : "not prepared in this checkout",
  };
}

const report = {
  schemaVersion: 1,
  package: { name: manifest.name, version: manifest.version, license: manifest.license },
  components: components.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  ...(stac ? { preparedMaterials: [stac] } : {}),
  note: "Generated by scripts/license-report.mjs. An inventory, not a legal opinion.",
};

writeFileSync(join(OUT, "licenses.json"), `${JSON.stringify(report, null, 2)}\n`);

const lines = [
  `# Licence inventory - ${manifest.name} ${manifest.version}`,
  "",
  "| Package | Version | Licence | Distributed | Role |",
  "| --- | --- | --- | --- | --- |",
  ...report.components.map(
    (c) =>
      `| \`${c.name}\` | ${c.version} | ${c.license} | ${c.distributed ? "yes" : "no"} | ${c.role} |`,
  ),
];
if (stac) {
  lines.push(
    "",
    "## Prepared third-party materials",
    "",
    `- \`${stac.name}\` ${stac.version} (${stac.commit.slice(0, 12)}), ${stac.license}; prepared tree ${stac.preparedDigest}`,
  );
}
writeFileSync(join(OUT, "licenses.md"), `${lines.join("\n")}\n`);

console.log(
  `[licenses] ${report.components.length} package(s); ${report.components.filter((c) => c.distributed).length} distributed`,
);

// A dependency with no resolvable licence is a supply-chain gap, not a detail.
const unknown = report.components.filter((c) => c.license === "UNKNOWN");
if (unknown.length > 0) {
  console.error(`[licenses] unresolved licence for: ${unknown.map((c) => c.name).join(", ")}`);
  process.exitCode = 1;
}

// Silence an unused-binding lint in environments without git.
void execFileSync;
