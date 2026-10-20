// Copy what tsc does not: the scene kernel (plain JavaScript with a hand-written declaration
// file), its sky artwork, and the stylesheet.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const copy = (from, to) => {
  mkdirSync(dirname(join(ROOT, to)), { recursive: true });
  cpSync(join(ROOT, from), join(ROOT, to), { recursive: true });
};
copy("src/cosmos/scene.js", "dist/cosmos/scene.js");
copy("src/cosmos/scene.d.ts", "dist/cosmos/scene.d.ts");
copy("src/cosmos/scene", "dist/cosmos/scene");
copy("src/styles.css", "dist/styles.css");
