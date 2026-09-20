/**
 * What a browser downloads should not be what a reader reads. This package spends bytes on prose
 * deliberately, and that is worth paying for in the source and in the `.d.ts` an editor shows a
 * consumer - not over the wire, where roughly 54 KiB gzipped of the emitted engine was comments,
 * about 47% of everything a host served. So `npm run build` emits declarations and JavaScript in
 * separate passes: easy to undo by accident with a merged tsconfig, and invisible when it happens.
 * Both halves are asserted; losing the comments from `.d.ts` would be the worse of the two.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const built = existsSync(`${DIST}index.js`);

/** Files that carry the heaviest prose in the source, so the difference is unmissable. */
const PAIRS = ["types", "browser-python", "artifact-stream", "worker/repl", "embed/host"];

describe.runIf(built)("the emitted build", () => {
  it("ships JavaScript with no comments in it", () => {
    for (const name of PAIRS) {
      const js = readFileSync(`${DIST}${name}.js`, "utf8");
      expect(js, `${name}.js still carries block comments`).not.toMatch(/\/\*/);
      // Line comments too. The `//# sourceMappingURL=` trailer is not one of these - it is a
      // directive the browser and the debugger read, and stripping it would cost the source maps
      // this build still emits.
      const lines = js
        .split("\n")
        .filter((l) => /^\s*\/\//.test(l) && !l.includes("sourceMappingURL"));
      expect(lines, `${name}.js still carries line comments`).toEqual([]);
    }
  });

  it("keeps every word of that documentation in the declarations", () => {
    for (const name of PAIRS) {
      const dts = readFileSync(`${DIST}${name}.d.ts`, "utf8");
      const docs = dts.match(/\/\*\*/g) ?? [];
      expect(
        docs.length,
        `${name}.d.ts lost its JSDoc - consumers lose IntelliSense`,
      ).toBeGreaterThan(3);
    }
    // The specific ones a consumer is most likely to hover, named so a regression says which.
    const types = readFileSync(`${DIST}types.d.ts`, "utf8");
    expect(types, "CompletionResult.start must still explain its unit").toMatch(/UTF-16 CODE-UNIT/);
    expect(types, "cleanupErrors must still say it is best-effort").toMatch(/BEST-EFFORT/);
  });

  it("still emits declarations and source maps for both", () => {
    for (const name of PAIRS) {
      expect(existsSync(`${DIST}${name}.d.ts`), `${name}.d.ts missing`).toBe(true);
      expect(existsSync(`${DIST}${name}.js.map`), `${name}.js.map missing`).toBe(true);
      expect(existsSync(`${DIST}${name}.d.ts.map`), `${name}.d.ts.map missing`).toBe(true);
    }
  });
});
