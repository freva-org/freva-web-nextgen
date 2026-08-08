# @freva-org/databrowser

## 2608.1.0

### Minor Changes

- 8f5da92: New compact data picker, at the `@freva-org/databrowser/picker` subpath export.
  - Facet values can be excluded as well as included, and exclusions survive URLs and copied commands.
  - The terminal ships separately as `@freva-org/freva-client-terminal`.
  - Selections are capped at 25 files (10 for Aggregate), and remote files open by direct link.
  - Layout, theming and accessibility pass over the overview, results list and export menus.

## 2608.0.0

_Adopts CalVer (`YYMM.MINOR.PATCH`)._

### Major Changes

- Initial release. Framework-free, strictly-typed, zero-runtime-dependency climate-data browser for the `freva-nextgen` REST API. Single `mountDataBrowser` entry point, self-contained styles, and near-total teardown via the returned handle.
