// Figures the code saved instead of showing (`savefig`, then `close`): ClimateClaw does not stream
// those, it names the file and where it can be seen (`preview_url` on the Freva website). They are
// fetched and shown like a streamed figure - in the notebook cell, or in the chat - and when the
// browser may not read them (no CORS) the cell and the chat get the picture by its address and a
// link to it.

import { previewUrl, type CodeOutput } from "./stream.js";

export const FIGURE_MIME = new Set(["image/png", "image/jpeg"]);
/** Larger files are linked, not embedded. */
export const MAX_FIGURE_BYTES = 8 * 1024 * 1024;

export interface SavedFigure {
  name: string;
  url: string;
  mime: string;
}

const BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** The image files a run wrote that can be shown, with where to get them. */
export function savedFigures(output: CodeOutput): SavedFigure[] {
  return output.files.flatMap((file) => {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const mime = file.mime && FIGURE_MIME.has(file.mime) ? file.mime : BY_EXTENSION[extension];
    return file.url && mime && previewUrl(file.url)
      ? [{ name: file.name, url: file.url, mime }]
      : [];
  });
}

/**
 * Waits between reads of a figure that is not there yet: the server may serve a saved file a
 * moment after the run that wrote it reports, and a read too early would leave only its link.
 */
export const FIGURE_RETRY_MS = [400, 800, 1600, 3200];

type Read = { base64: string } | { again: string; refused?: true } | { never: string };

/** One read: the bytes, a failure worth another try (not there yet, no answer), or one not. */
async function readOnce(
  figure: SavedFigure,
  get: typeof fetch,
  signal: AbortSignal,
): Promise<Read> {
  let response: Response;
  try {
    response = await get(figure.url, { credentials: "omit", redirect: "error", signal });
  } catch (error) {
    // No answer, a dropped connection - or a CORS refusal, which looks the same from here and
    // would not change: tried once more only.
    return { again: error instanceof Error ? error.message : String(error), refused: true };
  }
  if (response.status === 404 || response.status === 408 || response.status === 425) {
    return { again: `HTTP ${response.status}` };
  }
  if (response.status === 429 || response.status >= 500)
    return { again: `HTTP ${response.status}` };
  if (!response.ok) return { never: `HTTP ${response.status}` };
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (type && !FIGURE_MIME.has(type)) return { never: `served as ${type}` };
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_FIGURE_BYTES) return { never: "too large" };
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    return { again: error instanceof Error ? error.message : String(error) };
  }
  if (bytes.length === 0) return { again: "empty" };
  if (bytes.length > MAX_FIGURE_BYTES) return { never: "too large" };
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { base64: btoa(binary) };
}

/**
 * The figure's bytes as base64, or null when it cannot be read here (CORS, size, type). A read
 * that found nothing yet (404, a server error, an empty file) is tried again, a few times over
 * some seconds; one with no answer at all (a dropped connection, or CORS) once. Why it gave up
 * goes to the console.
 */
export async function fetchFigure(
  figure: SavedFigure,
  options: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    timeoutMs?: number;
    retryDelaysMs?: readonly number[];
  } = {},
): Promise<string | null> {
  const get = options.fetch ?? globalThis.fetch.bind(globalThis);
  const delays = options.retryDelaysMs ?? FIGURE_RETRY_MS;
  let why = "";
  let refusals = 0;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (options.signal?.aborted) return null;
    if (attempt > 0) {
      const aborted = await pause(delays[attempt - 1]!, options.signal);
      if (aborted) return null;
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 15_000);
    const abort = () => timeout.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const read = await readOnce(figure, get, timeout.signal);
      if ("base64" in read) return read.base64;
      if ("never" in read) {
        why = read.never;
        break;
      }
      why = read.again;
      if ("refused" in read && ++refusals > 1) break;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  if (!options.signal?.aborted) {
    console.warn(`ClimateClaw: the figure ${figure.url} was not read (${why}); it is linked.`);
  }
  return null;
}

/** Waits `ms`; true when `signal` ended the wait. */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve(false);
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** Markdown link text: no markup. */
function linkText(text: string): string {
  return text.replace(/[[\]\\`*_<>]/g, (c) => `\\${c}`);
}

/** Whether this page may show the figure from its address (no origin given: assumed so). */
export function showable(figure: SavedFigure, imageOrigin?: string): boolean {
  if (!imageOrigin) return true;
  try {
    return new URL(figure.url).origin === imageOrigin;
  } catch {
    return false;
  }
}

/**
 * The figure in Markdown: embedded when its bytes are here, else by its address when the page may
 * show pictures from there; and a link. Never a broken picture: otherwise the link alone.
 */
export function figureMarkdown(
  figure: SavedFigure,
  base64: string | null,
  imageOrigin?: string,
): string {
  const name = linkText(figure.name.split("/").pop() || figure.name);
  const link = `[${name} ↗](${figure.url})`;
  if (base64) return `![${name}](data:${figure.mime};base64,${base64})\n\n${link}`;
  if (showable(figure, imageOrigin)) return `![${name}](${figure.url})\n\n${link}`;
  return `◩ ${link} _(opens the figure: it cannot be shown here)_`;
}
