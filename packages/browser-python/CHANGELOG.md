# @freva-org/browser-python

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
