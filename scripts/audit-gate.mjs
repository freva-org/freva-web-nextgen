#!/usr/bin/env node
// Fails on high or critical advisories in the workspace lockfile, except those accepted in
// .github/audit-allowlist.json, each with a reason and an expiry date.
//
//   node scripts/audit-gate.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ALLOWLIST = join(ROOT, ".github", "audit-allowlist.json");
const BLOCKING = new Set(["high", "critical"]);

/** The high or critical advisories in an `npm audit --json` report, by advisory id. */
export function advisories(report) {
  const found = new Map();
  for (const [name, entry] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via !== "object" || !BLOCKING.has(via.severity)) continue;
      const id =
        /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/.exec(via.url ?? "")?.[0] ?? `npm-${via.source}`;
      if (!found.has(id))
        found.set(id, { id, severity: via.severity, title: via.title, packages: [] });
      if (!found.get(id).packages.includes(name)) found.get(id).packages.push(name);
    }
  }
  return [...found.values()];
}

/** Which advisories block, which are accepted, and what is wrong with the allow-list itself. */
export function evaluate(report, allowlist, today) {
  const problems = [];
  const accepted = new Map();
  for (const entry of allowlist) {
    if (!entry?.advisory || !entry.reason || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires ?? "")) {
      problems.push(
        `allow-list entry ${JSON.stringify(entry)} needs advisory, reason and expires (YYYY-MM-DD)`,
      );
    } else if (entry.expires < today) {
      problems.push(
        `allow-list entry ${entry.advisory} expired on ${entry.expires}: fix it or renew it`,
      );
    } else {
      accepted.set(entry.advisory, entry);
    }
  }
  const found = advisories(report);
  return {
    blocking: found.filter((advisory) => !accepted.has(advisory.id)),
    accepted: found.filter((advisory) => accepted.has(advisory.id)),
    problems,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let output;
  try {
    output = execFileSync("npm", ["audit", "--package-lock-only", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // npm audit exits non-zero whenever it finds anything; the report is still on stdout.
    output = error.stdout;
    if (!output) throw error;
  }
  const allowlist = existsSync(ALLOWLIST) ? JSON.parse(readFileSync(ALLOWLIST, "utf8")) : [];
  const today = new Date().toISOString().slice(0, 10);
  const { blocking, accepted, problems } = evaluate(JSON.parse(output), allowlist, today);
  const line = (a) => `  ${a.severity.padEnd(8)} ${a.id}  ${a.title} (${a.packages.join(", ")})`;
  if (accepted.length) console.log(`accepted by the allow-list:\n${accepted.map(line).join("\n")}`);
  if (blocking.length)
    console.log(`high or critical advisories:\n${blocking.map(line).join("\n")}`);
  for (const problem of problems) console.log(problem);
  if (blocking.length || problems.length) {
    console.log(
      `\nFix them, or accept one in .github/audit-allowlist.json with a reason and an expiry.`,
    );
    process.exit(1);
  }
  console.log("no high or critical advisories outside the allow-list");
}
