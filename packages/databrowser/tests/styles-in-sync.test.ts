// styles.ts is generated from styles.css by scripts/gen-styles.mjs. Nothing
// enforced that, so the two silently drifted: styles.css was reformatted and
// the generated constant - the stylesheet the component actually injects - kept
// the older text. This pins them together, because the drift is invisible
// otherwise: the component never reads styles.css at runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STYLES } from "../src/styles.js";

test("styles.ts matches styles.css (run `npm run gen:styles` after editing the CSS)", () => {
  const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
  assert.equal(
    STYLES,
    css,
    "src/styles.ts is stale - regenerate it with `npm run gen:styles` and commit the result",
  );
});
