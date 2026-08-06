/**
 * Release gate: no NUL or disallowed control bytes anywhere we ship or review.
 *
 * A literal control character inside a regex character class made src/url.ts a
 * "binary" file to git and to review tooling - the diff was unreadable and the
 * security-critical code was effectively unreviewable.
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src", "dist", "tests", "browser-tests", "docs", "scripts"];
const FILES = [
  "README.md",
  "LICENSE",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.test.json",
  "vitest.config.ts",
];
const EXT = new Set([".ts", ".js", ".mjs", ".cjs", ".d.ts", ".json", ".md", ".yml", ".yaml", ""]);
// Tab (9), LF (10) and CR (13) are the only control bytes text may contain.
const ALLOWED = new Set([9, 10, 13]);

const offenders = [];
function scan(file) {
  const buf = fs.readFileSync(file);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if ((b < 32 && !ALLOWED.has(b)) || b === 127) {
      offenders.push(`${file}: byte 0x${b.toString(16).padStart(2, "0")} at offset ${i}`);
      break;
    }
  }
}
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (EXT.has(path.extname(entry.name))) scan(full);
  }
}
for (const r of ROOTS) walk(r);
for (const f of FILES) if (fs.existsSync(f)) scan(f);

if (offenders.length) {
  console.error("control-byte gate FAILED:");
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}
console.log(`control-byte gate: PASS (no NUL/disallowed control bytes)`);
