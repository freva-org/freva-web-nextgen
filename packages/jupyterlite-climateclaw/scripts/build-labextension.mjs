// Build the prebuilt (federated) extension into `labextension/`, the directory both the npm
// package and the Python wheel ship and `jupyter lite build` installs. Node only: the core
// metadata comes from `@jupyterlab/core-meta`, pinned to the JupyterLab that JupyterLite 0.8.5
// is built on, so no Python JupyterLab is needed here.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const builder = join(
  dirname(require.resolve("@jupyter/builder/package.json")),
  "lib",
  "build-labextension.js",
);
const core = join(
  dirname(require.resolve("@jupyterlab/core-meta/package.json")),
  "core.package.json",
);

if (!existsSync(join(PKG, "lib", "index.js"))) {
  console.error("lib/ is missing: run `npm run build` first.");
  process.exit(2);
}
rmSync(join(PKG, "labextension"), { recursive: true, force: true });
execFileSync(process.execPath, [builder, "--core-package-file", core, PKG], {
  cwd: PKG,
  stdio: "inherit",
});
console.log("labextension/ built");
