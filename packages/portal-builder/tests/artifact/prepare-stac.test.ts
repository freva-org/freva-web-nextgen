// `freva-portal-builder prepare-stac`: the STAC Browser preparation stage without a monorepo.
//
// What is tested here is everything but the network: that the command finds the recipe (the
// copy the package ships, or the workspace in a checkout), that it computes the recipe's own cache
// key rather than one of its own, and that a prepared directory is reused only when its provenance
// names the current key AND its bytes verify. The fetch-and-build itself is the recipe's
// `prepare.mjs`, exercised by `npm run stac:prepare` in CI; `tests/packaging` checks the shipped
// copy computes the same key from an npm install.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, REPO_ROOT, tempRoot } from "../helpers/fixture.js";
import { run } from "../../src/cli/index.js";
import {
  locateStacRecipe,
  stacCacheKey,
  stacMaterialsProblems,
} from "../../src/cli/prepare-stac.js";
import { PACKAGE_ROOT } from "../../src/util/package.js";
// @ts-expect-error - a plain ESM script, used here exactly as `prepack` uses it.
import { RECIPE_FILES, vendorStacRecipe } from "../../scripts/vendor-stac-recipe.mjs";
import { STAC_MATERIALS } from "../helpers/site.js";

afterAll(cleanupFixtures);

const WORKSPACE_RECIPE = join(REPO_ROOT, "packages", "stac-browser");

function capture(): {
  io: { out(t: string): void; err(t: string): void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, out, err };
}

function recipeKey(): string {
  return spawnSync(
    process.execPath,
    [join(WORKSPACE_RECIPE, "scripts", "prepare.mjs"), "--cache-key"],
    {
      encoding: "utf8",
    },
  ).stdout.trim();
}

describe("finding the recipe", () => {
  it("uses the workspace recipe in a repository checkout", () => {
    const found = locateStacRecipe();
    expect(found).toBeDefined();
    // Either the packed copy (after `npm pack`) or the workspace; both carry the same pin.
    const pin = JSON.parse(readFileSync(join(found!, "upstream.json"), "utf8"));
    const workspace = JSON.parse(readFileSync(join(WORKSPACE_RECIPE, "upstream.json"), "utf8"));
    expect(pin.commit).toBe(workspace.commit);
  });

  it("uses the copy a package ships when there is no workspace, with the same cache key", () => {
    const pkg = join(tempRoot("prepare-stac-pkg-"), "portal-builder");
    const target = vendorStacRecipe({ source: WORKSPACE_RECIPE, target: join(pkg, "stac-recipe") });
    expect(locateStacRecipe(pkg)).toBe(target);
    for (const entry of RECIPE_FILES as string[])
      expect(existsSync(join(target, entry))).toBe(true);
    // The recipe only: no tests, no checkout, no build output.
    for (const absent of ["tests", ".upstream", "dist", "materials", "node_modules"]) {
      expect(existsSync(join(target, absent))).toBe(false);
    }
    expect(stacCacheKey(target)).toBe(recipeKey());
  });

  it("prefers the workspace over a stac-recipe/ an earlier pack left behind", () => {
    // A checkout that once ran `npm pack` has a copy of the recipe from that day. The workspace is
    // the source of truth; running the stale copy would prepare an old recipe under its old key.
    const root = tempRoot("prepare-stac-both-");
    const pkg = join(root, "portal-builder");
    const workspace = join(root, "stac-browser");
    vendorStacRecipe({ source: WORKSPACE_RECIPE, target: join(pkg, "stac-recipe") });
    vendorStacRecipe({ source: WORKSPACE_RECIPE, target: workspace });
    expect(locateStacRecipe(pkg)).toBe(workspace);
  });

  it("refuses to vendor a file the recipe's own allow-list does not publish", () => {
    const fake = tempRoot("prepare-stac-fake-");
    cpSync(WORKSPACE_RECIPE, fake, {
      recursive: true,
      filter: (from) => !/[\\/](?:node_modules|\.upstream|materials|dist)(?:[\\/]|$)/.test(from),
    });
    const own = JSON.parse(readFileSync(join(fake, "package.json"), "utf8"));
    own.files = own.files.filter((f: string) => f !== "patches");
    writeFileSync(join(fake, "package.json"), JSON.stringify(own));
    expect(() => vendorStacRecipe({ source: fake, target: join(fake, "..", "out") })).toThrow(
      /'patches' is not in @freva-org\/stac-browser's own "files" allow-list/,
    );
  });

  it("finds nothing where there is nothing", () => {
    expect(locateStacRecipe(tempRoot("prepare-stac-none-"))).toBeUndefined();
  });
});

describe("the command", () => {
  it("prints the recipe's cache key and does nothing else", async () => {
    const io = capture();
    expect(await run(["prepare-stac", "--cache-key"], io.io)).toBe(0);
    expect(io.out.join("").trim()).toBe(recipeKey());
  });

  it("requires --out to prepare", async () => {
    const io = capture();
    expect(await run(["prepare-stac"], io.io)).toBe(2);
    expect(io.err.join("")).toContain("--out is required");
  });

  it("is in the help", async () => {
    const io = capture();
    await run(["help"], io.io);
    expect(io.out.join("")).toContain("prepare-stac --out <dir>");
  });
});

describe("the checkout directory", () => {
  /** A repository somebody is working in: one commit, and a file not committed yet. */
  function someoneElsesRepository(): string {
    const repo = tempRoot("prepare-stac-foreign-");
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "--quiet");
    writeFileSync(join(repo, "tracked.txt"), "committed\n");
    git("add", ".");
    git(
      "-c",
      "user.email=dev@example.org",
      "-c",
      "user.name=dev",
      "commit",
      "--quiet",
      "-m",
      "work",
    );
    writeFileSync(join(repo, "work-in-progress.txt"), "not committed yet\n");
    return repo;
  }

  it("refuses a --checkout-dir that is somebody else's repository, and leaves every file in it", async () => {
    // At the wrong revision, a checkout the recipe fetched is discarded and fetched again - so a
    // directory it did not fetch must be refused before that, not deleted by it.
    const repo = someoneElsesRepository();
    const out = join(tempRoot("prepare-stac-out-"), "materials");
    const io = capture();
    expect(await run(["prepare-stac", "--out", out, "--checkout-dir", repo], io.io)).toBe(1);
    expect(readFileSync(join(repo, "work-in-progress.txt"), "utf8")).toBe("not committed yet\n");
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("committed\n");
    expect(existsSync(join(repo, ".git", "freva-stac-recipe-checkout"))).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses any other non-empty directory too, without writing into it", async () => {
    const dir = tempRoot("prepare-stac-notes-");
    writeFileSync(join(dir, "notes.txt"), "mine\n");
    const io = capture();
    const out = join(tempRoot("prepare-stac-out-"), "materials");
    expect(await run(["prepare-stac", "--out", out, "--checkout-dir", dir], io.io)).toBe(1);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("mine\n");
  });
});

describe("reuse", () => {
  it("names what is wrong with a directory that is not prepared materials", () => {
    const dir = tempRoot("prepare-stac-empty-");
    expect(stacMaterialsProblems(dir, recipeKey())).toEqual(["no materials.json"]);
  });

  const withMaterials = STAC_MATERIALS ? it : it.skip;

  withMaterials("keeps a directory that verifies under the current key, offline", async () => {
    const dir = join(tempRoot("prepare-stac-reuse-"), "materials");
    cpSync(STAC_MATERIALS!, dir, { recursive: true });
    const provenance = JSON.parse(readFileSync(join(dir, "PROVENANCE.json"), "utf8"));
    // Only meaningful when the prepared tree came from THIS recipe and toolchain.
    if (provenance.cacheKey !== recipeKey()) return;
    expect(stacMaterialsProblems(dir, recipeKey())).toEqual([]);
    const io = capture();
    expect(await run(["prepare-stac", "--out", dir], io.io)).toBe(0);
    expect(io.out.join("")).toContain("Already prepared and verified");
  });

  withMaterials("prepares again a directory made before the patched-source gate existed", () => {
    // Materials from another procedure carry no patch result: the key covers the procedure, so they
    // do not match, and even provenance forged to the current key is refused without the recipe's
    // recorded patch result.
    const dir = join(tempRoot("prepare-stac-legacy-"), "materials");
    cpSync(STAC_MATERIALS!, dir, { recursive: true });
    const provenancePath = join(dir, "PROVENANCE.json");
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
    delete provenance.patchedSourceDigest;
    provenance.cacheKey = recipeKey();
    writeFileSync(provenancePath, JSON.stringify(provenance));
    const recipe = JSON.parse(readFileSync(join(WORKSPACE_RECIPE, "upstream.json"), "utf8"));
    const problems = stacMaterialsProblems(dir, recipeKey(), recipe.expected.patchedSourceDigest);
    expect(problems.join(" ")).toMatch(/records patched source \(none\)/);
  });

  withMaterials("prepares again when the key moved or a byte changed", () => {
    const dir = join(tempRoot("prepare-stac-stale-"), "materials");
    cpSync(STAC_MATERIALS!, dir, { recursive: true });
    expect(stacMaterialsProblems(dir, "sha256:other").join(" ")).toMatch(/cache key/);

    const manifest = JSON.parse(readFileSync(join(dir, "materials.json"), "utf8"));
    const victim = manifest.files.find((f: { path: string }) => f.path.endsWith(".js"));
    writeFileSync(join(dir, ...victim.path.split("/")), "tampered");
    const provenance = JSON.parse(readFileSync(join(dir, "PROVENANCE.json"), "utf8"));
    const problems = stacMaterialsProblems(dir, provenance.cacheKey);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toContain(victim.path);
  });
});

it("ships as a package file and is wired into prepack", () => {
  const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8"));
  expect(pkg.files).toContain("stac-recipe");
  expect(pkg.scripts.prepack).toContain("vendor-stac-recipe.mjs");
});
