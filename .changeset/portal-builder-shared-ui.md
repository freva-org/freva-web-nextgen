---
"@freva-org/portal-builder": patch
---

- Pages draw the Python window, code figures, notebook sheet, dataset-tree block and Cosmos backdrop from `@freva-org/browser-python`, `@freva-org/dataset-tree`, `@freva-org/freva-client-terminal` and `@freva-org/cosmos-backdrop`, and `prepare-notebook` uses the ClimateClaw and data-panel `/site` helpers.
- After a tree recipe ran on a store, "Open as notebook" opens the notebook on that store when its data panel holds that tree, and the file list otherwise.
- A closed notebook sheet never takes the keyboard.
