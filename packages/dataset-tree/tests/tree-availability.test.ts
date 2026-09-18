// The background availability probe, planned rows, and what a failed branch does to the rest of
// the tree.
//
// These are the three behaviours that decide what a reader sees BEFORE they open anything: which
// collections are worth opening, which cannot be opened at all, and what happens to the other ten
// when one of them refuses. Each fails in a way a markup test cannot see - a probe that blocks the
// first paint, a "planned" row with a chevron, a single 403 replacing the whole tree.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { mountDatasetTree } from "../src/index.js";
import { datasetTreeError } from "../src/errors.js";
import type { DatasetTreeAvailability, DatasetTreeNode } from "../src/types.js";
import { click, makeHost, q, qa, resetDom, rowNames, until } from "./helpers.js";

const ROOTS: DatasetTreeNode[] = [
  { id: "full", kind: "collection", name: "full", hasChildren: true },
  { id: "bare", kind: "collection", name: "bare", hasChildren: true },
  { id: "refused", kind: "collection", name: "refused", hasChildren: true },
  {
    id: "later",
    kind: "collection",
    name: "later",
    hasChildren: false,
    availability: "planned",
    availabilityNote: "coming soon",
  },
];

/** A source whose probe answers from a script and records who it was asked about. */
function probingSource(answers: Record<string, DatasetTreeAvailability | undefined | "throw">) {
  const asked: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  return {
    asked,
    peak: () => peak,
    /** Let every probe that is currently waiting finish. */
    flush(): void {
      const pending = release.splice(0, release.length);
      for (const go of pending) go();
    },
    source: {
      loadRoots: () => Promise.resolve(ROOTS),
      loadChildren: () => Promise.resolve([]),
      async probeAvailability(node: DatasetTreeNode): Promise<DatasetTreeAvailability | undefined> {
        asked.push(node.id);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight -= 1;
        const answer = answers[node.id];
        if (answer === "throw") throw new Error("probe exploded");
        return answer;
      },
    },
  };
}

const badges = (host: ParentNode): string[] =>
  qa(host, ".dataset-tree__badge").map((b) => b.textContent ?? "");

test("every declared root is on screen before a single probe has answered", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const probing = probingSource({ full: "available", bare: "empty" });
  const handle = mountDatasetTree(host, { source: probing.source });
  await until(() => rowNames(host).length === 4, "roots");

  // The ordering IS the requirement. A tree that waited for four round-trips before drawing its
  // first row looks broken on a slow connection, for information that is a footnote on two of them.
  assert.deepEqual(rowNames(host), ["full", "bare", "refused", "later"]);
  assert.deepEqual(badges(host), ["coming soon"], "a probe answer appeared before it answered");

  probing.flush();
  await until(() => badges(host).length === 2, "the empty badge");
  assert.deepEqual(badges(host).sort(), ["coming soon", "empty"]);
  handle.destroy();
});

test("only a proven-empty listing gets a badge; a failed or unknown probe gets none", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const probing = probingSource({
    full: "available",
    bare: "empty",
    // A probe that failed and a probe that could not tell are the same thing, and neither may
    // claim the bucket is empty: that is a factual statement nothing checked.
    refused: "throw",
  });
  const handle = mountDatasetTree(host, { source: probing.source });
  await until(() => rowNames(host).length === 4, "roots");
  probing.flush();
  await until(() => badges(host).length === 2, "badges settle");

  const row = (id: string): Element | null => q(host, `[data-dataset-tree-id="${id}"]`);
  assert.equal(
    row("full")?.querySelector(".dataset-tree__badge"),
    null,
    "a full bucket got a badge",
  );
  assert.ok(row("bare")?.querySelector(".dataset-tree__badge"), "the empty bucket got none");
  assert.equal(
    row("refused")?.querySelector(".dataset-tree__badge"),
    null,
    "a failed probe was reported as empty",
  );
  handle.destroy();
});

test("probes are bounded, skip what the source already answered, and stop when the tree does", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const probing = probingSource({ full: "available", bare: "empty", refused: undefined });
  const handle = mountDatasetTree(host, { source: probing.source });
  await until(() => rowNames(host).length === 4, "roots");
  await until(() => probing.asked.length > 0, "the first probe");

  // The planned root is never asked. Its bucket may not exist yet, and the catalogue has already
  // said what its row shows - a request could only confirm or contradict something nobody will act
  // on, and contradicting it would put a chevron on a row that cannot be opened.
  assert.ok(!probing.asked.includes("later"), "a planned root was probed");
  // Bounded: three probeable roots, never more than the concurrency limit in flight at once.
  assert.ok(probing.peak() <= 4, `${probing.peak()} probes ran at once`);

  handle.destroy();
  probing.flush();
  // Nothing after a destroy: a probe that resolves later must not write a badge onto a tree that
  // has been taken off the page.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(host.querySelector(".dataset-tree__badge"), null);
});

test("a planned root has no chevron, no expanded state, and cannot be opened", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const probing = probingSource({});
  const handle = mountDatasetTree(host, { source: probing.source });
  await until(() => rowNames(host).length === 4, "roots");

  const row = q(host, '[data-dataset-tree-id="later"] .dataset-tree__row');
  assert.ok(row, "the planned root did not render");
  // No promise of an expansion: no `aria-expanded`, and the chevron column is a blank spacer.
  assert.equal(row!.getAttribute("aria-expanded"), null);
  assert.ok(
    q(host, '[data-dataset-tree-id="later"] .dataset-tree__chev--leaf'),
    "a planned root still draws an expansion chevron",
  );
  // The badge is the source's own word, not a taxonomy the component invented.
  assert.equal(
    q(host, '[data-dataset-tree-id="later"] .dataset-tree__badge')?.textContent,
    "coming soon",
  );

  click(row);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(rowNames(host), ["full", "bare", "refused", "later"], "it opened something");
  handle.destroy();
});

test("a refused branch says why, keeps its siblings, and offers Retry only when retrying helps", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  let attempts = 0;
  const handle = mountDatasetTree(host, {
    source: {
      loadRoots: () => Promise.resolve(ROOTS),
      loadChildren: (node) => {
        if (node.id === "refused") {
          return Promise.reject(
            datasetTreeError(
              "access-denied",
              "Access denied - this bucket does not permit anonymous browser listing.",
              { bucket: "refused" },
            ),
          );
        }
        if (node.id === "bare") {
          attempts += 1;
          if (attempts === 1) {
            return Promise.reject(
              datasetTreeError(
                "server",
                "The storage service is temporarily unavailable (HTTP 503).",
              ),
            );
          }
          return Promise.resolve([{ id: "bare/x", kind: "file", name: "x.nc" } as DatasetTreeNode]);
        }
        return Promise.resolve([{ id: "full/a", kind: "file", name: "a.nc" } as DatasetTreeNode]);
      },
    },
  });
  await until(() => rowNames(host).length === 4, "roots");

  click(q(host, '[data-dataset-tree-id="full"] .dataset-tree__row'));
  await until(() => rowNames(host).includes("a.nc"), "a healthy sibling");

  click(q(host, '[data-dataset-tree-id="refused"] .dataset-tree__row'));
  await until(() => Boolean(q(host, ".dataset-tree__msg--error")), "the refusal");

  const failure = q(host, ".dataset-tree__msg--error");
  // The source's own sentence, printed as written - not wrapped in "Could not list -".
  assert.equal(
    failure!.textContent?.trim(),
    "Access denied - this bucket does not permit anonymous browser listing.",
  );
  // No stack, no URL, no bucket path in what the reader sees.
  assert.doesNotMatch(failure!.textContent ?? "", /at |https?:\/\/|s3:\/\//);
  // No Retry: the same request will be refused again.
  assert.equal(q(host, '[data-dt-key="retry:refused"]'), null, "a refusal offered Retry");
  // The rest of the tree is untouched: the healthy branch is still open and still listed.
  assert.ok(rowNames(host).includes("a.nc"), "a failure elsewhere collapsed a working branch");
  assert.equal(rowNames(host).length, 5);

  // A retryable failure DOES get the control, and using it repeats only that branch.
  click(q(host, '[data-dataset-tree-id="bare"] .dataset-tree__row'));
  await until(() => Boolean(q(host, '[data-dt-key="retry:bare"]')), "the retry control");
  click(q(host, '[data-dt-key="retry:bare"]'));
  await until(() => rowNames(host).includes("x.nc"), "the retried listing");
  assert.equal(attempts, 2, "Retry did not repeat exactly one request");
  assert.ok(rowNames(host).includes("a.nc"), "retrying one branch disturbed another");
  handle.destroy();
});

test("a listing the reader abandoned is not an error", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const handle = mountDatasetTree(host, {
    source: {
      loadRoots: () => Promise.resolve(ROOTS),
      loadChildren: () =>
        Promise.reject(datasetTreeError("cancelled", "The listing was cancelled.")),
    },
  });
  await until(() => rowNames(host).length === 4, "roots");
  click(q(host, '[data-dataset-tree-id="full"] .dataset-tree__row'));
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Collapsing a branch aborts its request, and that rejection arrives exactly where a 500 would.
  // Telling somebody "the listing was cancelled" about a listing they cancelled is noise - and
  // leaving the branch in an error state would mean opening it again showed a stale message
  // instead of trying afresh.
  assert.equal(q(host, ".dataset-tree__msg--error"), null, "a cancellation was reported");
  handle.destroy();
});
