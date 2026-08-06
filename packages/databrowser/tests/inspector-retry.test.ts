// inspector: a failed lazy import must not poison future attempts - the cache resets on reject,
// so a transient chunk failure can be retried. Driven through the injectable importer seam.
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadInspector, setInspectorImporterForTests } from "../src/components/inspector.js";

test("loadInspector retries after a transient import failure", async () => {
  let calls = 0;
  let lastUrl = "";
  setInspectorImporterForTests(async (url: string) => {
    calls++;
    lastUrl = url;
    if (calls === 1) throw new Error("chunk load failed (transient)");
    return { ready: true }; // no DataInspectorElement -> skips customElements.define
  });
  try {
    await assert.rejects(
      loadInspector("https://cdn.example/di.mjs"),
      /transient/,
      "first attempt rejects",
    );
    const mod = await loadInspector("https://cdn.example/di.mjs"); // cache was reset -> this retries
    assert.ok(mod?.ready, "second attempt succeeds");
    assert.equal(calls, 2, "the import was actually retried, not served from a poisoned cache");
    assert.equal(lastUrl, "https://cdn.example/di.mjs", "imports the configured URL");
  } finally {
    setInspectorImporterForTests(null); // restore the real dynamic import for other tests
  }
});
