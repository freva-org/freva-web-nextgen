// Which modules are the builder's own. An installed builder lives under `node_modules` itself,
// and its templates and islands must still be recorded as `builder:` modules - otherwise the
// evidence of an npm or pip install differs from a checkout's, component by component.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builderRelative } from "../../src/artifact/evidence.js";

describe("builderRelative", () => {
  const checkout = join("/", "repo", "packages", "portal-builder");
  const installed = join("/", "site", "node_modules", "@freva-org", "portal-builder");

  it("attributes a checkout's own files to the builder", () => {
    expect(builderRelative(join(checkout, "client", "shell.ts"), checkout)).toBe("client/shell.ts");
  });

  it("attributes an installed builder's own files to the builder", () => {
    expect(
      builderRelative(join(installed, "astro", "src", "layouts", "Shell.astro"), installed),
    ).toBe("astro/src/layouts/Shell.astro");
  });

  it("leaves the builder's own dependencies to their packages", () => {
    const nested = join(installed, "node_modules", "mermaid", "dist", "mermaid.min.js");
    expect(builderRelative(nested, installed)).toBeUndefined();
    expect(builderRelative(join(checkout, "node_modules", "x", "i.js"), checkout)).toBeUndefined();
  });

  it("does not claim a sibling directory that shares the prefix", () => {
    expect(
      builderRelative(join(`${installed}-fork`, "client", "shell.ts"), installed),
    ).toBeUndefined();
    expect(
      builderRelative(join("/", "elsewhere", "client", "shell.ts"), installed),
    ).toBeUndefined();
  });
});
