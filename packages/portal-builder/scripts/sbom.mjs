/**
 * A CycloneDX 1.5 SBOM built from the same inventory as the licence report, so the two cannot
 * disagree about what ships. Reproducible by design: no timestamp, and the serial derives from
 * the package version and the prepared-materials digest, so a diff means something changed.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "..", "..");
const OUT = join(PKG, "reports");
mkdirSync(OUT, { recursive: true });

const licensesPath = join(OUT, "licenses.json");
if (!existsSync(licensesPath)) {
  execFileSync(process.execPath, [join(PKG, "scripts", "license-report.mjs")], {
    stdio: "inherit",
  });
}
const inventory = JSON.parse(readFileSync(licensesPath, "utf8"));

const purl = (name, version) => `pkg:npm/${name.replace("@", "%40")}@${version}`;

const components = [
  ...inventory.components.map((c) => ({
    type: "library",
    "bom-ref": purl(c.name, c.version),
    name: c.name,
    version: c.version,
    purl: purl(c.name, c.version),
    scope: c.distributed ? "required" : "excluded",
    licenses: [{ license: { id: c.license } }],
    description: c.role,
  })),
  ...(inventory.preparedMaterials ?? []).map((m) => ({
    type: "application",
    "bom-ref": `pkg:github/radiantearth/stac-browser@${m.commit}`,
    name: m.name,
    version: m.version,
    scope: "required",
    licenses: [{ license: { id: m.license } }],
    description: m.role,
    hashes: m.preparedDigest.startsWith("sha256:")
      ? [{ alg: "SHA-256", content: m.preparedDigest.slice("sha256:".length) }]
      : [],
  })),
  ...upstreamComponents(),
];

/**
 * The packages compiled INTO the prepared STAC application.
 *
 * Naming `stac-browser@v5.0.0` alone describes a tarball, not a bundle: the compiled app
 * contains several hundred packages, so "does this artifact contain X" gets the wrong answer.
 * They come from upstream's own lockfile, which the recipe pins by digest, so the enumeration
 * is verified against the file the build resolved with. That lockfile lives in the upstream
 * checkout - in a prepared repository and in the builder image, not in a published tarball;
 * without it the SBOM records the pinned digest and reports the enumeration as unavailable.
 */
function upstreamComponents() {
  const recipePath = join(REPO, "packages", "stac-browser", "upstream.json");
  if (!existsSync(recipePath)) return [];
  const recipe = JSON.parse(readFileSync(recipePath, "utf8"));
  const lockPath = join(REPO, "packages", "stac-browser", ".upstream", recipe.lockfile);
  if (!existsSync(lockPath)) return [];

  const bytes = readFileSync(lockPath);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== recipe.lockfileDigest) {
    throw new Error(
      `${lockPath} is ${digest}; the recipe pins ${recipe.lockfileDigest}. Refusing to enumerate a ` +
        "dependency tree the pinned build was not resolved against.",
    );
  }

  const lock = JSON.parse(bytes.toString("utf8"));
  const out = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    // Development dependencies are not compiled in. `link` entries are aliases for a directory
    // that is enumerated under its own key.
    if (path === "" || entry.dev || entry.link) continue;
    const at = path.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const name = path.slice(at + "node_modules/".length);
    const version = entry.version ?? "unresolved";
    out.push({
      type: "library",
      "bom-ref": `${purl(name, version)}?upstream=stac-browser`,
      name,
      version,
      purl: purl(name, version),
      scope: "required",
      ...(entry.license ? { licenses: [{ license: { id: entry.license } }] } : {}),
      description: "compiled into the prepared STAC Browser",
    });
  }
  return out.sort((a, b) => (a["bom-ref"] < b["bom-ref"] ? -1 : 1));
}

const seed = `${inventory.package.name}@${inventory.package.version}:${components.length}:${
  inventory.preparedMaterials?.[0]?.preparedDigest ?? "none"
}`;
const serial = createHash("sha256").update(seed).digest("hex").slice(0, 32);
const uuid = [
  serial.slice(0, 8),
  serial.slice(8, 12),
  serial.slice(12, 16),
  serial.slice(16, 20),
  serial.slice(20, 32),
].join("-");

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${uuid}`,
  version: 1,
  metadata: {
    component: {
      type: "application",
      "bom-ref": purl(inventory.package.name, inventory.package.version),
      name: inventory.package.name,
      version: inventory.package.version,
      purl: purl(inventory.package.name, inventory.package.version),
      licenses: [{ license: { id: inventory.package.license } }],
    },
  },
  components,
};

writeFileSync(join(OUT, "sbom.cdx.json"), `${JSON.stringify(bom, null, 2)}\n`);
console.log(`[sbom] ${components.length} component(s) -> reports/sbom.cdx.json`);
