// The generated constants are the stylesheets the components actually inject; nothing reads the
// .css at runtime. Reformat a .css without regenerating and the drift is silent, so pin them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STYLES } from "../src/styles.js";
import { PICKER_STYLES } from "../src/picker/styles.js";

const CASES: Array<[string, string, string]> = [
  ["styles.ts", "src/styles.css", STYLES],
  ["picker/styles.ts", "src/picker.css", PICKER_STYLES],
];

for (const [name, css, constant] of CASES) {
  test(`${name} matches ${css} (run \`npm run gen:styles\` after editing the CSS)`, () => {
    assert.equal(
      constant,
      readFileSync(join(process.cwd(), css), "utf8"),
      `src/${name} is stale - regenerate it with \`npm run gen:styles\` and commit the result`,
    );
  });
}

test("the picker stylesheet is entirely scoped to .freva-picker", () => {
  // Every rule must be scoped, or dropping the picker into a host page restyles the host. Strip
  // comments and at-rule preludes, then check each selector list.
  const withoutComments = PICKER_STYLES.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...withoutComments.matchAll(/(^|[};])\s*([^{};@]+)\{/g)]
    .map((m) => m[2].trim())
    .filter((s) => s && !s.startsWith("to") && !/^\d+%$/.test(s));
  const unscoped = selectors.filter((sel) =>
    sel
      .split(",")
      .map((s) => s.trim())
      .some((s) => s && !s.startsWith(".freva-picker")),
  );
  assert.deepEqual(unscoped, [], `unscoped picker selectors: ${unscoped.join(" | ")}`);
});
