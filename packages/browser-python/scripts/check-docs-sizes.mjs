/**
 * The README's size numbers, checked against the gates that measure them.
 *
 *     node scripts/check-docs-sizes.mjs
 *
 * A number transcribed by hand is only true on the day it is written, and every number in that
 * table has been wrong at some point. So the document carries MACHINE-READABLE markers, and
 * this compares them with what `check-bytes.mjs --json` and `measure-console.mjs --json` print,
 * in the same gate that enforces the budget, so prose and enforcement cannot come apart.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(PKG, "README.md");

const json = (script, args = []) => {
  const out = execFileSync(process.execPath, [join(PKG, "scripts", script), "--json", ...args], {
    cwd: PKG,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const start = out.lastIndexOf("\n{");
  return JSON.parse(start === -1 ? out : out.slice(start));
};

const bytes = json("check-bytes.mjs");
const console_ = json("measure-console.mjs");

/** KiB to one decimal place, which is how the README writes them. */
const kib = (value) => `${(value / 1024).toFixed(1)} KiB`;

// What the README is allowed to say, and what each one MEANS. The names are the distinction a
// single "size" blurs: a bundler's tree-shaken root entry, the files on disk, and the console
// entry are three different measurements of three different things.
const EXPECTED = {
  "root-entry-gz": kib(console_.rootEntryGz),
  "console-entry-gz": kib(console_.consoleEntryGz),
  "console-layer-gz": kib(console_.consoleLayerGz),
  "engine-dist-gz": kib(bytes.engineGz),
  "engine-budget-gz": kib(bytes.budgetGz),
};

const text = readFileSync(README, "utf8");
const problems = [];
for (const [marker, value] of Object.entries(EXPECTED)) {
  // EVERY occurrence, not the first. The same figure appears in the download table, in the
  // explanation under it and in the headless-versus-console table, and checking only one of them
  // lets the other two drift.
  const pattern = new RegExp(`<!--\\s*size:${marker}\\s*-->\\s*\\**\\s*([0-9.]+ KiB)`, "g");
  const found = [...text.matchAll(pattern)];
  if (found.length === 0) {
    problems.push(`README has no <!-- size:${marker} --> marker; expected it to say ${value}`);
    continue;
  }
  for (const match of found) {
    if (match[1] !== value) {
      problems.push(`README says ${marker} is ${match[1]}; the measurement says ${value}`);
    }
  }
}

if (problems.length > 0) {
  console.error(
    `\nThe README's size figures do not match the gates:\n  - ${problems.join("\n  - ")}\n`,
  );
  process.exit(1);
}
console.log(
  `documented sizes match: root ${EXPECTED["root-entry-gz"]}, console entry ` +
    `${EXPECTED["console-entry-gz"]}, engine files ${EXPECTED["engine-dist-gz"]} ` +
    `of ${EXPECTED["engine-budget-gz"]}`,
);
