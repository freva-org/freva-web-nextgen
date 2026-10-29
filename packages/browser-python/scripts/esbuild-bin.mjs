// The esbuild CLI as Node resolves it from this package, wherever npm placed it.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const manifest = require.resolve("esbuild/package.json");

export const ESBUILD = join(dirname(manifest), require(manifest).bin.esbuild);
