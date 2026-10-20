# @freva-org/browser-python

## 2610.1.0

### Minor Changes

- fa3524b: `/ui` entry points for any page: the Python window and code figures (`/ui`, `/ui/bridge`, `/ui/chooser`, `/ui/code`, `/ui/copy`, `/ui/local`, `/ui/framed`, `/ui/code.css`, `/ui/code-figure.html`) and the notebook sheet (`/ui/notebook`, `/ui/notebook/sheet`, `/ui/notebook/embed`, `/ui/notebook.css`).
  - `siteWheels: [{ url, sha256 }]` installs wheels a site pins and serves itself, each verified before any is installed and reported in `ready.siteWheels`; the console takes it as a property.
  - `registerPythonBlock` returns the block's own `tryPython`, so on a page with several trees a press is bound by the tree that was pressed.
  - The console no longer traps the keyboard: Escape with nothing open releases it so Tab moves on, and focus moved to a host control stays there.

### Patch Changes

- Updated dependencies [72c8c0c]
  - @freva-org/freva-client-terminal@2610.0.0

## 2610.0.0

### Major Changes

- 647c735: `executeCell()`, and the `/display` and `/session` entries, for the notebook kernel and session choices

### Patch Changes

- 038abf9: When no live Python slot is free, the message counts the page's slots

## 2609.1.0

### Minor Changes

- f88f963: A browser without WebAssembly JSPI gets advice instead of a red line

## 2609.0.4

### Patch Changes

- e8e0509: up and down move between the lines of a multi-line block in the console before they reach history, the way IPython does

## 2609.0.3

### Patch Changes

- 9fbd88f: The console's `runExample({ title, source, comment? })` resolves to `{ raised }`, saying whether the program ended with an uncaught exception.

## 2609.0.2

### Patch Changes

- 8fff77a: browse-python: instantiate side modules synchronously while packages load, working around a WebKit stall where WebAssembly.instantiate never settles

## 2609.0.1

### Patch Changes

- 8f81889: fix(browse-python): prepare-addons retries temporary download failures, hold .addons/ as cache

## 2609.0.0

### Major Changes

- d9da325: New package: Python in the browser, framework-independent
