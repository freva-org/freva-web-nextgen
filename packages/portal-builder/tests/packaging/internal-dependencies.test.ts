// The builder's workspace dependencies are pinned EXACTLY, and the pins must be the versions in
// this checkout. Every `@freva-org/*` dependency is an exact version rather than a range,
// because the builder compiles a consumer's portal against these packages and a range lets a
// consumer's install pick a copy nobody built against. The cost of an exact pin is that it goes
// stale silently: a package is released, the pin is not updated, and a consumer installing the
// builder gets a REGISTRY copy while every test in this repository ran against the workspace
// one. Nothing fails; the two just stop being the same software. Across a cross-package API
// change - `@freva-org/browser-python`'s protocol version, say - that is a portal whose parent
// speaks version 3 to a child that does not.
//
// The packed-consumer half of the same claim is in `pack-and-install.mjs`, which installs the
// packed tarballs and asserts the consumer really got them.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../../src/util/package.js";

const REPO = join(PACKAGE_ROOT, "..", "..");

function version(pkg: string): string {
  return (
    JSON.parse(readFileSync(join(REPO, "packages", pkg, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
}

/** Workspace directory name for each `@freva-org/*` dependency the builder declares. */
const WORKSPACE = new Map([
  ["@freva-org/browser-python", "browser-python"],
  ["@freva-org/data-inspector", "data-inspector"],
  ["@freva-org/databrowser", "databrowser"],
  ["@freva-org/dataset-tree", "dataset-tree"],
  ["@freva-org/freva-badge", "freva-badge"],
  ["@freva-org/freva-client-terminal", "freva-client-terminal"],
  ["@freva-org/ts-oidc-auth-client", "ts-oidc-auth-client"],
]);

describe("the builder's internal dependencies", () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const declared = Object.entries(manifest.dependencies).filter(([name]) =>
    name.startsWith("@freva-org/"),
  );

  it("are all workspace packages this repository builds", () => {
    for (const [name] of declared) {
      expect(WORKSPACE.has(name), `${name} is not in the workspace map above`).toBe(true);
    }
  });

  it("are pinned exactly, with no range that could resolve elsewhere", () => {
    for (const [name, range] of declared) {
      expect(range, `${name} is pinned as ${range}`).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    }
  });

  it("name the versions in this checkout", () => {
    for (const [name, range] of declared) {
      const dir = WORKSPACE.get(name)!;
      expect(range, `${name}: pinned ${range}, workspace has ${version(dir)}`).toBe(version(dir));
    }
  });
});
