// scripts/copy-assets.mjs - put the stylesheet next to the compiled JavaScript.
//
// `tsc` compiles TypeScript and, reasonably, ignores CSS. The package advertises
// `@freva-org/dataset-tree/styles.css` as `./dist/styles.css`, so the file has to be there before
// anything is packed - and it has to be the same bytes as `src/styles.css`, not a hand-maintained
// copy that drifts. One `cp`, run by `npm run build`, is the whole mechanism.

import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "styles.css");
const to = join(root, "dist", "styles.css");

mkdirSync(join(root, "dist"), { recursive: true });
copyFileSync(from, to);
// stderr, not stdout: this runs inside `prepack`, and `npm pack --json` parses stdout.
process.stderr.write(`dist/styles.css written, ${statSync(to).size} bytes\n`);
