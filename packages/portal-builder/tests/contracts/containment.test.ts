// The filesystem trust anchor. The assertions that matter are about *when* a check happens:
// output/input disjointness has to be settled before anything is created, or an output tree
// inside a content root feeds the next build its own previous output.

import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  link,
  messages,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";
import {
  assertDisjointTrees,
  canonicalizeInRoot,
  canonicalizeRoot,
  contains,
  overlaps,
  PathViolation,
} from "../../src/config/paths.js";
import { resolveModel } from "../../src/model/resolve.js";

afterAll(cleanupFixtures);

describe("trusted source root", () => {
  it("refuses a path that escapes the root", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra:
        "rendering:\n  profile: portal-content-v1\n  sources:\n    - root: ../outside\n      mount: /docs/\n",
    });
    mkdirSync(join(root, "..", "outside"), { recursive: true });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1001");
  });

  it("accepts '..' whose resolved target stays inside the root", async () => {
    const root = tempRoot();
    write(root, "shared/guide.md", "---\ntitle: Guide\n---\n\nBody.\n");
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./nested/../shared
      mount: /docs/
`,
    });
    mkdirSync(join(root, "nested"), { recursive: true });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    expect(result.model?.routes.map((r) => r.path)).toContain("/docs/guide/");
  });

  it("refuses a symlinked input", async () => {
    const outside = tempRoot();
    write(outside, "secret.md", "---\ntitle: Secret\n---\n");
    const root = tempRoot();
    mkdirSync(join(root, "content"), { recursive: true });
    link(root, "content/secret.md", join(outside, "secret.md"));
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1002");
  });

  it("refuses a path name that is not Unicode NFC", async () => {
    const root = tempRoot();
    // "café" written with a combining accent rather than the composed form.
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  assets:
    - root: ./café
      mount: /assets/
`,
    });
    mkdirSync(join(root, "café"), { recursive: true });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1004");
  });
});

/**
 * A source root reached through a symlink - the shape macOS presents to every test on the
 * machine, not just to a deliberate fixture: `os.tmpdir()` returns `/var/folders/...` and `/var`
 * is a symlink to `/private/var`, so the canonicalized root and the configuration path handed to
 * the resolver are one directory under two spellings. The alias is created explicitly so the case
 * runs on every platform, and so the two verdicts that must hold through it - a real escape and a
 * real symlink inside consumer sources - are asserted against the aliased root as well.
 */
describe("a source root reached through an alias", () => {
  /** `real` holds the site; `alias` is a symlink to it, one directory up. */
  function aliased(): { real: string; alias: string } {
    const parent = tempRoot("portal-alias-");
    const real = join(parent, "real");
    mkdirSync(real, { recursive: true });
    const alias = join(parent, "alias");
    symlinkSync(real, alias);
    return { real, alias };
  }

  it("puts the root, the configuration path and a declared path in one namespace", () => {
    const { real, alias } = aliased();
    const root = canonicalizeRoot(alias);
    expect(root).toBe(realpathSync.native(real));
    // The alias spelling maps onto the canonical one ...
    expect(canonicalizeInRoot(root, join(alias, "portal.yaml"))).toBe(join(root, "portal.yaml"));
    // ... a path already inside the root is returned untouched ...
    expect(canonicalizeInRoot(root, join(root, "content"))).toBe(join(root, "content"));
    // ... and something genuinely outside is not dragged in.
    const elsewhere = tempRoot("portal-elsewhere-");
    expect(contains(root, canonicalizeInRoot(root, elsewhere))).toBe(false);
  });

  it("accepts contained inputs declared through the alias", async () => {
    const { real, alias } = aliased();
    write(real, "content/guide.md", "---\ntitle: Guide\n---\n\nBody.\n");
    writeSite(real, {
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
`,
    });
    const result = await resolveModel({
      sourceRoot: canonicalizeRoot(alias),
      configPath: join(alias, "portal.yaml"),
    });
    expect(messages(result)).toBe("");
    expect(result.model?.routes.map((r) => r.path)).toContain("/docs/guide/");
    // Manifest paths stay root-relative, with no alias and no `..` left in them.
    for (const input of result.model?.inputs ?? []) {
      expect(input.path.startsWith("..")).toBe(false);
      expect(input.path).not.toContain("alias");
    }
  });

  it("still refuses a real escape declared through the alias", async () => {
    const { real, alias } = aliased();
    mkdirSync(join(real, "..", "outside"), { recursive: true });
    writeSite(real, {
      extra:
        "rendering:\n  profile: portal-content-v1\n  sources:\n    - root: ../outside\n      mount: /docs/\n",
    });
    const result = await resolveModel({
      sourceRoot: canonicalizeRoot(alias),
      configPath: join(alias, "portal.yaml"),
    });
    expect(codes(result.diagnostics)).toContain("FP1001");
  });

  it("still refuses a symlinked input under the alias", async () => {
    const outside = tempRoot();
    write(outside, "secret.md", "---\ntitle: Secret\n---\n");
    const { real, alias } = aliased();
    mkdirSync(join(real, "content"), { recursive: true });
    link(real, "content/secret.md", join(outside, "secret.md"));
    writeSite(real, {
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
`,
    });
    const result = await resolveModel({
      sourceRoot: canonicalizeRoot(alias),
      configPath: join(alias, "portal.yaml"),
    });
    expect(codes(result.diagnostics)).toContain("FP1002");
  });

  it("keeps output separation working when the output is named through the alias", async () => {
    const { real, alias } = aliased();
    write(real, "content/guide.md", "---\ntitle: Guide\n---\n");
    writeSite(real, {
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
`,
    });
    const out = join(alias, "content", "build");
    const result = await resolveModel({
      sourceRoot: canonicalizeRoot(alias),
      configPath: join(alias, "portal.yaml"),
      outDir: out,
      temporaryDirs: [`${out}.tmp`],
    });
    expect(codes(result.diagnostics)).toContain("FP1003");
    expect(existsSync(out)).toBe(false);
  });
});

describe("output, temporary and backup separation", () => {
  it("refuses an output tree inside a declared input root, before creating it", async () => {
    const root = tempRoot();
    write(root, "content/guide.md", "---\ntitle: Guide\n---\n");
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
`,
    });
    const out = join(root, "content", "build");
    const result = await resolveFixture(root, { outDir: out, temporaryDirs: [`${out}.tmp`] });
    expect(codes(result.diagnostics)).toContain("FP1003");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses an output tree that contains the source root", async () => {
    const root = tempRoot();
    writeSite(root);
    const result = await resolveFixture(root, { outDir: join(root, "..") });
    expect(codes(result.diagnostics)).toContain("FP1003");
  });

  it("checks containment in both directions", () => {
    expect(contains("/a/b", "/a/b/c")).toBe(true);
    expect(contains("/a/b/c", "/a/b")).toBe(false);
    expect(overlaps("/a/b/c", "/a/b")).toBe(true);
    expect(overlaps("/a/b", "/a/bc")).toBe(false);
    expect(() =>
      assertDisjointTrees(
        [{ absolute: "/a/out", label: "out" }],
        [{ absolute: "/a/out/x", label: "in" }],
      ),
    ).toThrow(PathViolation);
  });
});
