/**
 * Guards on the browser TOOLING and the docs that describe it.
 *
 * Nothing here exercises authentication. Three things are worth a test because
 * each has already been wrong once: a Docker command that cannot work as
 * printed, a README that describes a matrix the code no longer uses, and the
 * claim that this round changed no runtime source.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOCKER_STRICT_COMMAND,
  MACOS_STRICT_MESSAGE,
  MACOS_WEBKIT_NOTE,
} from "../browser-tests/browsers.mjs";

// happy-dom rewrites `import.meta.url` to a non-file URL, so resolve from the
// project root Vitest already runs in.
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("the printed Docker command actually works", () => {
  it("builds before running the gate", () => {
    // The suites import ../dist. Without this a clean checkout fails with
    // "dist/ not found" before a single browser opens.
    expect(DOCKER_STRICT_COMMAND).toContain("npm run build");
    expect(DOCKER_STRICT_COMMAND).toMatch(
      /npm ci\s*&&\s*npm run build\s*&&\s*npm run test:browser:strict/,
    );
  });

  it("passes Docker's recommended browser flags", () => {
    expect(DOCKER_STRICT_COMMAND).toContain("--init");
    expect(DOCKER_STRICT_COMMAND).toContain("--ipc=host");
  });

  it("isolates node_modules and dist from the host checkout", () => {
    // Anonymous volumes: the container's Linux-native dependencies and
    // root-owned build output must not land in a macOS working copy.
    expect(DOCKER_STRICT_COMMAND).toContain("-v /w/node_modules");
    expect(DOCKER_STRICT_COMMAND).toContain("-v /w/dist");
  });

  it("is the same command both READMEs print and the macOS refusal shows", () => {
    for (const line of DOCKER_STRICT_COMMAND.split("\n")) {
      const fragment = line.trim();
      expect(MACOS_STRICT_MESSAGE).toContain(fragment);
      expect(read("README.md")).toContain(fragment);
      expect(read("browser-tests/README.md")).toContain(fragment);
    }
  });
});

describe("the packaged README describes the real matrix", () => {
  // README.md ships in the tarball (`files` in package.json);
  // browser-tests/README.md does not, so this one is what most readers see.
  const readme = read("README.md");

  it("no longer claims browsers:install always installs all three", () => {
    expect(readme).not.toContain("chromium, firefox, webkit (dev-only)");
    expect(readme).not.toMatch(/browsers:install.*#.*chromium,\s*firefox,\s*webkit/);
  });

  it("states both matrices", () => {
    expect(readme).toMatch(/macOS development\W+.*Chromium \+ Firefox/);
    expect(readme).toMatch(/Linux \/ Docker\W+.*Chromium \+ Firefox \+ WebKit/);
  });

  it("documents the supported contributor Node versions", () => {
    expect(readme).toMatch(/Node 22 or 24/);
    expect(read(".nvmrc").trim()).toBe("24");
  });

  it("attributes the WebKit omission to observed failures, not blanket support", () => {
    for (const text of [readme, read("browser-tests/README.md"), MACOS_WEBKIT_NOTE]) {
      // Whitespace-tolerant: the same sentence is line-wrapped differently in
      // prose and in the source string.
      expect(text).toMatch(/observed\s+Playwright\/macOS\s+compatibility\s+failures/);
      expect(text).not.toMatch(/WebKit .{0,40}(is )?not supported on macOS/i);
    }
  });
});

describe("src/ has not drifted from the recorded manifest", () => {
  // src/ holds the security-critical code, and an edit there that no test
  // notices is precisely what the mutation gate cannot catch — it only proves
  // the controls it already knows about are load-bearing. Refreshing the
  // manifest (`npm run manifest:refresh`) is deliberate, and belongs in the
  // same commit as the change it records.
  interface Manifest {
    fileCount: number;
    treeSha256: string;
    files: Record<string, string>;
  }
  const manifest = JSON.parse(read("tests/src-manifest.json")) as Manifest;

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(join(ROOT, dir)).sort()) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
      else out.push(rel);
    }
    return out;
  };
  const sha = (rel: string) =>
    createHash("sha256")
      .update(readFileSync(join(ROOT, rel)))
      .digest("hex");

  it("has the same file list", () => {
    expect(walk("src")).toEqual(Object.keys(manifest.files));
    expect(walk("src")).toHaveLength(manifest.fileCount);
  });

  it("has byte-identical contents", () => {
    const actual = Object.fromEntries(walk("src").map((f) => [f, sha(f)]));
    // Per file, so a failure names which one drifted rather than only the tree.
    expect(actual).toEqual(manifest.files);
  });

  it("reproduces the recorded tree hash", () => {
    const tree = createHash("sha256")
      .update(
        walk("src")
          .map((f) => `${f} ${sha(f)}`)
          .join("\n"),
      )
      .digest("hex");
    expect(tree).toBe(manifest.treeSha256);
  });
});
