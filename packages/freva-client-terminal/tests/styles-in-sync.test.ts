// The generated constant is the stylesheet the component actually injects; it never reads
// styles.css at runtime. Reformat the .css without regenerating and the drift is silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STYLES } from "../src/styles.js";

test("styles.ts matches styles.css (run `npm run gen:styles -w @freva-org/freva-client-terminal` after editing the CSS)", () => {
  const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
  assert.equal(
    STYLES,
    css,
    "src/styles.ts is stale - regenerate it with `npm run gen:styles -w @freva-org/freva-client-terminal` and commit the result",
  );
});
