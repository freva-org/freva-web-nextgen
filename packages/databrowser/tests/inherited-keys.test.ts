// URL and typed facet keys that name Object.prototype members must parse as ordinary keys (or be
// dropped, for __proto__), never crash the component or touch Object.prototype.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSearchIntentV1 } from "../src/intent.js";
import { groupValues } from "../src/records.js";
import { parseFacetTokens, parseUrlQuery } from "../src/state.js";

const KEYS = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

test("a link with inherited-name keys parses without throwing", () => {
  for (const key of KEYS) {
    const search = `?${key}=x&project=cmip6`;
    assert.doesNotThrow(() => parseUrlQuery(search), key);
    assert.doesNotThrow(() => parseSearchIntentV1(search), key);
    assert.deepEqual(parseUrlQuery(search).selected.project, ["cmip6"], key);
  }
});

test("typed facet tokens with inherited-name keys parse without throwing", () => {
  for (const key of KEYS) {
    assert.doesNotThrow(() => parseFacetTokens(`${key}=x project=cmip6`), key);
    assert.deepEqual(parseFacetTokens(`${key}=x project=cmip6`).project, ["cmip6"], key);
  }
});

test("names like constructor become own keys; __proto__ is dropped", () => {
  const parsed = parseFacetTokens("constructor=a tostring=b __proto__=c");
  assert.deepEqual(parsed.constructor, ["a"]);
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, "constructor"));
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.ok(!Object.keys(parsed).includes("__proto__"));
});

test("nothing reaches Object.prototype", () => {
  parseSearchIntentV1("?__proto__=polluted&constructor=polluted");
  parseFacetTokens("__proto__=polluted");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(typeof Object.prototype.toString, "function");
});

test("groupValues makes own keys, keeps order, and drops __proto__", () => {
  const grouped = groupValues([
    ["toString", "x"],
    ["__proto__", "polluted"],
    ["toString", "y"],
    ["toString", "x"],
  ]);
  assert.deepEqual(grouped, { toString: ["x", "y", "x"] });
  assert.equal(Object.getPrototypeOf(grouped), Object.prototype);
  assert.deepEqual(
    groupValues(
      [
        ["k", "x"],
        ["k", "x"],
      ],
      true,
    ),
    { k: ["x"] },
  );
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
