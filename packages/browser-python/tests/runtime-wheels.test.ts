/**
 * One list of wheels, derived from the code that needs them.
 *
 * A hand-written download list in `scripts/prepare-runtime.mjs`, separate from `PROFILE_PACKAGES`
 * and separate again from what the browser suites declare, drifts: `micropip` in a profile but
 * not in the script means the profile cannot start, and netcdf4, pyarrow and pillow needed by
 * `workspace.mjs` but in neither means that suite exits 3, `run.mjs` reports NOT RUN rather than
 * failed, and CI announces a green run for a suite it never executed.
 *
 * So the manifest is DERIVED, and these tests check the derivation still reaches everything:
 * every profile's packages, and every package any suite asks `runtimeHasPackages` for. The last
 * is a scan of the suite sources, because an inline declaration is how the second failure got in.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  SUITE_OPTIONAL_PACKAGES,
  SUITE_REQUIREMENTS,
} from "../browser-tests/suite-requirements.mjs";
import { profilePackages, runtimePackages } from "../scripts/runtime-manifest.mjs";
import { PROFILE_PACKAGES } from "../src/worker/pyodide-runtime.js";

const BROWSER_TESTS = fileURLToPath(new URL("../browser-tests", import.meta.url));

describe("the derived runtime manifest", () => {
  const wanted = new Set(runtimePackages());

  it("finds the profiles by parsing the worker's own source", () => {
    // The parse is narrow, so it is worth proving it reads the real thing rather than nothing:
    // an empty result would make every assertion below vacuously true.
    const parsed = new Set(profilePackages());
    expect(parsed.size).toBeGreaterThan(5);
    for (const [profile, packages] of Object.entries(PROFILE_PACKAGES)) {
      for (const name of packages) {
        expect(parsed.has(name), `${name} (from the "${profile}" profile) was not parsed`).toBe(
          true,
        );
      }
    }
  });

  it("does not mistake a profile NAME for a package", () => {
    // The object's keys are "minimal", "xarray-zarr", "freva-client". Two of those look exactly
    // like package names and neither exists in the Pyodide lock, so a parse that picked them up
    // would print "no package named xarray-zarr" on every assembly and nobody would read it.
    for (const profile of Object.keys(PROFILE_PACKAGES)) {
      expect(wanted.has(profile), `"${profile}" is a profile name, not a wheel`).toBe(false);
    }
  });

  it("does not mistake a package NAMED IN A COMMENT for one that is loaded", () => {
    // `pyodide-runtime.ts` explains why matplotlib is deliberately NOT in a profile, so a parse
    // that read comments would conclude the opposite of what the file says. It is in the manifest
    // here, but through `suite-requirements.mjs` - because suites plot - and the distinction
    // matters the day somebody removes those suites.
    expect(profilePackages()).not.toContain("matplotlib");
  });

  for (const [profile, packages] of Object.entries(PROFILE_PACKAGES)) {
    if (packages.length === 0) continue;
    it(`covers every wheel the "${profile}" profile loads`, () => {
      const absent = packages.filter((name) => !wanted.has(name));
      expect(
        absent,
        `The runtime manifest does not include ${absent.join(", ")}, which the "${profile}" ` +
          `profile loads at startup.`,
      ).toEqual([]);
    });
  }

  for (const [suite, packages] of Object.entries(SUITE_REQUIREMENTS)) {
    if (packages.length === 0) continue;
    it(`covers every wheel ${suite} declares`, () => {
      expect(packages.filter((name) => !wanted.has(name))).toEqual([]);
    });
  }
});

describe("suites declare their wheels in one place", () => {
  /**
   * Every package name any suite passes to `runtimeHasPackages`, found by reading the sources. A
   * scan rather than a convention, because the convention is what failed: `workspace.mjs`
   * declared `const REQUIRED = [...]` inline, which is a reasonable thing to write and is
   * invisible to anything that assembles a runtime.
   */
  function inlineRequirements(): Array<{ suite: string; names: string[] }> {
    const found: Array<{ suite: string; names: string[] }> = [];
    for (const file of readdirSync(BROWSER_TESTS)) {
      if (!file.endsWith(".mjs") || file === "harness.mjs" || file === "suite-requirements.mjs") {
        continue;
      }
      const source = readFileSync(`${BROWSER_TESTS}/${file}`, "utf8");
      for (const call of source.matchAll(/runtimeHasPackages\(\s*(\[[^\]]*\])/g)) {
        const names = [...(call[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
        if (names.length > 0) found.push({ suite: file, names });
      }
      // The named-constant form, which is what most suites use.
      for (const declaration of source.matchAll(/const (?:REQUIRED|NEEDED)\s*=\s*(\[[^\]]*\])/g)) {
        const names = [...(declaration[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
        if (names.length > 0) found.push({ suite: file, names });
      }
    }
    return found;
  }

  it("declares every inline requirement in suite-requirements.mjs too", () => {
    const wanted = new Set(runtimePackages());
    const problems: string[] = [];
    for (const { suite, names } of inlineRequirements()) {
      // Required OR optional: both are downloaded by the assembler, which is what this test is
      // about. The difference between them is what a suite does when the wheel is missing, and
      // that is the gate audit's business rather than this one's.
      const declared = new Set([
        ...(SUITE_REQUIREMENTS[suite] ?? []),
        ...(SUITE_OPTIONAL_PACKAGES[suite] ?? []),
      ]);
      for (const name of names) {
        if (!declared.has(name)) problems.push(`${suite} needs ${name}, undeclared`);
        if (!wanted.has(name)) problems.push(`${suite} needs ${name}, not in the manifest`);
      }
    }
    expect(
      problems,
      "A suite asks for a wheel that the runtime assembler will not download. It will exit 3 and " +
        "be reported as NOT RUN, which reads as a pass. Add it to browser-tests/suite-requirements.mjs.",
    ).toEqual([]);
  });

  it("does not declare requirements for suites that no longer exist", () => {
    const files = new Set(readdirSync(BROWSER_TESTS));
    const stale = Object.keys(SUITE_REQUIREMENTS).filter((suite) => !files.has(suite));
    expect(stale, "suite-requirements.mjs names suites that are gone").toEqual([]);
  });
});
