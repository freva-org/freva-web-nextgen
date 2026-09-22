/**
 * A browser suite must never test a `dist/` built from other sources.
 *
 * A Firefox run reported the startup JSPI warning and the per-command display-capture warning that
 * the checked-out sources no longer contain: the suites were new, the build was not. Freshness is
 * now a content digest recorded by `npm run build` and checked before any suite runs. These tests
 * hold the digest to CONTENT - a timestamp change alone is not a rebuild, and an edit that keeps
 * the timestamp is still an edit - and hold every documented browser command to the one mechanism.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { STAMP_FILE, checkStamp, sourceDigest, writeStamp } from "../scripts/build-stamp.mjs";

const INPUTS = ["src", "tsconfig.json"];
const made: string[] = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "build-stamp-"));
  made.push(dir);
  mkdirSync(join(dir, "src", "worker"), { recursive: true });
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "src", "worker", "repl.ts"), "export const warn = false;\n");
  writeFileSync(join(dir, "src", "_freva_bridge.py"), "MESSAGE = 'concise'\n");
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dist/ freshness is decided by content", () => {
  it("accepts a dist/ built from exactly these sources", () => {
    const dir = fixture();
    writeStamp(dir, INPUTS);
    expect(checkStamp(dir, INPUTS)).toEqual({ ok: true });
  });

  it("refuses it once any source byte changes, whatever the timestamps say", () => {
    const dir = fixture();
    writeStamp(dir, INPUTS);
    const file = join(dir, "src", "_freva_bridge.py");
    const old = new Date(2020, 0, 1);
    writeFileSync(file, "MESSAGE = 'noisy'\n");
    utimesSync(file, old, old); // an edit that looks OLDER than the build
    const result = checkStamp(dir, INPUTS);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(/STALE/);
  });

  it("is NOT fooled into a rebuild by a timestamp change alone", () => {
    const dir = fixture();
    writeStamp(dir, INPUTS);
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(join(dir, "src", "worker", "repl.ts"), future, future);
    expect(checkStamp(dir, INPUTS)).toEqual({ ok: true });
  });

  it("notices an added or removed source file", () => {
    const dir = fixture();
    writeStamp(dir, INPUTS);
    const before = sourceDigest(dir, INPUTS);
    writeFileSync(join(dir, "src", "new.ts"), "");
    expect(sourceDigest(dir, INPUTS)).not.toBe(before);
    expect(checkStamp(dir, INPUTS).ok).toBe(false);
  });

  it("refuses a dist/ with no stamp, and a missing dist/", () => {
    const dir = fixture();
    expect(checkStamp(dir, INPUTS)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(STAMP_FILE),
    });
    rmSync(join(dir, "dist"), { recursive: true });
    writeStamp(dir, INPUTS);
    expect(checkStamp(dir, INPUTS)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/dist\/ does not exist/),
    });
  });
});

describe("every documented browser command builds first, through ONE mechanism", () => {
  const pkgDir = fileURLToPath(new URL("..", import.meta.url));
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const runner = readFileSync(join(pkgDir, "browser-tests", "run.mjs"), "utf8");
  const harness = readFileSync(join(pkgDir, "browser-tests", "harness.mjs"), "utf8");
  const browserScripts = Object.entries(pkg.scripts as Record<string, string>).filter(([name]) =>
    name.startsWith("test:browser"),
  );

  it("has the browser scripts to check", () => {
    expect(browserScripts.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "test:browser",
        "test:browser:chromium",
        "test:browser:firefox",
        "test:browser:firefox:ci",
        "test:browser:webkit",
        "test:browser:zarr",
        "test:browser:paste",
      ]),
    );
  });

  it.each(browserScripts)("%s reaches the runner, which builds", (_name, command) => {
    // Directly, or through another test:browser script that does.
    expect(command).toMatch(/browser-tests\/run\.mjs|npm run test:browser/);
    expect(command).not.toContain("--no-build");
  });

  it("the runner builds, then checks the digest, before it starts any suite", () => {
    const buildAt = runner.indexOf('spawnSync("npm", ["run", "build"]');
    const checkAt = runner.indexOf("checkStamp(PKG_DIR)");
    const firstSuite = runner.indexOf("await runChild(");
    expect(buildAt).toBeGreaterThan(0);
    expect(checkAt).toBeGreaterThan(buildAt);
    expect(firstSuite).toBeGreaterThan(checkAt);
  });

  it("the build records the digest, and every suite's requireDist() checks it", () => {
    expect(pkg.scripts.build).toMatch(/node scripts\/build-stamp\.mjs write$/);
    expect(harness).toMatch(/export function requireDist\(\) \{[\s\S]{0,700}checkStamp\(PKG\)/);
  });
});
