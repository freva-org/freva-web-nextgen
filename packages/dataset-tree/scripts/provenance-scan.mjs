// scripts/provenance-scan.mjs - a mechanical check that no deployment-specific material leaked in.
//
// This package was written against a behavioural brief while an existing AGPL-3.0 implementation
// served as the reference for look and behaviour (see CLEANROOM.md). Two things must therefore stay
// true, and neither is the sort of thing a human reliably re-checks by eye:
//
//   1. No identifier, class name or literal from that implementation appears in this one.
//   2. No operator's data - buckets, endpoints, branding - is baked into the shipped package.
//
// A grep is not proof of independence. It is a tripwire for the specific mistakes that are easy to
// make in a hurry, and it runs in CI where eyes do not.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories that end up in the tarball, plus the playground and the tests around them. */
const SCANNED = ["src", "schema", "dist", "playground", "browser-tests", "scripts"];

/**
 * Terms that must not appear.
 *
 * Three groups: the reference implementation's own naming, the operator names and branding the
 * brief excludes from the package, and the CSS/DOM prefix of the original component - the single
 * clearest signal that markup or styling was carried across rather than rewritten.
 */
const FORBIDDEN = [
  // The reference implementation and its host project.
  "waterpark",
  "grid-doctor",
  "griddoctor",
  "gridDoctor",
  // Its class and file prefix.
  "wp__",
  "wp-",
  "waterpark-tree",
  "waterpark-inspector",
  // Operator branding and deployment vocabulary the package must stay ignorant of.
  "esgf",
  "dkrz",
  "healpix",
  "nextgems",
  // Its Material-theme token vocabulary, which this package must not inherit.
  "--md-",
  "data-md-color-scheme",
];

/**
 * Exceptions, with reasons. Kept explicit so that adding one is a decision.
 *
 * `tests/external-consumer.test.ts` is deliberately outside this scan: it models a real deployment's
 * public data format on purpose, is labelled as such, and is not published.
 */
const ALLOWED = [
  // This file names what it forbids.
  { file: "scripts/provenance-scan.mjs", terms: FORBIDDEN },
];

function files(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|js|mjs|css|json|html|md)$/.test(entry.name)) continue;
      if (statSync(full).size > 2_000_000) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

let hits = 0;
let scanned = 0;

for (const directory of SCANNED) {
  for (const file of files(join(PKG, directory))) {
    const relative = file
      .slice(PKG.length + 1)
      .split("\\")
      .join("/");
    const exception = ALLOWED.find((a) => a.file === relative);
    const source = readFileSync(file, "utf8");
    const lowered = source.toLowerCase();
    scanned += 1;
    for (const term of FORBIDDEN) {
      if (exception?.terms.includes(term)) continue;
      const index = lowered.indexOf(term.toLowerCase());
      if (index === -1) continue;
      const line = source.slice(0, index).split("\n").length;
      process.stdout.write(`  FAIL ${relative}:${line} contains ${JSON.stringify(term)}\n`);
      hits += 1;
    }
  }
}

process.stdout.write(
  hits === 0
    ? `\n  ok   ${scanned} files scanned, none of the ${FORBIDDEN.length} forbidden terms present\n`
    : `\nprovenance scan FAILED: ${hits} hit(s)\n`,
);
process.exit(hits === 0 ? 0 : 1);
