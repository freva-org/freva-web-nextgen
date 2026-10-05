// Every output a notebook shows of the kinds Python can forge goes through
// `@freva-org/browser-python/display`: HTML is sanitised and namespaced, SVG is sanitised and shown
// as an image, PNG is checked against a pixel budget, and the notice type draws the card. These
// factories REPLACE JupyterLab's own for the same MIME types, whose trust model ("output produced
// in this session is trusted") does not hold when the session runs visitor code.

import {
  NOTICE_MIME,
  renderHtml,
  renderNotice,
  renderPng,
  renderSvg,
  type RenderContext,
} from "@freva-org/browser-python/display";
import type { IRenderMime } from "@jupyterlab/rendermime-interfaces";
import { Widget } from "@lumino/widgets";

export const RENDERED_MIMES = ["text/html", "image/svg+xml", "image/png", NOTICE_MIME] as const;

/** One output. Owns the Blob URLs it made and revokes them when it is cleared or disposed. */
export class FrevaOutput extends Widget implements IRenderMime.IRenderer {
  readonly #mime: string;
  #urls: string[] = [];

  constructor(options: IRenderMime.IRendererOptions) {
    super();
    this.#mime = options.mimeType;
    this.addClass("fv-jp-output");
  }

  async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    this.#revoke();
    this.node.textContent = "";
    const value = model.data[this.#mime];
    const fallback = model.data["text/plain"];
    const ctx: RenderContext = {
      document: this.node.ownerDocument,
      track: (url: string) => this.#urls.push(url),
    };
    let node: HTMLElement | null = null;
    if (typeof value === "string") {
      try {
        if (this.#mime === "text/html") node = renderHtml(value, ctx);
        else if (this.#mime === "image/svg+xml") node = renderSvg(value, ctx);
        else if (this.#mime === "image/png") {
          const meta = model.metadata[this.#mime] as
            | { width?: number; height?: number }
            | undefined;
          node = renderPng(value, ctx, meta && typeof meta === "object" ? meta : undefined);
        } else node = renderNotice(value, ctx);
      } catch {
        node = null;
      }
    }
    if (!node) {
      const pre = this.node.ownerDocument.createElement("pre");
      pre.textContent =
        typeof fallback === "string" ? fallback : `[${this.#mime} output not shown]`;
      node = pre;
    }
    this.node.append(node);
  }

  dispose(): void {
    this.#revoke();
    super.dispose();
  }

  #revoke(): void {
    for (const url of this.#urls) URL.revokeObjectURL(url);
    this.#urls = [];
  }
}

/** The factory: rank 0 so these win over every other renderer for the same types. */
export const rendererFactory: IRenderMime.IRendererFactory = {
  safe: true,
  mimeTypes: [...RENDERED_MIMES],
  defaultRank: 0,
  createRenderer: (options) => new FrevaOutput(options),
};
