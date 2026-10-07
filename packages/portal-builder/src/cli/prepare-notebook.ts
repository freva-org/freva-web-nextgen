// `prepare-notebook`: build the notebook site for a portal with `pythonPlayground.notebook`.
//
// Like `prepare-playground`, a separate, network-enabled stage: it installs the pinned,
// hash-checked JupyterLite toolchain into a cache outside the artifact and runs one isolated
// build. What it builds is decided by `portal.yaml` alone - one kernel per allowed setup, one
// seed notebook per registered example - and recorded in the site's inventory, which `build
// --notebook` checks against the configuration before it copies a single file.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { authCallbackEntries, describeAuthCallbacks } from "../model/auth-callbacks.js";
import { resolveModel } from "../model/resolve.js";
import {
  checkNotebookSite,
  labSiteOptions,
  loadKernelTools,
  planNotebook,
  withMetaPolicy,
} from "../model/notebook.js";
import type { CliIo } from "./index.js";

export interface PrepareNotebookOptions {
  sourceRoot: string;
  configPath: string;
  outDir: string;
  /** Python 3.10+ to run the JupyterLite build with. */
  python?: string;
  force?: boolean;
  dryRun?: boolean;
  /** The prepared STAC materials, for a portal whose configuration needs them to resolve. */
  stacMaterialsDir?: string;
  /** The prepared playground materials, likewise. */
  pythonMaterialsDir?: string;
}

export async function prepareNotebook(options: PrepareNotebookOptions, io: CliIo): Promise<number> {
  const resolved = await resolveModel({
    sourceRoot: options.sourceRoot,
    configPath: options.configPath,
    release: false,
    skipNotebook: true,
    ...(options.stacMaterialsDir ? { stacMaterialsDir: options.stacMaterialsDir } : {}),
    ...(options.pythonMaterialsDir ? { pythonMaterialsDir: options.pythonMaterialsDir } : {}),
  });
  const settings = resolved.portalPlayground;
  if (!settings?.notebook) {
    io.out("This portal has no notebook enabled; there is nothing to prepare.\n");
    return 0;
  }
  const playground = resolved.notebookPlayground;
  if (!resolved.model) {
    const errors = resolved.diagnostics.errors.slice(0, 5);
    io.err(
      "The configuration does not resolve:\n" +
        errors.map((d) => `  ${d.code} ${d.pointer ?? ""}: ${d.message}\n`).join("") +
        "A portal with STAC Browser or prepared playground materials needs them here too: " +
        "pass --stac-materials and --python-materials as to `build`.\n",
    );
    return 1;
  }
  if (!playground) {
    io.err(
      "The notebook is enabled, but no page uses the playground, so there is no playground to " +
        "plan it from. Mark a runnable snippet or enable a dataset tree's Python first.\n",
    );
    return 1;
  }
  const plan = await withMetaPolicy(
    planNotebook(
      settings,
      playground,
      resolved.notebookSeeds ?? [],
      resolved.notebookLab,
      resolved.notebookIdentity,
    ),
    settings,
    playground,
    resolved.notebookLab,
  );
  const out = resolve(options.outDir);
  const setups = (plan.settings.setups as { id: string; label: string }[]) ?? [];
  io.out(`kernels        ${setups.length}\n`);
  for (const setup of setups) io.out(`  ${setup.id.padEnd(28)} ${setup.label}\n`);
  io.out(`seed notebooks ${plan.seeds.length}\n`);
  io.out(`settings       sha256:${plan.settingsSha256}\n`);
  if (plan.lab) {
    io.out(`interface      JupyterLab (trimmed) + Notebook\n`);
    io.out(
      `extensions     ${plan.lab.packages.join(", ")}${plan.lab.jupyterliteAi ? ", jupyterlite-ai (pinned)" : ""}\n`,
    );
    io.out(`disabled       ${plan.lab.disabledExtensions.length} plugins\n`);
    if (settings.notebookSameOrigin)
      io.out(`deployment     same-origin (in the portal's artifact)\n`);
    const lab = resolved.notebookLab;
    const notebook = lab?.assistant
      ? { origin: lab.playgroundOrigin, callbackPath: lab.authCallbackPath, basePath: lab.basePath }
      : undefined;
    for (const line of describeAuthCallbacks(authCallbackEntries(undefined, notebook))) {
      io.out(`${line}\n`);
    }
  }
  io.out(`out            ${out}\n`);
  if (options.dryRun) {
    for (const seed of plan.seeds) io.out(`  ${seed.name}\n`);
    return 0;
  }

  if (!options.force && existsSync(out)) {
    const { problems } = await checkNotebookSite(out, plan);
    if (problems.length === 0) {
      io.out(`\nAlready prepared and verified at ${out}.\n`);
      return 0;
    }
    io.out(`\nThe site at ${out} is out of date (${problems[0]}); preparing it again.\n`);
  }

  const { prepare } = await loadKernelTools();
  const inventory = await prepare.prepareNotebookSite({
    out,
    settings: plan.settings,
    seeds: plan.seeds,
    ...(plan.lab ? { lab: labSiteOptions(plan.lab) } : {}),
    ...(plan.appName ? { appName: plan.appName } : {}),
    ...(plan.favicon
      ? { favicon: { path: plan.favicon.path, bytes: plan.favicon.bytes, type: plan.favicon.type } }
      : {}),
    ...(plan.metaPolicy ? { metaPolicy: plan.metaPolicy } : {}),
    ...(options.python ? { pythonExecutable: options.python } : {}),
    log: (message) => io.out(`${message}\n`),
  });
  const { problems } = await checkNotebookSite(out, plan);
  if (problems.length > 0) {
    io.err(`The prepared notebook does not verify:\n  ${problems.join("\n  ")}\n`);
    return 1;
  }
  io.out(
    `\nPrepared ${inventory.files.length} files (JupyterLite ${inventory.jupyterliteCore}, ` +
      `${inventory.kernel.name} ${inventory.kernel.version}).\n` +
      `Build with: freva-portal-builder build ... --notebook ${options.outDir}\n`,
  );
  return 0;
}
