import { notebookRequestFor } from "./notebook-url.js";

export function initNotebookLinks(href: string, doc: Document = document): void {
  const win = doc.defaultView;
  if (!win) return;
  const notebook = new URL(href, doc.baseURI);
  if (notebook.origin !== win.location.origin) return;
  doc.addEventListener("click", (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.("a[href]");
    if (!(link instanceof win.HTMLAnchorElement)) return;
    if (link.target && link.target !== "_self") return;
    if (link.closest("[data-portal-notebook-sheet]")) return;
    const request = notebookRequestFor(link.href, notebook.href);
    if (!request) return;
    event.preventDefault();
    const { panel, ...wanted } = request;
    void import("./notebook-sheet.js").then(({ openNotebook }) =>
      openNotebook({ href, frame: true, ...(panel ? { panel } : {}) }, wanted, doc),
    );
  });
}
