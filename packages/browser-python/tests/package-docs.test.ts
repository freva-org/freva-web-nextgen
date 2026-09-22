/**
 * What this package's own README PROMISES about installing packages.
 *
 * A documentation test looks like bureaucracy until the documentation is the security control.
 * `@freva-org/browser-python` is a general library, its `micropip.install("name")` example is
 * legitimate, and a host embedding it may nonetheless have a Content-Security-Policy under which
 * that line cannot work - `@freva-org/portal-builder` emits such a policy. The failure a visitor
 * sees, `ValueError: Can't fetch metadata for …`, arrives during METADATA LOOKUP, before wheel
 * compatibility is evaluated, so it tells them nothing true about the package they asked for.
 * The answer is not to weaken a generic API but to stop stating the example unconditionally.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

/** The section, so a match elsewhere in a 1500-line file cannot satisfy these on its behalf. */
const section = (): string => {
  const start = README.indexOf("## Installing packages");
  expect(start, "the packages section is gone; these assertions would be vacuous").toBeGreaterThan(
    0,
  );
  const next = README.indexOf("\n## ", start + 1);
  return README.slice(start, next === -1 ? undefined : next);
};

describe("the README's account of installing packages", () => {
  const text = section();

  it("makes the install example conditional on the page, not just on the wheel", () => {
    // FIVE CONDITIONS. The second and third are the ones that get omitted: discussing wheel
    // compatibility as though it were the only question leaves a reader whose page has no
    // `connect-src` entry for an index with no way to interpret what they see.
    expect(text).toMatch(/pure-Python wheel|WebAssembly target/);
    expect(text).toContain("connect-src");
    expect(text).toContain("https://pypi.org");
    expect(text).toContain("https://files.pythonhosted.org");
    expect(text).toMatch(/CORS/);
    expect(text).toMatch(/reachable/i);
  });

  it("names the error, and says where in the sequence it is raised", () => {
    expect(text).toContain("Can't fetch metadata for");
    // The point of naming it: it happens BEFORE compatibility is considered, so it is not evidence
    // about the package.
    expect(text).toMatch(/before[^.]*compatibility/i);
  });

  it("names portal-builder, and which of its profiles names the index", () => {
    // The answer is per-PROFILE, not per-host, and a README that gave one answer for the whole
    // builder would be wrong in whichever direction it chose: `freva-client` resolves its
    // dependencies from the index and the others reach no index at all.
    expect(text).toContain("@freva-org/portal-builder");
    expect(text).toMatch(/freva-client/);
    expect(text).toMatch(/also names the index/i);
  });

  it("separates installing from working, with an example that is not Cartopy", () => {
    // Cartopy was the standing example and is now SOLVED by an add-on, so leaning on it alone
    // would illustrate the general point only with a case this package handles. `s3fs` is
    // sharper: its dependency closure installs and the result still cannot open an S3 store,
    // because what is registered here is a read-only Fetch adapter with no credentials, no
    // signing and no writes.
    expect(text).toMatch(/Installing is not the same as working/i);
    expect(text).toContain("s3fs");
    expect(text).toMatch(/read-only|READ-ONLY/);
    expect(text).toMatch(/no credentials|no signing|no writes/);
  });

  it("says that installing does not import, and how to inspect a session", () => {
    expect(text).toMatch(/Installing does not import/i);
    expect(text).toContain("micropip.list()");
  });

  it("no longer claims a session has no disk", () => {
    // "No subprocess and no disk" is half false: this package reports a disk-backed `/workspace`
    // whenever OPFS is available, which is the ordinary case. See `WorkspaceStatus`.
    expect(README).not.toContain("no subprocess and no disk");
  });
});
