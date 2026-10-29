# @freva-org/jupyterlite-freva-kernel

## 2610.2.1

### Patch Changes

- 02ab040: Script-tag matching closes on `</script ...>` in any case, as a browser does. Workspace session ids always come from `crypto.getRandomValues`.
- a4570b3: File checks and the reads or writes they guard go through one descriptor or one exclusive create, so they see the same file. The playground frame only loads an http(s) origin, and the worker ignores messages from a foreign origin. A callback spends its login transaction once, before reading the response. Copied ClimateClaw replies strip tags and comments until none are left.
- Updated dependencies [02ab040]
- Updated dependencies [a4570b3]
- Updated dependencies [cad8488]
  - @freva-org/browser-python@2610.1.1

## 2610.2.0

### Minor Changes

- 6d9a1ea: A `siteWheels` setting: wheels the site pins and serves itself, installed in every interpreter after its add-ons and verified against their SHA-256 first.

### Patch Changes

- Updated dependencies [fa3524b]
  - @freva-org/browser-python@2610.1.0

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
