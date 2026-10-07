// A stand-in prepared notebook site with a REAL inventory (the kernel package's own `siteFiles`
// and audit rules): what `prepare-notebook` would write for a plan, minus JupyterLite. The browser
// suites build and run a real one.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISABLED_EXTENSIONS,
  INVENTORY,
  INVENTORY_SCHEMA,
  LITE_CORE_VERSION,
  pinnedRequirements,
  siteFiles,
  writeMetaPolicy,
  PREPARE_DIGEST,
} from "@freva-org/jupyterlite-freva-kernel/prepare";
import { tempRoot } from "./fixture.js";
import { KERNEL_PACKAGE, extensionPackage, type NotebookPlan } from "../../src/model/notebook.js";

/** The installed kernel extension's manifest, as `prepare-notebook` copies it into a site. */
export const kernelManifest = (): string =>
  readFileSync(join(extensionPackage(KERNEL_PACKAGE).labextension, "package.json"), "utf8");

/** A stand-in prepared site for `plan`: what `prepare-notebook` would write, minus JupyterLite. */
export function fakeSite(
  plan: NotebookPlan,
  seeds = plan.seeds,
  kernel = kernelManifest(),
  requirements = pinnedRequirements(),
  made: { preparedBy?: string; faviconUrl?: boolean; metaPolicy?: string | null } = {},
): string {
  const dir = join(tempRoot("portal-notebook-site-"), "notebook");
  const put = (path: string, text: string): void => {
    mkdirSync(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...path.split("/")), text);
  };
  put(
    "jupyter-lite.json",
    JSON.stringify({
      "jupyter-config-data": {
        federated_extensions: [{ name: "@freva-org/jupyterlite-freva-kernel" }],
        disabledExtensions: DISABLED_EXTENSIONS,
        // As `linkFavicon` names it for JupyterLite's boot script.
        ...(plan.favicon && made.faviconUrl !== false
          ? { faviconUrl: `./${plan.favicon.path}` }
          : {}),
      },
    }),
  );
  put(
    "notebooks/index.html",
    '<!doctype html><html><head><script src="./config-utils.js"></script></head></html>',
  );
  put(`extensions/${KERNEL_PACKAGE}/package.json`, kernel);
  for (const seed of seeds) put(`files/${seed.name}`, seed.text);
  if (plan.favicon) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, plan.favicon.path), plan.favicon.bytes);
  }
  // As `prepare-notebook` writes a same-origin site's meta policy: last, first in every head.
  const meta = made.metaPolicy === undefined ? plan.metaPolicy : (made.metaPolicy ?? undefined);
  if (meta) writeMetaPolicy(dir, meta);
  put(
    INVENTORY,
    JSON.stringify({
      schemaVersion: INVENTORY_SCHEMA,
      jupyterliteCore: LITE_CORE_VERSION,
      requirements,
      seeds: seeds.map((s) => s.name),
      settingsSha256: plan.settingsSha256,
      ...(plan.appName ? { appName: plan.appName } : {}),
      ...(plan.favicon
        ? { favicon: { path: plan.favicon.path, sha256: plan.favicon.sha256 } }
        : {}),
      ...(meta ? { metaPolicy: meta } : {}),
      preparedBy: made.preparedBy ?? PREPARE_DIGEST,
      files: siteFiles(dir),
    }),
  );
  return dir;
}
