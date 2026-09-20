/**
 * Prepare the curated add-on directory: pinned artefacts, verified, laid out as they are served.
 * The same shape as `prepare-freva-wheelhouse` - one pin file as the authority, every download
 * checked against a recorded SHA-256, an atomic swap, and a MANIFEST.json written last as a record.
 * The manifest is a RECORD, not the check: what a running interpreter enforces is compiled into the
 * bundle from this same pin file.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The authority. Read once, here, so nothing downstream can disagree with it. */
export const ADDON_PINS = JSON.parse(readFileSync(join(HERE, "freva-addons.json"), "utf8"));

export const ADDON_MANIFEST = "MANIFEST.json";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Every artefact of one add-on, as `{ id, path, sha256, bytes, url, kind }`. */
export function plannedArtifacts(id) {
  const pin = ADDON_PINS.addons[id];
  if (!pin) throw new Error(`Unknown add-on "${id}".`);
  return [
    ...pin.wheels.map((wheel) => ({
      id,
      path: `${id}/${wheel.file}`,
      sha256: wheel.sha256,
      bytes: wheel.bytes,
      url: wheel.url,
      kind: "wheel",
    })),
    ...pin.data.map((file) => ({
      id,
      path: `${id}/${file.path}`,
      sha256: file.sha256,
      bytes: file.bytes,
      url: file.url,
      kind: "data",
    })),
  ];
}

/** Every artefact of every add-on, in a fixed order. */
export function plannedAddons(ids = Object.keys(ADDON_PINS.addons).sort()) {
  return ids.flatMap((id) => plannedArtifacts(id));
}

/**
 * Check a prepared directory against the pins. Returns problems; an empty array is a pass. Against
 * the PINS, not the manifest lying in the directory - the same rule the Freva wheelhouse's verifier
 * states.
 */
export function verifyAddons(dir, ids) {
  const problems = [];
  const planned = plannedAddons(ids);
  for (const artifact of planned) {
    const file = join(dir, ...artifact.path.split("/"));
    if (!existsSync(file)) {
      problems.push(`missing: ${artifact.path}`);
      continue;
    }
    const bytes = readFileSync(file);
    const digest = sha256(bytes);
    if (digest !== artifact.sha256) {
      problems.push(
        `sha256 mismatch: ${artifact.path}\n      expected ${artifact.sha256}\n      got      ${digest}`,
      );
    }
    if (bytes.length !== artifact.bytes) {
      problems.push(
        `size mismatch: ${artifact.path} is ${bytes.length} bytes, pinned at ${artifact.bytes}`,
      );
    }
  }
  const manifestFile = join(dir, ADDON_MANIFEST);
  if (!existsSync(manifestFile)) {
    problems.push(`missing: ${ADDON_MANIFEST}`);
    return problems;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch (error) {
    problems.push(`${ADDON_MANIFEST} is not valid JSON: ${error.message}`);
    return problems;
  }
  const recorded = new Map((manifest.artifacts ?? []).map((entry) => [entry.path, entry.sha256]));
  for (const artifact of planned) {
    if (!recorded.has(artifact.path))
      problems.push(`${ADDON_MANIFEST} does not record ${artifact.path}`);
    else if (recorded.get(artifact.path) !== artifact.sha256)
      problems.push(`${ADDON_MANIFEST} records the wrong digest for ${artifact.path}`);
  }
  const plannedPaths = new Set(planned.map((artifact) => artifact.path));
  for (const path of recorded.keys()) {
    if (!plannedPaths.has(path))
      problems.push(`${ADDON_MANIFEST} records ${path}, which is not pinned`);
  }
  return problems;
}

async function fetchPinned(artifact) {
  const response = await fetch(artifact.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${artifact.url} responded ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== artifact.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${artifact.path}\n  expected  ${artifact.sha256}\n  got       ${digest}\n\n` +
        "Nothing was written. This is a mirror, a re-cut release or a truncated download.",
    );
  }
  return bytes;
}

export async function prepareAddons(args, { fail, log = console.log }) {
  const out = typeof args.out === "string" ? resolve(args.out) : "";
  if (!out) {
    fail("--out is required: the directory to serve as /python-addons/.");
    return;
  }
  const available = Object.keys(ADDON_PINS.addons).sort();
  const requested =
    typeof args.addons === "string" && args.addons.trim() !== ""
      ? [...new Set(args.addons.split(",").map((value) => value.trim()))].sort()
      : available;
  const unknown = requested.filter((id) => !available.includes(id));
  if (unknown.length > 0) {
    fail(
      `Unknown add-on${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.\nAvailable: ${available.join(", ")}.`,
    );
    return;
  }

  if (!args.force && existsSync(join(out, ADDON_MANIFEST))) {
    const problems = verifyAddons(out, requested);
    if (problems.length === 0) {
      log(`The add-on directory in ${out} is already prepared and verified.`);
      log(`  add-ons ${requested.join(", ")}`);
      return;
    }
    log(`Re-preparing ${out}: ${problems.length} problem${problems.length > 1 ? "s" : ""} found.`);
  }

  const staging = `${out}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const planned = plannedAddons(requested);
    const written = [];
    for (const artifact of planned) {
      log(`  fetching ${artifact.path}`);
      const bytes = await fetchPinned(artifact);
      const file = join(staging, ...artifact.path.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      written.push({
        path: artifact.path,
        sha256: artifact.sha256,
        bytes: bytes.length,
        kind: artifact.kind,
        source: artifact.url,
      });
    }

    writeFileSync(
      join(staging, ADDON_MANIFEST),
      `${JSON.stringify(
        {
          preparedBy: "freva-browser-python prepare-addons",
          preparedAt: new Date().toISOString(),
          schemaVersion: ADDON_PINS.schemaVersion,
          addons: requested.map((id) => ({
            id,
            title: ADDON_PINS.addons[id].title,
            profiles: ADDON_PINS.addons[id].profiles,
            ...(ADDON_PINS.addons[id].dataset ? { dataset: ADDON_PINS.addons[id].dataset } : {}),
          })),
          artifacts: written,
          note:
            "A record, not the check. The digests a running interpreter enforces are compiled into " +
            "@freva-org/browser-python from bin/freva-addons.json; this file exists so an operator " +
            "can see what was placed here and where it came from.",
        },
        null,
        2,
      )}\n`,
    );

    const problems = verifyAddons(staging, requested);
    if (problems.length > 0) {
      throw new Error(`The add-on directory did not verify:\n  - ${problems.join("\n  - ")}`);
    }

    const previous = `${out}.previous-${process.pid}`;
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(out)) renameSync(out, previous);
    try {
      renameSync(staging, out);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, out);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });

    const total = plannedAddons(requested).reduce((sum, artifact) => sum + artifact.bytes, 0);
    log(`\nPrepared ${requested.join(", ")} in ${out}`);
    log(`  ${plannedAddons(requested).length} files, ${(total / 1024).toFixed(0)} KiB`);
    for (const id of requested) {
      const dataset = ADDON_PINS.addons[id].dataset;
      if (dataset) log(`  ${id}: ${dataset.name} ${dataset.release} - ${dataset.licence}`);
    }
    log(`\nServe this directory as static files and pass it as addonBaseURL:\n\n  ${out}\n`);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    fail(error instanceof Error ? error.message : String(error));
  }
}

/** For a caller that wants the sizes without preparing anything - e.g. a build's own accounting. */
export function addonFootprint(ids) {
  return plannedAddons(ids).reduce((sum, artifact) => sum + artifact.bytes, 0);
}

export { statSync, readdirSync };
