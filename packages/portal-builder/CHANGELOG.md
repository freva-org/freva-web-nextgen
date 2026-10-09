# @freva-org/portal-builder

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
