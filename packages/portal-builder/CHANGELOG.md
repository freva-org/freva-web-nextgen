# @freva-org/portal-builder

## 2612.2.0

### Minor Changes

- cad8488: Security updates: `browser-python` depends on DOMPurify 3.4.17. `data-inspector` builds with Vite 8. `portal-builder`'s `host-check` now verifies the deployed Content-Security-Policy (`FP1607`); a host that cannot send headers, such as GitHub Pages, needs the new `--allow-missing-csp`.

### Patch Changes

- 3577e8a: Code scanning fixes. `databrowser` no longer breaks on a link or query whose facet key is an `Object.prototype` name (`__proto__`, `constructor`, `toString`, ...). Trailing slashes, newlines and spaces are trimmed in linear time instead of with backtracking regular expressions.
- 02ab040: Script-tag matching closes on `</script ...>` in any case, as a browser does. Workspace session ids always come from `crypto.getRandomValues`.
- a4570b3: File checks and the reads or writes they guard go through one descriptor or one exclusive create, so they see the same file. The playground frame only loads an http(s) origin, and the worker ignores messages from a foreign origin. A callback spends its login transaction once, before reading the response. Copied ClimateClaw replies strip tags and comments until none are left.
- Updated dependencies [3577e8a]
- Updated dependencies [02ab040]
- Updated dependencies [a4570b3]
- Updated dependencies [cad8488]
  - @freva-org/databrowser@2610.0.1
  - @freva-org/jupyterlite-climateclaw@2610.1.1
  - @freva-org/data-inspector@2610.1.1
  - @freva-org/ts-oidc-auth-client@2608.0.2
  - @freva-org/jupyterlite-freva-data@2610.2.1
  - @freva-org/browser-python@2610.1.1
  - @freva-org/jupyterlite-freva-kernel@2610.2.1

## 2612.1.0

### Patch Changes

- 56328d5: - Pages draw the Python window, code figures, notebook sheet, dataset-tree block and Cosmos backdrop from `@freva-org/browser-python`, `@freva-org/dataset-tree`, `@freva-org/freva-client-terminal` and `@freva-org/cosmos-backdrop`, and `prepare-notebook` uses the ClimateClaw and data-panel `/site` helpers.
  - After a tree recipe ran on a store, "Open as notebook" opens the notebook on that store when its data panel holds that tree, and the file list otherwise.
  - A closed notebook sheet never takes the keyboard.
- Updated dependencies [fa3524b]
- Updated dependencies [48c3a15]
- Updated dependencies [0b4e35c]
- Updated dependencies [72c8c0c]
- Updated dependencies [712afd6]
- Updated dependencies [89d1c72]
- Updated dependencies [6d9a1ea]
  - @freva-org/browser-python@2610.1.0
  - @freva-org/cosmos-backdrop@2610.1.0
  - @freva-org/dataset-tree@2610.2.0
  - @freva-org/freva-client-terminal@2610.0.0
  - @freva-org/jupyterlite-climateclaw@2610.1.0
  - @freva-org/jupyterlite-freva-data@2610.2.0
  - @freva-org/jupyterlite-freva-kernel@2610.2.0
  - @freva-org/databrowser@2610.0.0

## 2612.0.1

### Patch Changes

- 3744167: A documentation page can offer its example notebook (`seedNotebooks` entry `{ path, page }`): _Open in notebook_ beside the title and again at the page end
- Updated dependencies [21ee06c]
  - @freva-org/jupyterlite-freva-data@2610.1.1

## 2612.0.0

### Minor Changes

- 6d08060: A **Notebook** button on every dataset tree; a same-origin notebook opens in a sheet, one or two cards filling its row.

### Patch Changes

- Updated dependencies [a4c7c65]
- Updated dependencies [50de27b]
- Updated dependencies [053da9c]
- Updated dependencies [c170253]
- Updated dependencies [701566e]
  - @freva-org/data-inspector@2610.1.0
  - @freva-org/dataset-tree@2610.1.0
  - @freva-org/jupyterlite-freva-data@2610.1.0
  - @freva-org/jupyterlite-freva-kernel@2610.1.1
  - @freva-org/jupyterlite-climateclaw@2610.0.1
  - @freva-org/databrowser@2609.1.4

## 2611.0.0

### Minor Changes

- 4b2967d: The notebook can be published inside the portal's own artifact, for a host such as GitHub Pages: `notebook.deployment: same-origin`, `notebook.metaPolicy`, `PORTAL_BASE_URL`.

### Patch Changes

- Updated dependencies [68541db]
- Updated dependencies [0c79f88]
  - @freva-org/jupyterlite-freva-data@2610.0.1
  - @freva-org/jupyterlite-freva-kernel@2610.1.0

## 2610.0.0

### Major Changes

- 35ffa4b: Customise a portal from its own repository, typed header, footer, navigation, font and scale and landing layout options

### Patch Changes

- Updated dependencies [643fd97]
- Updated dependencies [647c735]
- Updated dependencies [c33097c]
- Updated dependencies [e7ef9b6]
- Updated dependencies [ffed06a]
- Updated dependencies [9ffa6a0]
- Updated dependencies [038abf9]
  - @freva-org/data-inspector@2610.0.0
  - @freva-org/browser-python@2610.0.0
  - @freva-org/jupyterlite-climateclaw@2610.0.0
  - @freva-org/jupyterlite-freva-data@2610.0.0
  - @freva-org/jupyterlite-freva-kernel@2610.0.0
  - @freva-org/freva-badge@2610.0.0
  - @freva-org/databrowser@2609.1.3

## 2609.2.0

### Minor Changes

- 33b6ed4: `dataset-tree` block can take a search index

### Patch Changes

- Updated dependencies [4267935]
- Updated dependencies [f88f963]
  - @freva-org/dataset-tree@2610.0.1
  - @freva-org/browser-python@2609.1.0

## 2609.1.1

### Patch Changes

- ca14d7f: fix the OS detection on browser-python: `pythonPlayground.terminal.osControls: auto` detects the platform the same way as the Data Browser's terminal

## 2609.1.0

### Minor Changes

- b8940dc: Runnable snippets show Copy and Try in Python at all times and can be editable, add per-mode page colours, add sign-in

## 2609.0.6

### Patch Changes

- Updated dependencies [f4c59b4]
- Updated dependencies [e8e0509]
  - @freva-org/databrowser@2609.1.2
  - @freva-org/browser-python@2609.0.4

## 2609.0.5

### Patch Changes

- d682664: Remove size budget from portal builder
- Updated dependencies [9fbd88f]
  - @freva-org/browser-python@2609.0.3

## 2609.0.4

### Patch Changes

- Updated dependencies [8b433e3]
  - @freva-org/freva-client-terminal@2609.0.1
  - @freva-org/databrowser@2609.1.1

## 2609.0.3

### Patch Changes

- Updated dependencies [addc8ca]
  - @freva-org/databrowser@2609.1.0

## 2609.0.2

### Patch Changes

- Updated dependencies [aed46e3]
  - @freva-org/data-inspector@2609.1.0
  - @freva-org/databrowser@2609.0.3

## 2609.0.1

### Patch Changes

- Updated dependencies [a89f225]
  - @freva-org/ts-oidc-auth-client@2608.0.1

## 2609.0.0

### Major Changes

- d17119a: New package: builds a static Freva portal from a `portal.yaml` and a tree of content.
