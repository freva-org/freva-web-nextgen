// scripts/gen-styles.mjs - regenerate the stylesheet-as-a-string modules from their .css sources
// so the two can never drift. Dev-time only; the shipped package still bundles no CSS file.
//
// Two sheets, two independent constants: the picker entry must not pull in the full data browser's
// stylesheet, so they cannot share one module.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Array<{css: string, ts: string, constName: string, note: string}>} */
const SHEETS = [
  {
    css: "src/styles.css",
    ts: "src/styles.ts",
    constName: "STYLES",
    note: "The component bundles no CSS file, so the tokens + component styles live here as one constant.",
  },
  {
    css: "src/picker.css",
    ts: "src/picker/styles.ts",
    constName: "PICKER_STYLES",
    note: "Scoped entirely under `.freva-picker`; the picker entry never loads the full databrowser sheet.",
  },
];

for (const sheet of SHEETS) {
  const css = readFileSync(join(root, sheet.css), "utf8");
  const escaped = css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  const rel = sheet.css.replace(/^src\//, "");
  const out = `// ${sheet.ts.split("/").pop()} - the stylesheet as a string, injected into a <style> element on mount.
// GENERATED from ${rel} by scripts/gen-styles.mjs - do not edit by hand; edit ${rel}
// and run \`npm run gen:styles\`. ${sheet.note}

export const ${sheet.constName} = \`${escaped}\`;
`;
  writeFileSync(join(root, sheet.ts), out);
  process.stdout.write(`${sheet.ts} regenerated, ${css.length} bytes of CSS\n`);
}
