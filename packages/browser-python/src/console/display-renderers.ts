/**
 * display-renderers.ts - rich output, as controlled DOM. A registry rather than a switch, so a
 * safe renderer can be added later without editing the console. What is absent is as deliberate
 * as what is here: no `text/html` and no SVG renderer, because both carry script and the payload
 * was authored by whatever Python the visitor typed. The engine refuses those MIME types at the
 * worker boundary as well - it guards the protocol, this guards the DOM.
 */

import type { ConsoleDisplayOutput, DisplayRenderer } from "./console-types.js";

const renderers = new Map<string, DisplayRenderer>();

/**
 * Register a renderer for one MIME type. Replaces any previous renderer for it.
 *
 * This decides HOW a payload is drawn, not WHICH payloads arrive: the set that arrives is
 * `DISPLAY_MIMES` in `protocol.ts`, enforced in the worker before the message is posted and again
 * in the engine on arrival, so a renderer for a MIME type outside that list is never called.
 * Widening what is carried is a protocol change - which is why `text/html` and `image/svg+xml`
 * are not on the list.
 */
export function registerDisplayRenderer(mime: string, renderer: DisplayRenderer): void {
  renderers.set(mime, renderer);
}

export function displayRendererFor(mime: string): DisplayRenderer | undefined {
  return renderers.get(mime);
}

export function registeredDisplayMimes(): string[] {
  return [...renderers.keys()].sort();
}

/** `atob` for base64 -> bytes. Returns null for anything that is not decodable. */
export function decodeBase64(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function looksLikePng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

/**
 * A Matplotlib figure. The bytes are checked against the PNG signature before an element is built:
 * the engine validated the DECLARED mime and encoding, but a payload can claim `image/png` and
 * carry anything, and an `<img>` handed a mislabelled blob renders a broken icon with no
 * explanation. A blob URL, not a `data:` URI, because a multi-megabyte figure as a data URI is an
 * attribute string of the same size held in the DOM for the life of the transcript; `track()`
 * hands the URL to the caller's revocation list, so clearing, pruning and disposal release it.
 */
const renderPng: DisplayRenderer = (output, context) => {
  if (output.encoding !== "base64") return null;
  const bytes = decodeBase64(output.data);
  if (!bytes || !looksLikePng(bytes)) return null;

  const doc = context.document;
  const figure = doc.createElement("figure");
  figure.className = "bp-figure";
  figure.setAttribute("part", "figure");

  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
  context.track(url);

  const image = doc.createElement("img");
  image.src = url;
  // A default that says something: without it a screen-reader user meets an unlabelled image in
  // the middle of a transcript, and Python cannot supply an alt text this package would treat as
  // markup, so the label is generated from the figure number the engine sent.
  image.alt =
    output.metadata?.figure !== undefined
      ? `Matplotlib figure ${output.metadata.figure}`
      : "Matplotlib figure";
  image.loading = "lazy";
  image.decoding = "async";
  figure.append(image);

  const download = doc.createElement("a");
  download.className = "bp-figure-download";
  download.href = url;
  download.download =
    output.metadata?.figure !== undefined ? `figure-${output.metadata.figure}.png` : "figure.png";
  download.textContent = "Download PNG";
  figure.append(download);

  return figure;
};

/** Plain text from the display channel - a repr too large or too structured for the result line. */
const renderText: DisplayRenderer = (output, context) => {
  if (output.encoding !== "utf8") return null;
  const pre = context.document.createElement("pre");
  pre.className = "bp-display-text";
  pre.setAttribute("part", "display");
  // textContent. This whole module exists so that this is never `innerHTML`.
  pre.textContent = output.data;
  return pre;
};

registerDisplayRenderer("image/png", renderPng);
registerDisplayRenderer("text/plain", renderText);

/** Build an element for one payload, or null when nothing safe can be made of it. */
export function renderDisplay(
  output: ConsoleDisplayOutput,
  context: { document: Document; track(url: string): void },
): HTMLElement | null {
  const renderer = renderers.get(output.mime);
  if (!renderer) return null;
  return renderer(output, context);
}
