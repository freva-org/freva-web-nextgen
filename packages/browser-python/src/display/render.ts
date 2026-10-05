// render.ts - one MIME bundle to one DOM element, safely. Shared by the console and the notebook
// kernel, so a DataFrame looks the same in both and is sanitised by the same code.

import { renderNeedsJspi, type NoticeCardOptions } from "../console/notice-card.js";
import { NOTICE_MIME, type BundleMetadata, type BundleMime, type MimeBundle } from "../types.js";
import { sanitizeHtml, sanitizeSvg } from "./sanitize.js";
import { DISPLAY_STYLES } from "./styles.generated.js";

/** Where a renderer builds, and how it hands back the Blob URLs it made for later revocation. */
export interface RenderContext {
  document: Document;
  /** Called with every Blob URL created; the caller revokes them on clear, prune and unmount. */
  track(url: string): void;
  /** For the notice card: see `NoticeCardOptions`. */
  notice?: Omit<NoticeCardOptions, "document">;
}

/** Decode budget for one PNG: neither side over this, and not more pixels than the next. */
export const PNG_MAX_SIDE = 16_384;
export const PNG_MAX_PIXELS = 40_000_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk, read BEFORE anything decodes the image. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12) !== 0x49484452) return null; // "IHDR"
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function base64Bytes(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function element(doc: Document, tag: string, className: string): HTMLElement {
  const node = doc.createElement(tag);
  node.className = className;
  return node;
}

function image(ctx: RenderContext, blob: Blob, alt: string, className: string): HTMLElement {
  const url = URL.createObjectURL(blob);
  ctx.track(url);
  const wrap = element(ctx.document, "div", `fv-output ${className}`);
  const img = ctx.document.createElement("img");
  img.src = url;
  img.alt = alt;
  img.decoding = "async";
  wrap.append(img);
  return wrap;
}

/** A PNG, within the pixel budget, as a Blob URL. Null when it is not a PNG or is too large. */
export function renderPng(
  data: string,
  ctx: RenderContext,
  meta?: { width?: number; height?: number },
): HTMLElement | null {
  const bytes = base64Bytes(data);
  const size = bytes && pngDimensions(bytes);
  if (!bytes || !size) return null;
  if (
    size.width < 1 ||
    size.height < 1 ||
    size.width > PNG_MAX_SIDE ||
    size.height > PNG_MAX_SIDE ||
    size.width * size.height > PNG_MAX_PIXELS
  ) {
    return text(
      ctx.document,
      `[image not shown: ${size.width}×${size.height} pixels is over the display budget]`,
    );
  }
  const wrap = image(
    ctx,
    new Blob([bytes as BlobPart], { type: "image/png" }),
    "Image output",
    "fv-png",
  );
  const img = wrap.firstElementChild as HTMLImageElement;
  if (meta?.width) img.width = Math.round(meta.width);
  if (meta?.height) img.height = Math.round(meta.height);
  return wrap;
}

/** An SVG, reduced to its safe subset and then shown as an IMAGE, where nothing runs or loads. */
export function renderSvg(data: string, ctx: RenderContext): HTMLElement | null {
  const clean = sanitizeSvg(data, ctx.document);
  if (!clean) return null;
  return image(ctx, new Blob([clean], { type: "image/svg+xml" }), "SVG output", "fv-svg");
}

/** HTML, sanitised and namespaced. Styled only by `display.css`: see `adoptDisplayStyles`. */
export function renderHtml(data: string, ctx: RenderContext): HTMLElement {
  const wrap = element(ctx.document, "div", "fv-output fv-html");
  wrap.append(sanitizeHtml(data, ctx.document));
  return wrap;
}

/** The typed notice, as the console's card; the plain text when it cannot be read. */
export function renderNotice(data: string, ctx: RenderContext): HTMLElement | null {
  let parsed: { notice?: unknown; text?: unknown };
  try {
    parsed = JSON.parse(data) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed.notice !== "needs-jspi" || typeof parsed.text !== "string") return null;
  const wrap = element(ctx.document, "div", "fv-output fv-notice-host");
  wrap.append(
    renderNeedsJspi(
      { notice: "needs-jspi", origin: "error", text: parsed.text },
      { ...ctx.notice, document: ctx.document },
    ),
  );
  return wrap;
}

function text(doc: Document, value: string): HTMLElement {
  const pre = element(doc, "pre", "fv-output fv-text");
  pre.textContent = value;
  return pre;
}

/** Richest first. `text/plain` is always present and always renderable. */
const PREFERENCE: readonly BundleMime[] = [NOTICE_MIME, "text/html", "image/svg+xml", "image/png"];

/**
 * Render a bundle by the richest representation that renders, falling back towards plain text:
 * a PNG over budget or an SVG that does not survive sanitising still shows something.
 */
export function renderBundle(
  data: MimeBundle,
  metadata: BundleMetadata | undefined,
  ctx: RenderContext,
): HTMLElement {
  for (const mime of PREFERENCE) {
    const value = data[mime];
    if (typeof value !== "string") continue;
    let node: HTMLElement | null = null;
    try {
      node =
        mime === NOTICE_MIME
          ? renderNotice(value, ctx)
          : mime === "text/html"
            ? renderHtml(value, ctx)
            : mime === "image/svg+xml"
              ? renderSvg(value, ctx)
              : renderPng(value, ctx, metadata?.["image/png"]);
    } catch {
      node = null; // e.g. a document that cannot sanitise: the next representation down
    }
    if (node) return node;
  }
  return text(ctx.document, data["text/plain"]);
}

const adopted = new WeakMap<Document | ShadowRoot, Set<string>>();

/**
 * Give a document or shadow root a stylesheet, once. A constructed stylesheet, so it needs no
 * `style-src 'unsafe-inline'`. A no-op where constructed sheets do not exist.
 */
export function adoptStyles(root: Node | null | undefined, css: string): void {
  const target = root as (Document | ShadowRoot) & { adoptedStyleSheets?: CSSStyleSheet[] };
  if (!target || !("adoptedStyleSheets" in target)) return;
  const done = adopted.get(target) ?? new Set<string>();
  if (done.has(css)) return;
  const view = (target as Document).defaultView ?? target.ownerDocument?.defaultView;
  if (!view || typeof view.CSSStyleSheet !== "function") return;
  try {
    const sheet = new view.CSSStyleSheet();
    sheet.replaceSync(css);
    target.adoptedStyleSheets = [...(target.adoptedStyleSheets ?? []), sheet];
    done.add(css);
    adopted.set(target, done);
  } catch {
    // Unstyled output is still correct output.
  }
}

/** The rich-output rules (`display.css`). The notice card's rules are `NOTICE_CARD_STYLES`. */
export function adoptDisplayStyles(root: Node | null | undefined): void {
  adoptStyles(root, DISPLAY_STYLES);
}
