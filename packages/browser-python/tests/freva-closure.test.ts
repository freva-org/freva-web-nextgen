/**
 * What is left of the Freva profile's dependency bookkeeping, now that there is no closure.
 *
 * The profile used to install a mirrored wheelhouse with `deps=False`, so every requirement of
 * every wheel had to be accounted for up front. It installs ONE derived wheel now and micropip
 * resolves the rest from PyPI, so the closure is the resolver's job and the test that parsed
 * `Requires-Dist` out of a shipped wheelhouse has nothing to read. Two rules outlive it: the
 * wheel the worker installs is the one `bin/freva-wheelhouse.json` plans, and no unit test may
 * depend on a generated `.runtime` - together with the lock file that rule exists to protect.
 */
import { createHash } from "node:crypto";
import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FREVA_CLIENT_WHEEL, installFrevaClient } from "../src/worker/pyodide-runtime.js";

const HERE = fileURLToPath(new URL("..", import.meta.url));

// THE LOCK FILE COMES FROM THE PINNED DEPENDENCY, not from a generated `.runtime`. CI and
// publishing both run `npm test` without preparing a runtime first, and a unit test that needs
// a build step to have happened is not a unit test. `pyodide` is a pinned devDependency and its
// lock file is the same artifact; the check below proves that by comparing the digest against
// the value this package records for the release archive.
const LOCK = join(HERE, "..", "..", "node_modules", "pyodide", "pyodide-lock.json");
const RELEASES = JSON.parse(
  readFileSync(join(HERE, "bin/runtime-releases.json"), "utf8"),
) as Record<string, { core?: Record<string, string> }>;

/** The plan, which is what a wheel name has to agree with. */
const PINS = JSON.parse(readFileSync(join(HERE, "bin/freva-wheelhouse.json"), "utf8")) as {
  frevaClient: { derived: { file: string } };
};

describe("the Freva profile installs what the plan pins", () => {
  it("names the derived wheel bin/freva-wheelhouse.json builds", () => {
    // The worker holds the file name as a literal, because it goes into a URL the page fetches.
    // A version bump in the plan that does not reach the worker is a 404 at startup.
    expect(FREVA_CLIENT_WHEEL).toBe(PINS.frevaClient.derived.file);
  });

  it("installs it with dependency resolution, from the wheelhouse the host serves", async () => {
    // `deps=False` here is the old design: it made every requirement this package's problem, and
    // the day a transitive one moved it was a startup failure rather than a download. The
    // resolver is allowed to work now, and the derived metadata is what keeps it away from
    // intake-esm and off an untested py-oidc-auth-client.
    let source = "";
    const pyodide = {
      runPythonAsync: async (code: string) => {
        source = code;
      },
    } as unknown as Parameters<typeof installFrevaClient>[0];

    await installFrevaClient(pyodide, "https://portal.example/freva-wheels");

    expect(source).toContain(
      `micropip.install("https://portal.example/freva-wheels/${FREVA_CLIENT_WHEEL}")`,
    );
    expect(source).not.toContain("deps=False");
    // One install, not a list: anything else means a mirrored dependency came back.
    expect(source.match(/micropip\.install\(/g)).toHaveLength(1);
  });

  it("reads the lock file from the pinned dependency, and it is the release's own", () => {
    expect(
      existsSync(LOCK),
      "node_modules/pyodide/pyodide-lock.json is missing. Run `npm ci` - this test reads the " +
        "pinned dependency rather than a generated .runtime, so a clean checkout can run it.",
    ).toBe(true);
    const pinnedVersion = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"))
      .devDependencies.pyodide as string;
    const anchor = RELEASES[pinnedVersion]?.core?.["pyodide-lock.json"];
    expect(anchor, `no core digests recorded for Pyodide ${pinnedVersion}`).toBeTruthy();
    expect(
      createHash("sha256").update(readFileSync(LOCK)).digest("hex"),
      "the installed pyodide dependency's lock file is not the one in the pinned release archive",
    ).toBe(anchor);
  });

  it("needs no generated .runtime: no unit test may depend on one", () => {
    // The failure this prevents is not a red test but a red BUILD in a place nobody expected:
    // `npm test` runs in CI and in `npm publish` without a runtime having been assembled, so a
    // unit test reaching for `.runtime` turns a clean checkout into two failures that look like
    // defects in the package.
    const offenders = globSync("**/*.test.ts", { cwd: join(HERE, "tests") })
      // This file is the one doing the scanning, so it necessarily contains the string it looks
      // for. Everything else is fair game.
      .filter((name) => !name.endsWith("freva-closure.test.ts"))
      .filter((name) =>
        // A PATH, not a mention: a string literal that starts with `.runtime`. Prose about the
        // directory is not a dependency on it.
        /["'`]\.runtime[/"'`]/.test(
          readFileSync(join(HERE, "tests", name), "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, " ")
            .replace(/(^|[^:])\/\/.*$/gm, "$1"),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
