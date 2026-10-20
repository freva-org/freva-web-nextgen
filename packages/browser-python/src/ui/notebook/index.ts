/**
 * `@freva-org/browser-python/ui/notebook` - links into a separately deployed JupyterLite notebook.
 *
 * `initNotebookLinks` turns any same-origin link to the notebook into the notebook sheet - the
 * notebook in an overlay over the page, which keeps its session when it is closed and opened
 * again - and loads the sheet itself only on the first such click. `/ui/notebook/sheet` is the
 * sheet, for a control that opens it directly; `/ui/notebook/embed` frames it in a page section.
 * Nothing here imports JupyterLab: the notebook runs in its own frame, from its own deployment.
 */

export { initNotebookLinks } from "./notebook-links.js";
export { notebookRequestFor, notebookUrl } from "./notebook-url.js";
export { JUPYTER_LOGO, JUPYTER_LOGO_DARK, jupyterLogo } from "./jupyter-logo.js";
export type { NotebookRequest, NotebookTarget } from "./notebook-sheet.js";
