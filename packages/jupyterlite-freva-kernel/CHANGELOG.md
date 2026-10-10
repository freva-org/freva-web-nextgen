# @freva-org/jupyterlite-freva-kernel

## 2610.1.1

### Patch Changes

- c170253: Escape in a framed notebook, when it has no use for it, closes the page's notebook sheet.

## 2610.1.0

### Minor Changes

- 0c79f88: `prepareNotebookSite({ metaPolicy })`, `portalBaseUrl` and theme sync, for a notebook published inside the portal's own artifact.

  Prepare every notebook site again (`prepare-notebook`): portal-builder refuses one prepared by an earlier revision (`FP1605`). From a source checkout, run `npm run build:labextensions` first.

## 2610.0.0

### Major Changes

- ffed06a: New package: the Freva Python kernel for JupyterLite, built on browser-python.

### Patch Changes

- Updated dependencies [647c735]
- Updated dependencies [038abf9]
  - @freva-org/browser-python@2610.0.0
