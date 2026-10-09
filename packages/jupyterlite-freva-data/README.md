# @freva-org/jupyterlite-freva-data

A site's data in JupyterLite and JupyterLab ≥ 4.4: a left panel, "<site> data", hosting the same
[`@freva-org/dataset-tree`](../dataset-tree) a Freva portal shows on its landing page - its
build-time catalogue, or its live S3 roots with the published search index - and actions that take
a dataset into a notebook.

Published on npm and on PyPI as `jupyterlite-freva-data` (the same prebuilt extension). It needs
nothing else; with [`@freva-org/jupyterlite-climateclaw`](../jupyterlite-climateclaw) installed it
also offers **Ask ClimateClaw** and uses the Freva sign-in for protected stores.

## Actions

Every action is a command, run on the selected dataset from the card above the tree, a row's
context menu (a right-click selects its row first) or Ctrl/Cmd+Enter on a row (the primary action).
A click selects its row (and opens or closes it in the tree); clicks never run an action.

The card keeps one height, so selecting a row never moves the tree under the pointer. It names the
selected dataset (its kind, and its path in up to two lines, whole in the tooltip), or says how to
start, and holds **Open notebook** (the primary
action, `defaultAction`) and tiles with short labels: Insert, Inspect, Globe, Ask, Copy URL. A
disabled tile (all of them, before anything is selected) says why in its tooltip; one that ran
says so for a moment ("Copied", "Opened"). In a
narrow panel the tiles give way to a **More actions** menu beside the primary button. A tip under
the card (shown until the context menu is first used in this browser, gone from the next load)
says that a right-click and
dragging onto a notebook work too. Copy code is in the context menu only.

A request to open a dataset (`lab/index.html?dataset=<id>`, or a `freva-data:open-dataset` message
from a same-origin framing page, which hears `freva-data-ready` first) selects it and runs **Open
notebook** once, then drops the parameter from the address so a reload does not repeat it. Only an
id found in the panel's own tree is opened (by its branches, or anywhere in a complete snapshot);
any other is refused with a notice. `?panel=data` (or `freva-data:show-panel`) shows the panel.
Both widen the left side bar to about a third of the window, as ClimateClaw does, never narrowing
it.

In a notebook cell, a registered example's closing `print(ds)` becomes `ds`, so Jupyter shows the
dataset's rich view; the example itself keeps its `print`, which a script needs. Inspect and View
on globe show `<data-inspector>` `embedded` in their tab (no dialog of its own) and open on its
metadata or its 3D viewer (`view`).

| Command                       | What it does                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `freva-data:open-in-notebook` | A new notebook on the site's kernel: a Markdown header naming the dataset, then its snippets.                   |
| `freva-data:insert`           | The same snippets below the active cell (also by dragging the dataset onto a notebook).                         |
| `freva-data:inspect`          | The store's metadata in a main-area `<data-inspector>` tab, read in the browser; its 3D viewer with `gridlook`. |
| `freva-data:ask-climateclaw`  | `climateclaw:ask` with a question and the dataset's URL and metadata. Only with ClimateClaw.                    |
| `freva-data:copy-url`         | The store's HTTPS address.                                                                                      |
| `freva-data:copy-code`        | The snippets' code.                                                                                             |
| `freva-data:view-on-globe`    | With `gridlook`: Inspect, straight to GridLook's globe (or why the store cannot be shown). Disabled otherwise.  |

**Only registered, runnable Python goes into a notebook**: an example must be Python, marked
executable, free of placeholders (the dataset tree's own "Try in Python" rule) and its bytes must
hash to the SHA-256 the site's build registered. For a live archive the registered thing is the
recipe template, and the store fills its one hole only after it is validated against the configured
endpoint and roots (no quote, backslash, `..` or other bucket).

Launcher cards, in the site's category: **New <site> notebook**, **Browse data**, **Example
notebooks** (with seed notebooks; see below) and **Ask ClimateClaw** (with ClimateClaw).

## Configuration

Settings of `@freva-org/jupyterlite-freva-data:plugin`, set through settings overrides:

| Setting         | Meaning                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `siteName`      | "<site> data", "New <site> notebook", the launcher category.                 |
| `title`         | The panel's name (default "<site> data").                                    |
| `iconSvg`       | An SVG document for the panel and the cards.                                 |
| `dataUrl`       | The panel data file, relative to the site root (or an absolute http(s) URL). |
| `dataSha256`    | Its SHA-256; a file that does not match is refused.                          |
| `kernelName`    | The kernel new notebooks use (default `freva-python`).                       |
| `defaultAction` | The primary action: the card's labelled button and Ctrl/Cmd+Enter.           |
| `seedNotebooks` | `[{ path, title }]`: the site's example notebooks.                           |
| `startNotebook` | One of them, opened when the Lab starts: the visitor's copy, made once.      |
| `launcher`      | `{ newNotebook, browse, examples, ask }`: which cards to show.               |
| `gridlook`      | GridLook's 3D globe in Inspect and View on globe (default false).            |

**Example notebooks** (the Launcher card and the palette) open a gallery: a card per example with
its own figure (the first picture among its saved outputs), its first paragraph and its number of
steps, a search, "Start here" on the start notebook and "Your copy" where the visitor has one.
Each notebook is read when the gallery first shows it, three at a time, and remembered for the
session. A card opens the visitor's own copy, made from the published example the first time (the
published one stays as it is) and theirs after that. A copy is known by the example it names in its
metadata (`freva_data.copy_of`), so it stays theirs when they rename or move it; if a notebook
cannot be read while looking, nothing new is made.

**GridLook** is a third-party viewer, loaded from `https://gridlook.pages.dev` into a sandboxed
frame without a referrer; the notebook's policy must allow it in `frame-src`. WebKit sends the
notebook's origin to the frame despite its `referrerpolicy`, so serve the notebook with
`Referrer-Policy: no-referrer`, as portal-builder's playground deployment does. It fetches the store
itself and never gets a token, so only stores readable without one are shown: for a protected
store the inspector keeps the tab disabled and says why.

The panel data file (`PanelData`, `@freva-org/jupyterlite-freva-data/panel-data`) carries the tree's
source - `mode: "snapshot"` with the catalogue, or `mode: "s3"` with the S3 configuration and the
search index's path - the registered examples (`datasetId`, `exampleId`, `sha256`) and the recipes
(`template`, `sha256`, `runnable`). `@freva-org/portal-builder prepare-notebook` writes it from a
portal's dataset-tree block.

## Development

```bash
npm run build && npm run build:labextension
npm test
```

The browser suite runs in `@freva-org/jupyterlite-climateclaw` (`browser-tests/climateclaw.mjs`),
on one Lab site with both extensions.
