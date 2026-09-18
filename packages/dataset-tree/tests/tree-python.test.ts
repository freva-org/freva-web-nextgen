// "Try in Python" - the control, the rule that decides it exists, and what it sends.
//
// Two things are being defended here. One is that the button appears exactly when a snippet is a
// registered, complete, executable Python program and never otherwise, which is why most of this
// file is disqualifiers rather than the happy path. The other is that pressing it produces a NAME
// and not a program: the component draws the code and still refuses to hand it over, because this
// event is built to survive being forwarded to a sandboxed interpreter on another origin.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { mountDatasetTree, tryPythonEligible } from "../src/index.js";
import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "../src/snapshot.js";
import { hasUnresolvedPlaceholder, isPythonLanguage } from "../src/python.js";
import { click, makeHost, q, qa, resetDom, rowNames, until } from "./helpers.js";
import type { DatasetAccessExample, TryPythonEvent } from "../src/types.js";

/** A real 64-character lowercase hex digest, so the shape check has something valid to accept. */
const DIGEST = "a".repeat(64);

const PYTHON = 'import xarray as xr\n\nds = xr.open_zarr("s3://archive/tas.zarr")\nprint(ds)\n';

/** A docstring carrying a blank, built here so the quotes stay readable. */
const TRIPLE_WITH_BLANK = ['"""', "Open <dataset> from the archive.", '"""', "print(1)"].join("\n");
/** A triple-quoted literal spanning lines, with a blank inside it. */
const TRIPLE_MULTILINE = ["s = " + "'''", "multi <dataset>", "'''"].join("\n");

function example(over: Partial<DatasetAccessExample> = {}): DatasetAccessExample {
  return {
    id: "py",
    label: "Python",
    language: "python",
    code: PYTHON,
    executable: true,
    digest: DIGEST,
    ...over,
  };
}

function row(host: ParentNode, id: string): HTMLButtonElement | null {
  return q<HTMLButtonElement>(
    host,
    `[data-dataset-tree-id="${id}"] > .dataset-tree__rowline > .dataset-tree__row`,
  );
}

/** Mount, open the node, open the access disclosure. Returns the handle and the events seen. */
async function open(
  host: HTMLElement,
  examples: readonly DatasetAccessExample[],
  python: Record<string, unknown> | undefined = undefined,
): Promise<{ handle: { destroy(): void }; events: TryPythonEvent[] }> {
  const events: TryPythonEvent[] = [];
  const catalog = parseDatasetTreeCatalogV1({
    schemaVersion: 1,
    roots: [
      { id: "d1", kind: "dataset", name: "tas.zarr", path: "s3://archive/reanalysis/tas.zarr" },
    ],
  });
  const handle = mountDatasetTree(host, {
    source: createSnapshotSource(catalog),
    accessExamples: () => examples,
    python: python ?? { onTry: (event: TryPythonEvent) => events.push(event) },
  } as never);
  await until(() => rowNames(host).includes("tas.zarr"), "roots");
  click(row(host, "d1"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");
  click(q(host, '[data-dt-key="disclose:d1"]'));
  await until(() => Boolean(q(host, ".dataset-tree__codecard")), "code card");
  return { handle, events };
}

const run = (host: ParentNode): HTMLButtonElement | null =>
  q<HTMLButtonElement>(host, '[data-dt-key="try:d1"]');

// the rule

test("the eligibility rule reads as its five conditions", () => {
  const python = { onTry: () => undefined };
  assert.equal(tryPythonEligible(example(), python), true);

  assert.equal(tryPythonEligible(example(), undefined), false, "no integration");
  assert.equal(tryPythonEligible(example(), { ...python, enabled: false }), false, "disabled");
  assert.equal(tryPythonEligible(example({ language: "shell" }), python), false, "not Python");
  assert.equal(tryPythonEligible(example({ executable: false }), python), false, "opted out");
  assert.equal(
    tryPythonEligible(example({ executable: undefined }), python),
    false,
    "not opted in",
  );
  assert.equal(tryPythonEligible(example({ digest: undefined }), python), false, "unregistered");
  assert.equal(tryPythonEligible(example({ digest: "nope" }), python), false, "malformed digest");
  assert.equal(tryPythonEligible(example({ id: "" }), python), false, "no identity");
  assert.equal(tryPythonEligible(undefined, python), false, "no example");
});

test("Python is a closed set of language tags, not a prefix match", () => {
  for (const yes of ["python", "Python", "PY", " python3 "]) {
    assert.equal(isPythonLanguage(yes), true, yes);
  }
  for (const no of ["pythonic", "python-fragment", "ipython", "shell", "", undefined]) {
    assert.equal(isPythonLanguage(no), false, String(no));
  }
});

test("a snippet with a blank left in it is not runnable, and real Python is not a blank", () => {
  for (const template of [
    'open("{{ dataset.path }}")',
    'open("${BUCKET}/tas.zarr")',
    'token = "<YOUR_TOKEN>"',
    'path = "<path/to/store>"',
    'bucket = "<my-bucket>"',
  ]) {
    assert.equal(hasUnresolvedPlaceholder(template), true, template);
  }
  for (const real of [
    PYTHON,
    "if a < b and c > d:\n    pass\n",
    'print(f"{ds.dims}")\n',
    "xs = [x for x in range(10) if x < 5]\n",
    "def f() -> int:\n    return 1\n",
  ]) {
    assert.equal(hasUnresolvedPlaceholder(real), false, real);
  }
});

test("a LOWERCASE placeholder in a string is a blank too - the form these actually take", () => {
  // The rule this replaces asked the bracketed text to shout: an uppercase letter, a hyphen or a
  // slash. Every real placeholder in a real catalogue looked like this instead, and the snippet
  // was offered as runnable - pressing the button would have asked an interpreter to open a store
  // called `<dataset>.zarr`.
  for (const blank of [
    'xr.open_zarr("https://host/<dataset>.zarr")',
    'open("<bucket>/tas.zarr")',
    'ds["<variable>"]',
    'connect("<endpoint>")',
    "url = 's3://<bucket>/<dataset>'",
    'xr.open_zarr(\n    "https://host/<dataset>.zarr",\n)',
  ]) {
    assert.equal(hasUnresolvedPlaceholder(blank), true, blank);
  }
  // A docstring is a string, so a blank in one counts. Fail-closed, and stated so a reader who
  // meets it knows the rule rather than guessing at it.
  assert.equal(hasUnresolvedPlaceholder(TRIPLE_WITH_BLANK), true);
});

test("a comparison is still a comparison, however it is spelled", () => {
  // The adversarial half. What separates a placeholder from `<` and `>` is not what the text looks
  // like - `count<total>limit` is lowercase and bracketed and is three names and two operators -
  // it is that a placeholder is inside a STRING and a comparison never is.
  for (const real of [
    "if count<total>limit:\n    pass\n",
    "print(a<b>c)\n",
    "assert lower<value>upper\n",
    "n = a<<b>>c\n",
    "if x<=y and y>=z:\n    pass\n",
    "flags = first<second\n",
    'print("a < b")\n',
    "# see <docs> for the full argument list\nprint(1)\n",
  ]) {
    assert.equal(hasUnresolvedPlaceholder(real), false, real);
  }
});

test("the string scanner does not lose its place", () => {
  // An escaped quote does not end a string, a triple-quoted block spans lines, and a `#` inside a
  // string is not a comment. Each of these, wrong, would move the boundary the rule depends on.
  assert.equal(hasUnresolvedPlaceholder('print("a\\"b")\nif p<q>r: pass'), false);
  assert.equal(hasUnresolvedPlaceholder('s = "# not a comment <dataset>"'), true);
  assert.equal(hasUnresolvedPlaceholder(TRIPLE_MULTILINE), true);
  assert.equal(hasUnresolvedPlaceholder("# <dataset>\nif p<q>r: pass"), false);
  // An unterminated literal is a syntax error, and everything after it fails closed.
  assert.equal(hasUnresolvedPlaceholder('s = "unterminated\nif p<q>r: pass'), false);
});

// the control

test("an eligible Python example gets Copy AND Try in Python, side by side", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = await open(host, [example()]);

  const copy = q<HTMLButtonElement>(host, '[data-dt-key="example:d1"]');
  assert.equal(copy?.textContent, "Copy code");
  const button = run(host);
  assert.ok(button, "no Try in Python control");
  assert.match(button.textContent ?? "", /Try in Python/);
  assert.equal(button.getAttribute("aria-label"), "Run the Python example in Python");
  assert.equal(button.getAttribute("data-dt-example"), "py");
  assert.equal(button.type, "button", "a run control that submits its host's form");

  // RUN SITS BESIDE INSPECT; COPY STAYS WITH THE CODE.
  //
  // They were together in the snippet's title bar, which is right for `Copy code` - it acts on the
  // text under it - and wrong for the run control: opening this store in an interpreter is the
  // alternative to opening it in the inspector, and the two were a disclosure apart. The action row
  // now holds the pair of things you can DO with the store; the card holds the one thing you can do
  // with the text.
  assert.equal(
    qa(host, ".dataset-tree__tabbar .dataset-tree__btn").length,
    0,
    "the tab strip still carries an action",
  );
  assert.deepEqual(
    qa(host, ".dataset-tree__actions .dataset-tree__btn").map((b) =>
      b.getAttribute("data-dt-action"),
    ),
    ["try-python"],
    "the run control is not in the action row",
  );
  assert.deepEqual(
    qa(host, ".dataset-tree__codehead .dataset-tree__btn").map((b) =>
      b.getAttribute("data-dt-action"),
    ),
    ["copy-example"],
    "the code card kept a control that is not Copy",
  );
  handle.destroy();
});

test("no control when the integration is absent, and none when it is switched off", async (t) => {
  t.after(resetDom);
  const a = makeHost();
  const first = await open(a, [example()], { onTry: () => undefined, enabled: false });
  assert.equal(run(a), null, "a disabled integration still drew the button");
  assert.ok(q(a, '[data-dt-key="example:d1"]'), "Copy disappeared with it");
  first.handle.destroy();

  const b = makeHost();
  const catalog = parseDatasetTreeCatalogV1({
    schemaVersion: 1,
    roots: [{ id: "d1", kind: "dataset", name: "tas.zarr" }],
  });
  const handle = mountDatasetTree(b, {
    source: createSnapshotSource(catalog),
    accessExamples: () => [example()],
  });
  await until(() => rowNames(b).includes("tas.zarr"), "roots");
  click(row(b, "d1"));
  await until(() => Boolean(q(b, ".dataset-tree__details")), "details");
  click(q(b, '[data-dt-key="disclose:d1"]'));
  await until(() => Boolean(q(b, ".dataset-tree__codecard")), "code card");
  assert.equal(run(b), null, "the control appeared without a `python` option");
  handle.destroy();
});

test("each disqualifier removes the control and leaves everything else alone", async (t) => {
  t.after(resetDom);
  for (const over of [
    { language: "shell" },
    { executable: false },
    { executable: undefined },
    { digest: undefined },
    { code: 'open("<YOUR_BUCKET>/tas.zarr")' },
  ] as Partial<DatasetAccessExample>[]) {
    const host = makeHost();
    const { handle } = await open(host, [example(over)]);
    assert.equal(run(host), null, `still runnable with ${JSON.stringify(over)}`);
    assert.ok(q(host, '[data-dt-key="example:d1"]'), "Copy went away too");
    assert.ok(q(host, ".dataset-tree__code")?.textContent, "the code stopped being shown");
    handle.destroy();
    host.remove();
  }
});

test("the control belongs to the visible tab, not to the node", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle } = await open(host, [
    example(),
    { id: "cli", label: "CLI", language: "shell", code: "s5cmd cp s3://archive/tas.zarr ." },
  ]);
  assert.ok(run(host), "the Python tab has no control");

  click(q(host, '[data-dt-key="tab:d1:1"]'));
  await until(() => run(host) === null, "the control followed the tab");
  assert.ok(q(host, '[data-dt-key="example:d1"]'), "Copy left with it");

  click(q(host, '[data-dt-key="tab:d1:0"]'));
  await until(() => run(host) !== null, "the control came back");
  handle.destroy();
});

// the event

test("pressing it sends a name and a digest - and no Python", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle, events } = await open(host, [example()]);

  click(run(host));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { exampleId: "py", digest: DIGEST, datasetId: "d1" });

  const serialized = JSON.stringify(events[0]);
  for (const fragment of ["import", "xarray", "open_zarr", "s3://"]) {
    assert.equal(serialized.includes(fragment), false, `the event carried ${fragment}`);
  }
  assert.deepEqual(Object.keys(events[0]).sort(), ["datasetId", "digest", "exampleId"]);
  handle.destroy();
});

test("pressing it changes nothing on the page", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle, events } = await open(host, [example()]);
  const before = host.innerHTML;

  click(run(host));
  assert.equal(events.length, 1);
  assert.equal(host.innerHTML, before, "the press re-rendered the tree under the reader");
  handle.destroy();
});

test("a press is re-checked against the data, not trusted from the DOM", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const events: TryPythonEvent[] = [];
  // A consumer whose examples change between renders. The button was drawn when the snippet was
  // runnable; by the time it is pressed the snippet is a template. Nothing must be emitted -
  // which is only true because eligibility is re-derived at press time.
  let runnable = true;
  const catalog = parseDatasetTreeCatalogV1({
    schemaVersion: 1,
    roots: [{ id: "d1", kind: "dataset", name: "tas.zarr" }],
  });
  const handle = mountDatasetTree(host, {
    source: createSnapshotSource(catalog),
    accessExamples: () => [runnable ? example() : example({ code: 'open("<LATER>")' })],
    python: { onTry: (event: TryPythonEvent) => events.push(event) },
  });
  await until(() => rowNames(host).includes("tas.zarr"), "roots");
  click(row(host, "d1"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");
  click(q(host, '[data-dt-key="disclose:d1"]'));
  await until(() => Boolean(run(host)), "control");

  runnable = false;
  click(run(host));
  assert.deepEqual(events, [], "a stale button executed");
  handle.destroy();
});

test("a forged action attribute does not get a press through", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const { handle, events } = await open(host, [
    { id: "cli", label: "CLI", language: "shell", code: "rm -rf /" },
  ]);
  const copy = q<HTMLButtonElement>(host, '[data-dt-key="example:d1"]');
  assert.ok(copy);
  copy.dataset.dtAction = "try-python";
  click(copy);
  assert.deepEqual(events, [], "a relabelled button executed a shell snippet");
  handle.destroy();
});

test("the package still ships no Python of its own", async (t) => {
  t.after(resetDom);
  const host = makeHost();
  const catalog = parseDatasetTreeCatalogV1({
    schemaVersion: 1,
    roots: [
      { id: "d1", kind: "dataset", name: "tas.zarr", path: "s3://archive/reanalysis/tas.zarr" },
    ],
  });
  const handle = mountDatasetTree(host, {
    source: createSnapshotSource(catalog),
    python: { onTry: () => undefined },
  });
  await until(() => rowNames(host).includes("tas.zarr"), "roots");
  click(row(host, "d1"));
  await until(() => Boolean(q(host, ".dataset-tree__details")), "details");
  // Turning the integration on supplies an execution layer, not content. With no examples there
  // is nothing to run, so there is no disclosure and no button - the same as before it existed.
  assert.equal(q(host, ".dataset-tree__access"), null);
  assert.equal(run(host), null);
  handle.destroy();
});
