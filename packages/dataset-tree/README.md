# @freva-org/dataset-tree

A hierarchical browser for climate-data archives. Framework-free, typed, no runtime dependencies,
and no opinion about where the data comes from.

The component renders a tree, loads children lazily, and gets out of the way. Everything specific to
a deployment - the archive, the descriptions, the access examples, whether a modal opens - is
supplied by the host.

```bash
npm install @freva-org/dataset-tree
```

---

## Quick start

```ts
import { mountDatasetTree } from "@freva-org/dataset-tree";
import { createSnapshotSource, parseDatasetTreeCatalogV1 } from "@freva-org/dataset-tree/snapshot";
import "@freva-org/dataset-tree/styles.css";

// `catalog` is an already-loaded JavaScript value. The package never fetches it for you.
const catalog = parseDatasetTreeCatalogV1(catalog);

const tree = mountDatasetTree(document.querySelector("#datasets"), {
  source: createSnapshotSource(catalog),
});

// later
tree.destroy();
```

`mountDatasetTree` appends exactly one element to the host and returns a handle. It registers no
global, defines no custom element, and mounts nothing on import - two calls on one page are two
independent components.

---

## Entry points

| Import                                                             | Contains                                            | Why it is separate                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------ |
| `@freva-org/dataset-tree`                                          | The component and the shared types                  | No adapter, so no network client and no catalog validator          |
| `@freva-org/dataset-tree/snapshot`                                 | `parseDatasetTreeCatalogV1`, `createSnapshotSource` | Build-time catalogs, with no object-store code                     |
| `@freva-org/dataset-tree/s3`                                       | `createS3Source` and its errors                     | Live listing is an explicit choice, with CSP and CORS consequences |
| `@freva-org/dataset-tree/search-index`                             | `parseDatasetTreeSearchIndexV1`                     | Only a consumer that validates an index carries the validator      |
| `@freva-org/dataset-tree/styles.css`                               | The stylesheet                                      | Import it once per page                                            |
| `@freva-org/dataset-tree/dataset-tree-catalog-v1.schema.json`      | The catalog schema                                  | For build tooling and editors                                      |
| `@freva-org/dataset-tree/dataset-tree-search-index-v1.schema.json` | The search-index schema                             | For build tooling and editors                                      |

The core and snapshot entries cannot reach the S3 adapter, directly or transitively, and the core
entry cannot reach either validator. That is checked against the built output by `npm run closure`
and by `tests/import-graph.test.ts`, so it stays true.

---

## Public API

```ts
function mountDatasetTree(host: HTMLElement, options: DatasetTreeOptions): DatasetTreeHandle;

interface DatasetTreeHandle {
  reload(): Promise<void>; // discard everything, load the roots again
  destroy(): void; // abort, unbind, remove; safe to call twice
}

interface DatasetTreeSource {
  loadRoots(context: { signal: AbortSignal }): Promise<readonly DatasetTreeNode[]>;
  loadChildren(
    node: DatasetTreeNode,
    context: { signal: AbortSignal },
  ): Promise<readonly DatasetTreeNode[]>;
}

interface DatasetTreeOptions {
  source: DatasetTreeSource;
  onInspect?: (node: DatasetTreeNode, context: { signal: AbortSignal }) => void | Promise<void>;
  onNavigate?: (node: DatasetTreeNode) => void;
  accessExamples?: (node: DatasetTreeNode) => readonly DatasetAccessExample[];
  python?: DatasetTreePython; // the optional "Try in Python" control; omit for none
  initialExpandedIds?: readonly string[];
  labels?: Partial<DatasetTreeLabels>;
  status?: DatasetTreeStatus; // the footer pill; omit for no footer
  filterDebounceMs?: number; // default 120
}
```

### Access examples, and "Try in Python"

```ts
interface DatasetAccessExample {
  id: string; // stable within the node, never derived from position
  label: string; // the tab
  language: string; // "python", "shell", "yaml", ...
  code: string;
  description?: string;
  executable?: boolean; // opt-in: this is a complete program
  digest?: string; // lowercase hex SHA-256 of the registered source
}

interface DatasetTreePython {
  enabled?: boolean; // default true when the object is present
  onTry: (event: TryPythonEvent) => void;
}

interface TryPythonEvent {
  exampleId: string;
  digest: string;
  datasetId?: string;
}
```

The component ships no examples and runs nothing. Supplying `python` adds a **Try in Python**
button beside **Copy**, on the visible tab only, and pressing it calls `onTry`. Five conditions all
have to hold or the button is absent: `python` is supplied and not `enabled: false`; `language` is
Python; `executable` is `true`; the snippet contains no unresolved placeholder; and `digest` is a
well-formed SHA-256. `tryPythonEligible` is exported so a host can ask the same question without
re-implementing it.

**Placeholders**, exactly. `{{…}}` and `${…}` anywhere. An angle-bracket run - `<dataset>`,
`<YOUR_TOKEN>`, `<path/to/store>` - **inside a string literal**, which is where a placeholder always
is: anywhere else it is a syntax error Python would refuse on its own. Outside a string, only a
shouting run counts (an uppercase letter, a hyphen, a slash), so `count<total>limit` and `a<b>c` stay
eligible. A blank in a docstring counts, because a docstring is a string; that is fail-closed and
deliberate.

**The event carries no code.** The component is drawing the snippet and still sends only a name and
a digest, because this event is designed to be forwarded to a sandboxed interpreter - possibly on
another origin. A message carrying source turns whatever receives it into a remote code execution
surface; a message carrying an identity can only ask for something the receiver already has. The
receiver resolves `exampleId` in its own build-time manifest and checks `digest` against it.

Eligibility is re-derived when the button is pressed, from `accessExamples`, so a stale render or a
relabelled DOM node cannot get a press through.

> **Breaking change.** `id` and `language` became required on `DatasetAccessExample`. Both are
> load-bearing for the rule above: guessing a language from a tab label, or numbering examples by
> position, would mean a catalog edit that reorders two tabs silently changes which code a button
> runs.

### The node model

```ts
interface DatasetTreeNode {
  id: string; // stable, unique, never derived from array position
  kind: "collection" | "directory" | "dataset" | "file";
  name: string;
  title?: string;
  path?: string;
  description?: string;
  hasChildren?: boolean;
  size?: number; // bytes
  mediaType?: string;
  modifiedAt?: string; // ISO-8601
  availability?: "available" | "empty" | "planned" | "restricted" | "unavailable";
  availabilityNote?: string;
  access?: readonly DatasetTreeAccess[];
  link?: { href: string; label?: string };
  metrics?: readonly { label?: string; value: string; style?: "pill" | "plain" }[];
  details?: readonly { label: string; values: readonly { text: string; value?: string }[] }[];
  inspect?: string;
  metadata?: Readonly<Record<string, unknown>>;
}
```

**Identity.** A `collection` or a `directory` is named by `title` when it has one, because a
grouping should read as well as it can. A `dataset` or a `file` is ALWAYS named by `name` - the name
it has in the archive. A tree that shows `Near-surface air temperature` where the store is called
`t2m_hourly.zarr` has stopped being a picture of the archive: the reader cannot match a row to the
path they are about to copy, and two cadences of one variable become two identical rows. The title
is still searched, and still has somewhere to appear.

**What reaches a row.** The chevron, the icon, the name, a collection's `description`, its `link`,
then at the right edge the source's own `metrics` (at most four) and `size`. Nothing else. A media
type and a modification timestamp are in the model and are NOT drawn on rows: two columns of
near-identical text at the expense of the column that differs.

**`metrics`** are compact facts a source asks for - a grid level, a resolution. `pill` (default)
draws a bordered label/value pair; `plain` draws bare micro-text. There is no colour vocabulary: a
metric is a fact, not a status.

**`details`** are the rows of the expanded panel, named and ordered by the source. The panel renders
these and nothing else. It is not a dump of the node, and `metadata` - the deliberately open
object - is carried for consumers and inspectors and is **never rendered**.

**`availability` / `availabilityNote`.** The row draws `availabilityNote` when there is one and a
lowercase fallback word otherwise, in one restrained pill, in the row's own colour, in the case the
source wrote it. `availability` records the state for consumers that reason about it; it decides
nothing about how anything looks. There is no coloured `PLANNED` / `RESTRICTED` taxonomy - one pill
serves every state, which is what keeps "announced" and "empty" from becoming a colour vocabulary.

`empty` means **listed successfully, and holds nothing**, which is a different claim from `planned`
("announced, not browsable") and from an absent value ("nobody has looked, or looking failed"). Only
the first of those three may be shown as an emptiness. A listing that failed keeps its error; it
never becomes an empty collection.

`planned` also makes the node **inert**: no chevron, no `aria-expanded`, no details panel, no copy
or inspect control, and the component never asks a source for its children or its availability. It
is the one state that changes what a row can do rather than only what it says.

**`DatasetTreeSource.probeAvailability(node, context)`** is the optional hook behind that. The
component calls it once per root, with bounded concurrency, and cancels it when the block is
destroyed; a source that implements it is expected to answer with ONE cheap, bounded request. It is
the only request the component makes before a row is expanded. Throwing, or returning `undefined`,
leaves the node exactly as it was - which is what keeps a failed probe from being read as emptiness.

**Errors.** A source may throw an error carrying `datasetTreeErrorCode` and `retryable`
(`DatasetTreeSourceError`); `datasetTreeError()` builds one. The branch renders the error's message
as its own, offers **Retry** only when `retryable` is true, and refuses a second retry while one is
in flight. `cancelled` is not a failure: it returns the branch to its resting state and says
nothing, because it means a reader collapsed a row.

**`inspect`** is where an inspector could open this node. The inspect control appears only when
this is present AND the consumer supplied `onInspect`: either half alone would produce a control
that looks operable and is not.

`hasChildren` decides expandability. Omitted, it is inferred from `kind` - collections and
directories open, datasets and files do not.

---

## Writing a source

A source is two methods. This is the whole contract, and it is how you connect an archive the
shipped adapters do not cover:

```ts
const source: DatasetTreeSource = {
  async loadRoots({ signal }) {
    const response = await fetch("/api/collections", { signal });
    return (await response.json()).map(toNode);
  },
  async loadChildren(node, { signal }) {
    const response = await fetch(`/api/list?path=${encodeURIComponent(node.path!)}`, { signal });
    return (await response.json()).map(toNode);
  },
};
```

Honour `signal`. The view aborts on collapse, reload and destroy, and discards anything a stale call
resolves to, but only an honoured signal actually cancels the request.

Throw on failure. The rejection's `message` is what the user reads in the row, so make it a sentence
worth reading - `HTTP 503 - the catalog service is warming up`, not `Error`.

---

## Snapshot mode

The recommended arrangement for a portal: generate the catalog at build time, ship it as data,
render it with no network at all.

```ts
const catalog = parseDatasetTreeCatalogV1(input);
mountDatasetTree(host, { source: createSnapshotSource(catalog) });
```

`parseDatasetTreeCatalogV1` takes an already-loaded value - not a URL, not a string. Fetching is the
host's job, so a portal can inline the catalog, read it from a build artifact, or receive it from an
API without this package owning a network path it would then have to secure.

Validation is closed and exhaustive. An unrecognised property is an error rather than a silent drop,
every problem is reported in one pass, and each diagnostic names the JSON pointer that failed:

```ts
try {
  parseDatasetTreeCatalogV1(input);
} catch (error) {
  if (error instanceof DatasetTreeCatalogError) {
    for (const { path, code, message } of error.diagnostics) {
      console.error(`${path}: ${message} (${code})`);
      // /roots/2/children/0/kind: `kind` must be one of collection, directory, dataset, file
    }
  }
}
```

Order is preserved exactly as declared, so the same input yields the same tree, in the same order,
with the same identifiers, on every build.

**There is no crawler here.** Nothing in this package generates a snapshot, and nothing runs on
install, on build or on page load. Producing the catalog from a live archive is a separate concern
and deliberately out of scope.

### Examples in the catalog

A node may carry its own code samples, so one document describes an archive completely and a host
does not have to write an `accessExamples` callback to show them:

```json
{
  "id": "cmip6/tas",
  "kind": "dataset",
  "name": "tas.zarr",
  "examples": [
    {
      "id": "python",
      "label": "Python",
      "language": "python",
      "code": "import xarray as xr\n\nds = xr.open_zarr(\"s3://…/tas.zarr\")\nprint(ds)\n",
      "description": "Open the store directly.",
      "executable": true
    },
    { "id": "cli", "label": "CLI", "language": "shell", "code": "s5cmd cp s3://…/tas.zarr ." }
  ]
}
```

Ids are unique **within a node**, not across the catalog: two datasets both offering `python` is
ordinary, and a host that needs a global name pairs the node's id with the example's.

`digest` is deliberately **not** part of the format. A digest a catalog author typed is a digest
nobody computed; it is the build's to fill in, from the source it is looking at, which is what makes
it worth checking at the far end. A host still supplies it through `accessExamples` - see
[Access examples, and "Try in Python"](#access-examples-and-try-in-python).

---

## Live S3 mode

```ts
import { createS3Source } from "@freva-org/dataset-tree/s3";

const source = createS3Source({
  endpoint: "https://objects.example.org",
  roots: [{ name: "Reanalysis", bucket: "archive", prefix: "reanalysis/" }],
  style: "path", // or "virtual-host"
  fetch: window.fetch, // injectable; no polyfill is shipped
});
```

What it does: anonymous `ListObjectsV2` with a `/` delimiter, continuation-token pagination bounded
by `maxPages` (default 25), one request per expansion, `AbortSignal` propagated throughout, and a
per-request timeout. Failures are typed - `forbidden`, `not-found`, `network`, `invalid-response`,
`http`, `aborted` - because an empty directory, a 403 and a blocked CORS preflight are three
different problems with three different fixes.

What it does not do: sign requests, hold credentials, accept arbitrary headers, or discover buckets.
`ListBuckets` is never issued; roots are declared or they do not exist. Retries are bounded (default
one retry, network errors and 5xx only) and never fired at a 4xx, which retrying cannot fix.

**Deployment requirements.** Direct browser access needs the bucket to allow anonymous
`s3:ListBucket` _and_ to answer preflight with CORS headers permitting your origin. Neither is on by
default anywhere. A missing CORS rule surfaces as a `network` failure, because that is genuinely all
a browser is told. For anything authenticated, put a service in front of the bucket and write a
source against it - that is a dozen lines against the interface above.

**Content-Security-Policy.** Snapshot mode needs no `connect-src` entry at all: the component
issues no request. Live mode does - the gateway's origin - so if enabling the tree changes your CSP,
you are in live mode. Making that a distinct, noisy choice in a host's configuration, rather than a
URL pasted into the snapshot path, is worth the trouble: it has consequences outside the artifact.

**What stays the host's decision.** Where a catalog comes from and how it is generated (this package
ships no crawler and runs nothing on install, build or page load); whether a dataset row hands off to
a search UI - `onInspect` is the seam and what it opens is yours; and whether the same catalog has to
produce byte-identical output on two builds. Declared order is preserved and no identifier is derived
from position, so reproducibility should hold - assert it rather than assume it.

---

## Behaviour worth knowing

**A source says whether it is complete, and that decides the presentation.** `DatasetTreeSource`
has an optional `complete` flag. `createSnapshotSource` sets it; a live source does not.

|                        | `complete: true`                               | lazy (the default)               |
| ---------------------- | ---------------------------------------------- | -------------------------------- |
| toolbar                | `Expand all` · `Collapse`                      | `Collapse all` · `Reload`        |
| the filter searches    | the whole catalogue                            | what has been loaded             |
| the "only loaded" hint | absent from the document                       | present, shown while filtering   |
| at mount               | the archive is walked once, no render per node | nothing until a branch is opened |

`Reload` is deliberately absent from the complete presentation: re-reading a catalogue that is baked
into the same document cannot produce different data, so the control's only effect would be to
redraw the page. `handle.reload()` stays available for the source types where it means something.

**Filtering matches name, title and path**, case-insensitively. Over a complete source it reaches
branches nobody has opened; over a lazy one it searches what is in memory and says so. The matching
SUBSTRING is marked, not the whole label - a mark says "this is the text you searched for", not
"this row is a result". Ancestors are kept for context, and clearing the field restores the
expansion the visitor had before. Filtering never fetches. A lazy source can be given an optional
index so that search reaches the whole archive without fetching either - see **Searching, and the
optional index** below.

**Failures are retryable.** A branch that fails shows the reason and a Retry control, and stays
retryable - it is not marked loaded.

**Announcements.** One polite live region reports loading, completion, emptiness and failure. Focus
is preserved across the re-renders those cause, and lands somewhere sensible after a retry.

**Details stay inside the tree.** There is no package-owned modal and no viewport-level surface. If
you want one, `onInspect` is where you open it.

**Copy failure is reported as failure.** Clipboard writes fail in unfocused tabs and under
restrictive permissions policies; the control says `Copy failed` rather than lying.

---

## Searching, and the optional index

**Browsing data and search data are two different things.** Browsing comes from a
`DatasetTreeSource` and always has. The search index is a second, entirely optional input that only
search reads. Supplying one changes what a search covers and nothing else - every request the
component makes, every branch it opens, every byte it loads is unchanged.

**No index is required.** Without one the component behaves exactly as it did before this option
existed:

| Configuration              | What a search covers                          |
| -------------------------- | --------------------------------------------- |
| lazy source, no index      | the nodes already loaded - and it says so     |
| lazy source **plus** index | the whole index, locally, plus what is loaded |
| `complete: true` source    | the whole catalogue, as before                |

**Without an index, a lazy search covers loaded branches only.** That is not a limitation being
apologised for; it is the honest reach of a tree that lists on demand, and the caveat under the
field says it in as many words. The alternative - walking an object store because somebody typed a
letter - is the thing this feature exists to avoid, not a fallback it reaches for.

**With an index, search covers what the index declares, locally.** The file is read into memory
once, normalised once, and scanned per keystroke. `loadChildren()` is never called because of a
search, and no request of any kind is made.

**The package never generates, fetches or refreshes the index.** It defines the format, validates
it, accepts it and searches it. You produce the JSON however you like - by hand for a small
archive, in CI, from an object-store inventory, from a catalogue you already maintain - load it
however you like, and pass the parsed value in. **Freshness is entirely yours.** State
`generatedAt` and the component shows it; omit it and it shows nothing rather than inventing a date.

**Two things worth stating about what an index is not.** Raw S3 prefix listing is not bucket-wide
search: `ListObjectsV2` answers "what is under this prefix", so a search that did not have an index
could only be a recursive crawl of the bucket, per keystroke, from the visitor's browser. And a
`.zarr` store belongs in the index as **one dataset entry**, not as its thousands of chunk objects

- an index of chunks is enormous, slow, and matches nothing anybody searches for.

### With an index

```ts
import { mountDatasetTree } from "@freva-org/dataset-tree";
import { createS3Source } from "@freva-org/dataset-tree/s3";
import { parseDatasetTreeSearchIndexV1 } from "@freva-org/dataset-tree/search-index";

// Loaded by you, however you like - this package makes no request for it.
const searchIndex = parseDatasetTreeSearchIndexV1(alreadyLoadedJson);

mountDatasetTree(host, {
  source: createS3Source(s3Options),
  searchIndex,
});
```

### Without one - the same setup, still supported

```ts
import { mountDatasetTree } from "@freva-org/dataset-tree";
import { createS3Source } from "@freva-org/dataset-tree/s3";

mountDatasetTree(host, {
  source: createS3Source(s3Options),
});
```

### The format

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-02-01T00:00:00Z", // optional; shown to the reader, never invented
  "source": "https://objects.example.org", // optional; text only, never fetched
  "complete": true, // required: does this cover the WHOLE archive?
  "entries": [
    {
      "id": "s3://bucket/reanalysis/surface/tas.zarr", // stable and unique
      "kind": "dataset",
      "name": "tas.zarr",
      "title": "Near-surface air temperature", // optional
      "path": "s3://bucket/reanalysis/surface/tas.zarr", // optional
      "size": 1503238553, // optional
      "modifiedAt": "2026-01-20T08:00:00Z", // optional
      "ancestors": [
        // optional breadcrumb context - NOT loaded tree nodes
        { "id": "s3://bucket/reanalysis", "name": "reanalysis" },
        { "id": "s3://bucket/reanalysis/surface", "name": "surface" },
      ],
    },
  ],
}
```

Flat and compact on purpose: it is not a second copy of the catalogue, it is the projection search
reads. `complete` is required and never defaulted, because it decides what the interface promises -
`true` and the component says the whole indexed archive is searched, `false` and it keeps a caveat.

`parseDatasetTreeSearchIndexV1` is closed, exhaustive and positional, like the catalog parser: an
unrecognised property is an error rather than a silent drop, every problem is reported in one pass,
and each diagnostic carries the JSON pointer of the value that failed. Duplicate ids are refused -
identity is what deduplicates a result against a loaded node.

### How results behave

- **Matching** is over `name`, `title` and `path`, case-insensitively.
- **Ranking** is a fixed ladder, not a score: exact name, name prefix, exact path segment, title,
  then any substring of name or path; ties break on path, then name, then id. Predictable beats
  clever - "why is that fifth?" is a question a search over an archive has to be able to answer.
- **Loaded nodes are searched too**, not instead. An index is a build artefact and the tree is
  live, so a branch listed after the index was generated is still findable. Where both have the
  same id the loaded node wins, because it carries everything the source knows.
- **Results are a separate view.** Nothing from the index is written into the browsing tree: no
  synthetic branches, no ancestors marked as loaded. Clearing the field restores the exact
  expansion state from before the search, because that state was never touched.
- **The list is capped** (`searchResultLimit`, default 200) and the true total is reported. One DOM
  row per match over a large index is a stall on a keystroke.
- **A complete source ignores an index.** It has already promised to answer for the whole archive
  and has already been walked into memory, so the loaded tree is no less complete and is fresher.
  Passing one is not an error - it simply has nothing to add.

---

## Accessibility

Semantic nested lists, not an ARIA tree - the brief permitted either and forbade a partial one, and
lists give Tab order, Enter/Space activation and accessible names from the platform rather than from
a roving-tabindex implementation that has to be perfect to be usable. It also lets a row carry its
own controls, which the tree pattern fights.

Consequence, stated plainly: there is **no arrow-key navigation**, because that belongs to the ARIA
tree pattern and half-implementing it is worse than not having it. Every control is a Tab stop.

Verified in a real browser: axe finds no WCAG 2.1 A/AA violations in light or dark, focus is visible
on every control, the component is fully operable from the keyboard, motion respects
`prefers-reduced-motion`, and nothing overflows at 360px or at 200% text.

---

## Styling

Import `@freva-org/dataset-tree/styles.css` once. Every rule is scoped under `.dataset-tree`; there
is no bare element selector, no global font declaration, no remote asset and no image.

Colour and typography come from the portal's tokens when they exist and from local fallbacks when
they do not:

```css
--dataset-tree-bg: var(--surface, #ffffff);
--dataset-tree-bg-subtle: var(--surface-2, #f4f6f7);
--dataset-tree-text: var(--ink, #172322);
--dataset-tree-muted: var(--muted, #526765);
--dataset-tree-border: var(--line-2, var(--line, #c6d0d0));
--dataset-tree-accent: var(--accent, #009688);
--dataset-tree-accent-ink: var(--accent-ink, #ffffff);
--dataset-tree-focus: var(--accent-warm, var(--warning, #d98324));
--dataset-tree-radius: var(--r-12, 0.75rem);
--dataset-tree-font-mono: var(--font-mono, monospace);
```

Override the `--dataset-tree-*` variables, never the internals - those are the supported surface.
The package adds a few of its own (`--dataset-tree-max-height`, `--dataset-tree-indent`,
`--dataset-tree-code-bg`, `--dataset-tree-danger`, and two derived accents used to keep small accent
text above 4.5:1).

**`--dataset-tree-focus` is deliberately not the accent.** The accent says what a node IS - a
store's icon, its Inspect control, the leading edge of its panel - so outlining the row a reader
just opened in that same colour makes the selection read as one more of those. The selection is
drawn as an inset outline in this second, warmer colour: inset, so it changes no dimension and
moves no neighbour. A consumer sets both variables; the component names no consumer's palette.

### Depth

`--dataset-tree-indent` (default `1.05rem`, `0.7rem` in the compact layout) is **one step, applied
once per level of nesting**, and it is the whole of the depth rule. Each level of children is a box
inside the previous one, so the step compounds and no rule anywhere names a level: a folder, a
dataset and a file at the same depth begin at the same coordinate, and a tree seven deep needs no
more CSS than a tree two deep. The guide rail is derived from the same token and drawn at its
midpoint, so it runs in the gutter the step opens rather than through either column.

Every row also carries `aria-level` on its `<li>`, from the same number the indentation uses - so
the depth a screen reader is told cannot drift from the depth a reader is shown. It is `aria-level`
on a `listitem`, not a `role="treeitem"`: this component is nested lists of native buttons rather
than an ARIA tree, and it stays that way.

Dark mode needs nothing from you if your tokens flip under `:root[data-theme="dark"]`. The package
also redefines its own _fallbacks_ for dark, so it still looks right mounted somewhere with no token
vocabulary at all.

The compact layout is driven by a container query on the component itself, so a 320px sidebar gets
it on a large monitor, which a viewport query would get backwards.

---

## Playground

```bash
npm run build -w @freva-org/dataset-tree
npm run playground -w @freva-org/dataset-tree
# http://127.0.0.1:4178/  (PORT=5000 to change it)
```

Two independent instances driven from an in-memory catalog. Nothing on the page makes a network
request: the wide tree wraps the snapshot source in an artificial delay and a scripted failure, so
the loading, error and retry states are reachable by hand. Buttons toggle dark mode, remove the
host's tokens entirely, reload one tree and destroy the other.

---

## Development

```bash
npm run build      -w @freva-org/dataset-tree   # tsc + copy the stylesheet into dist/
npm run typecheck  -w @freva-org/dataset-tree
npm test           -w @freva-org/dataset-tree   # 123 network-free tests
npm run test:browser    -w @freva-org/dataset-tree   # 15 Playwright checks, incl. axe
npm run test:packaging  -w @freva-org/dataset-tree   # pack, install elsewhere, use it
npm run closure    -w @freva-org/dataset-tree   # entry separability, against dist/
node scripts/provenance-scan.mjs                # see CLEANROOM.md
```

`BROWSER_STRICT=1` turns "no browser available" from a skip into a failure.

See `CLEANROOM.md`, in the repository, for the provenance of the design and the one licensing
question that is still open.
