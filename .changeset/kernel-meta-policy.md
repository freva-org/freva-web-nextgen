---
"@freva-org/jupyterlite-freva-kernel": minor
---

`prepareNotebookSite({ metaPolicy })`, `portalBaseUrl` and theme sync, for a notebook published inside the portal's own artifact.

Prepare every notebook site again (`prepare-notebook`): portal-builder refuses one prepared by an earlier revision (`FP1605`). From a source checkout, run `npm run build:labextensions` first.
