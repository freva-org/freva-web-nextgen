// `prepare-playground`: the one network-enabled stage of the Python playground.
//
// The builder owns it because only the builder reads `portal.yaml`, and what has to be decided
// before anything is downloaded is a question about that file: which profile, which add-ons,
// and therefore which artefacts. Answering it in a shell variable instead -
// `PORTAL_ADDONS="${PORTAL_ADDONS:-dask,cartopy-natural-earth-110m}"` - is a second copy of a
// decision the YAML already records, free to disagree with it and with nothing to notice when
// it does. The artefacts come from `@freva-org/browser-python`, which pins them; neither
// package could answer alone.
//
// It prepares exactly what the configuration needs and nothing else; publishes atomically, so
// a directory is complete or absent, never half-fetched; caches OUTSIDE the artifact, so
// `rm -rf build/` does not throw the download away; validates cached BYTES against the pins
// rather than the presence of a manifest; attempts every independent group and reports all the
// failures together, so a deployment missing two things learns about both in one run; and says
// out loud whether the runtime stays on the pinned CDN or was mirrored, because those are very
// different amounts of disk.
//
// `validate` and `build` remain offline. This is the only command in the CLI that opens a
// socket, and keeping that true is why preparation is a command rather than a step in `build`.

import { mkdirSync, mkdtempSync, renameSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { prepareAddons, prepareFrevaWheelhouse } from "@freva-org/browser-python/prepare";
import { resolveModel } from "../model/resolve.js";
import {
  ADDONS_DIR,
  MATERIALS_MANIFEST,
  WHEELHOUSE_DIR,
  planPythonMaterials,
  pythonMaterialsCacheKey,
  verifyPythonMaterials,
  type MaterialsRecord,
  type PythonMaterialsPlan,
} from "../model/python-materials.js";
import { packageInfo } from "../util/package.js";
import type { CliIo } from "./index.js";

export interface PreparePlaygroundOptions {
  sourceRoot: string;
  configPath: string;
  outDir: string;
  /** Prepare again even when the cache is current and verifies. */
  force?: boolean;
  /** Report what would be prepared, and touch neither the network nor the disk. */
  dryRun?: boolean;
}

/** One independent group of artefacts, attempted on its own so one failure cannot hide another. */
interface AssetGroup {
  label: string;
  dir: string;
  run: () => Promise<void>;
}

export async function preparePlayground(
  options: PreparePlaygroundOptions,
  io: CliIo,
): Promise<number> {
  // Resolved OFFLINE and non-emitting: this needs the playground stanza and nothing else, so
  // it must not fail because a release build would want a recorded epoch, and must not go
  // looking for STAC materials it is not being asked to prepare.
  const resolved = await resolveModel({
    sourceRoot: options.sourceRoot,
    configPath: options.configPath,
    release: false,
  });
  const playground = resolved.portalPlayground;
  if (!playground) {
    // Not an error. A portal with no playground has nothing to prepare, and a pipeline that
    // runs this command unconditionally should not have to know that in advance.
    io.out("This portal has no Python playground enabled; there is nothing to prepare.\n");
    return 0;
  }

  const plan = planPythonMaterials(playground);
  const key = pythonMaterialsCacheKey(plan);
  const out = resolve(options.outDir);

  io.out(`profile        ${plan.profile}\n`);
  io.out(`add-ons        ${plan.addons.length > 0 ? plan.addons.join(", ") : "none"}\n`);
  if (plan.optionalAddons.length > 0) {
    io.out(`  optional     ${plan.optionalAddons.join(", ")}\n`);
  }
  io.out(
    `wheelhouse     ${plan.needsWheelhouse ? "yes (the freva-client profile)" : "not needed"}\n`,
  );
  // Said plainly, because it is the difference between preparing a few megabytes of custom
  // directories and mirroring a whole Python distribution, and a reader who sees "prepared the
  // playground" is entitled to know which of those happened.
  io.out(
    plan.runtime === "mirror"
      ? `runtime        mirrored locally (runtimeIndexUrl is set; prepare it with \`freva-browser-python prepare-runtime\`)\n`
      : `runtime        stays on the pinned Pyodide CDN (no runtimeIndexUrl configured)\n`,
  );
  io.out(`artefacts      ${plan.files.length}\n`);
  io.out(`cache key      ${key}\n`);
  io.out(`out            ${out}\n`);

  if (options.dryRun) {
    for (const file of plan.files) io.out(`  ${file.path}\n`);
    return 0;
  }

  if (plan.files.length === 0) {
    writeRecord(out, plan, key);
    io.out("Nothing to fetch: this configuration needs no wheels and no add-on artefacts.\n");
    return 0;
  }

  // The cache check runs over bytes. A presence test like `if [ -f MANIFEST.json ]` answers
  // the wrong question: a manifest is written by whoever wrote the files, so it confirms a
  // stale directory exactly as readily as a current one.
  if (!options.force) {
    const problems = verifyPythonMaterials(out, plan);
    if (problems.length === 0) {
      io.out(`\nAlready prepared and verified at ${out}.\n`);
      return 0;
    }
    if (existsSync(out)) {
      io.err(`the cache at ${out} is not usable and will be prepared again:\n`);
      for (const problem of problems.slice(0, 6)) io.err(`  - ${problem}\n`);
      if (problems.length > 6) io.err(`  … and ${problems.length - 6} more\n`);
    }
  }

  // Atomic publication: everything is fetched into a staging directory beside the destination,
  // and the destination is replaced only once every group has succeeded. A half-fetched
  // directory is indistinguishable from a complete one to a web server, and the interpreter
  // fails at start with a digest mismatch on a file nobody knew was truncated.
  mkdirSync(dirname(out), { recursive: true });
  const staging = mkdtempSync(join(dirname(out), ".python-materials-"));
  const failures: string[] = [];
  try {
    const groups: AssetGroup[] = [];
    if (plan.needsWheelhouse) {
      groups.push({
        label: "Freva wheelhouse",
        dir: join(staging, WHEELHOUSE_DIR),
        run: () =>
          prepareFrevaWheelhouse(
            { out: join(staging, WHEELHOUSE_DIR) },
            {
              fail: (message) => {
                throw new Error(message);
              },
              log: (message) => io.out(`  ${message}\n`),
            },
          ),
      });
    }
    if (plan.addons.length > 0) {
      groups.push({
        label: `add-ons (${plan.addons.join(", ")})`,
        dir: join(staging, ADDONS_DIR),
        run: () =>
          prepareAddons(
            { out: join(staging, ADDONS_DIR), addons: plan.addons.join(",") },
            {
              fail: (message) => {
                throw new Error(message);
              },
              log: (message) => io.out(`  ${message}\n`),
            },
          ),
      });
    }

    // Every group is attempted. The wheelhouse and the add-on directory come from different
    // hosts and fail for different reasons; stopping at the first would mean an operator fixes
    // one, waits for a rebuild, and meets the second.
    for (const group of groups) {
      io.out(`\npreparing ${group.label}…\n`);
      try {
        await group.run();
      } catch (error) {
        failures.push(`${group.label}: ${(error as Error).message}`);
      }
    }

    if (failures.length > 0) {
      io.err(`\n${failures.length} of ${groups.length} asset groups could not be prepared:\n`);
      for (const failure of failures) io.err(`  - ${failure}\n`);
      io.err("\nNothing was published: the destination is unchanged.\n");
      return 1;
    }

    // Verified in staging, before publication. The preparers verify what they downloaded; this
    // verifies that what is on disk is what THIS portal's plan says it should be, which is the
    // question a later build will ask.
    const staged = verifyPythonMaterials(staging, { ...plan, files: plan.files });
    const missingRecord = staged.filter((p) => !p.startsWith(MATERIALS_MANIFEST));
    if (missingRecord.length > 0) {
      io.err(`\nthe prepared directory does not match the plan:\n`);
      for (const problem of missingRecord) io.err(`  - ${problem}\n`);
      return 1;
    }
    writeRecord(staging, plan, key);

    rmSync(out, { recursive: true, force: true });
    renameSync(staging, out);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  io.out(`\nprepared ${plan.files.length} artefacts in ${out}\n`);
  io.out(`Pass it to the build:\n`);
  io.out(
    `  freva-portal-builder build --config <portal.yaml> --python-materials ${options.outDir}\n`,
  );
  return 0;
}

function writeRecord(dir: string, plan: PythonMaterialsPlan, cacheKey: string): void {
  mkdirSync(dir, { recursive: true });
  const record: MaterialsRecord = {
    schemaVersion: 1,
    preparedBy: `${packageInfo().name} ${packageInfo().version} prepare-playground`,
    // A wall-clock stamp, deliberately NOT part of the cache key: it is here so an operator
    // can see how old a directory is, and folding it in would make every preparation stale.
    preparedAt: new Date().toISOString(),
    cacheKey,
    profile: plan.profile,
    addons: plan.addons,
    optionalAddons: plan.optionalAddons,
    runtime: plan.runtime,
    files: plan.files,
  };
  writeFileSync(join(dir, MATERIALS_MANIFEST), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}
