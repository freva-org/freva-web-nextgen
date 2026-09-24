// The conformance map is checked, not trusted. A table of "where this is settled" is only worth
// reading if every path in it is real, so a renamed module or a deleted test fails here rather
// than quietly turning the document into fiction.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../../src/util/package.js";

const REPOSITORY_ROOT = join(PACKAGE_ROOT, "..", "..");
const DOC = join(PACKAGE_ROOT, "docs", "fp-001-conformance.md");

/**
 * Names in the map that are not repository paths: files a *build* produces, a retired field the
 * migration reports, and npm package specifiers.
 */
const NOT_REPOSITORY_PATHS = new Set([
  "host-policy.json",
  "deployment-config.json",
  "portal-manifest.json",
  "input-manifest.json",
  "component-evidence.json",
  "BUILDINFO.json",
  "checksums.sha256",
]);

/**
 * Paths the map cites in parts of the project this repository does not carry yet: the STAC
 * Browser workspace, the delivery scripts and the portal maintenance notes. They are named, not
 * silently tolerated, so a typo anywhere else still fails.
 */
const OUTSIDE_THIS_REPOSITORY = ["packages/stac-browser/", "packages/portal/", "delivery/"];

/** Written by `npm run acceptance`, never committed. */
const ACCEPTANCE_REPORT = join(REPOSITORY_ROOT, "reports", "fp001-acceptance.json");

function expand(reference: string): string[] {
  const star = reference.indexOf("*");
  if (star === -1) return [reference];
  const slash = reference.lastIndexOf("/", star);
  const directory = reference.slice(0, slash);
  const pattern = reference.slice(slash + 1);
  const suffix = pattern.slice(pattern.lastIndexOf("*") + 1);
  for (const root of [REPOSITORY_ROOT, PACKAGE_ROOT]) {
    const absolute = join(root, directory);
    if (!existsSync(absolute)) continue;
    const matches = readdirSync(absolute).filter((name) => name.endsWith(suffix));
    if (matches.length > 0) return matches.map((name) => `${directory}/${name}`);
  }
  return [reference];
}

function references(): string[] {
  const text = readFileSync(DOC, "utf8");
  const found = new Set<string>();
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1]!.trim();
    if (token.startsWith("@") || token.startsWith("npm ")) continue;
    if (NOT_REPOSITORY_PATHS.has(token)) continue;
    if (OUTSIDE_THIS_REPOSITORY.some((prefix) => token.startsWith(prefix))) continue;
    if (token === "reports/fp001-acceptance.json") continue;
    // A path-shaped token: it has a separator, or names a file with an extension this
    // repository uses.
    const looksLikePath = token.includes("/") && !token.includes(" ") && !token.startsWith("http");
    if (!looksLikePath) continue;
    // `src/config/paths.ts` `assertDisjointTrees` - the second is a symbol.
    for (const part of expand(token)) found.add(part);
  }
  return [...found].sort();
}

describe("the FP-001 conformance map", () => {
  const paths = references();

  it("cites at least the whole implementation surface", () => {
    expect(paths.length).toBeGreaterThan(30);
  });

  it.each(references())("cites '%s', which exists", (reference) => {
    const candidates = [join(REPOSITORY_ROOT, reference), join(PACKAGE_ROOT, reference)];
    expect(
      candidates.some((candidate) => existsSync(candidate)),
      `${reference} exists at neither ${candidates[0]} nor ${candidates[1]}`,
    ).toBe(true);
  });

  it.skipIf(!existsSync(ACCEPTANCE_REPORT))(
    "points at an acceptance report that records every gate with a status",
    () => {
      const report = ACCEPTANCE_REPORT;
      const parsed = JSON.parse(readFileSync(report, "utf8")) as {
        gates: { id: string; status: string; commands: unknown[]; missingInput?: string }[];
        summary: { pass: number; fail: number; notRun: number };
      };
      expect(parsed.gates.length).toBeGreaterThan(0);
      for (const gate of parsed.gates) {
        expect(["pass", "fail", "not-run"]).toContain(gate.status);
        // A pass must be backed by a command that ran; a not-run must name what was missing.
        // Neither may be a bare assertion.
        if (gate.status === "pass") expect(gate.commands.length).toBeGreaterThan(0);
        if (gate.status === "not-run") expect(gate.missingInput).toBeTruthy();
      }
    },
  );
});
