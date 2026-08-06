// scripts/gen-styles.mjs - regenerate src/styles.ts from src/styles.css so the two can
// never drift. Dev-time only; the shipped package still bundles no CSS file.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/styles.css"), "utf8");
const escaped = css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
const out = `// styles.ts - the stylesheet as a string, injected into a <style> element on mount.
// GENERATED from styles.css by scripts/gen-styles.mjs - do not edit by hand; edit styles.css
// and run \`npm run gen:styles\`. The component bundles no CSS file, so the tokens + component
// styles live here as one constant.

export const STYLES = \`${escaped}\`;
`;
writeFileSync(join(root, "src/styles.ts"), out);
process.stdout.write(`styles.ts regenerated, ${css.length} bytes of CSS\n`);
