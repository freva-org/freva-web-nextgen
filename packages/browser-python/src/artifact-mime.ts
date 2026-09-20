/**
 * artifact-mime.ts - what a filename suggests, and how little of that is trusted.
 *
 * A filename in the workspace was chosen by Python, and Python here is whatever the visitor typed
 * or pasted, so the extension is a HINT about how to present a file and never a fact about what
 * is in it: `report.pdf` can contain HTML. PREVIEW IS AN ALLOWLIST, not a prefix test - `text/*`
 * contains `text/html` and `image/*` contains `image/svg+xml`, a document format with scripting -
 * so an unlisted type is offered for download and says so. And A BLOB'S TYPE IS NEUTRAL unless it
 * is being previewed: a blob URL inherits the page's origin, so `new Blob([html], { type:
 * "text/html" })` behind an object URL is a same-origin document waiting to be navigated to.
 */

/** Extension to MIME. A hint for presentation, and nothing else - see the header. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  py: "text/x-python",
  yaml: "text/yaml",
  yml: "text/yaml",
  log: "text/plain",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  nc: "application/x-netcdf",
  h5: "application/x-hdf5",
  hdf5: "application/x-hdf5",
  parquet: "application/vnd.apache.parquet",
  npy: "application/x-npy",
  npz: "application/x-npz",
  pdf: "application/pdf",
};

export function mimeForName(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/** Types that are documents rather than data: they can carry script, and a browser will run it.
 * Named rather than derived, so adding one is a deliberate act. `image/svg+xml` is the surprise -
 * in the `image/` family, renders in an `<img>`, and is XML with `<script>` in its grammar. */
const ACTIVE_MIMES: ReadonlySet<string> = new Set([
  "text/html",
  "image/svg+xml",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "application/pdf",
]);

export function isActiveMime(mime: string): boolean {
  return ACTIVE_MIMES.has(mime);
}

/** Exactly the types a preview may render, by element. Anything absent is download-only. */
const PREVIEW_AS_TEXT: ReadonlySet<string> = new Set([
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/markdown",
  "text/x-python",
  "text/yaml",
  "application/json",
]);

const PREVIEW_AS_IMAGE: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

const PREVIEW_AS_AUDIO: ReadonlySet<string> = new Set([
  "audio/wav",
  "audio/mpeg",
  "audio/ogg",
  "audio/flac",
]);

const PREVIEW_AS_VIDEO: ReadonlySet<string> = new Set(["video/mp4", "video/webm"]);

export type PreviewKind = "text" | "img" | "audio" | "video" | "none";

/** Which element, if any, may show this MIME type inline. An allowlist and never a prefix test:
 * `startsWith("text/")` admits `text/html` and `startsWith("image/")` admits `image/svg+xml`, and
 * rendering either in the console's shadow root puts visitor-authored markup on the host origin. */
export function previewKind(mime: string): PreviewKind {
  if (PREVIEW_AS_TEXT.has(mime)) return "text";
  if (PREVIEW_AS_IMAGE.has(mime)) return "img";
  if (PREVIEW_AS_AUDIO.has(mime)) return "audio";
  if (PREVIEW_AS_VIDEO.has(mime)) return "video";
  return "none";
}

/**
 * Why a type is not previewed, in a sentence a person can act on. "No preview" reads like a
 * missing feature; for HTML and SVG it is a decision, and saying so is the difference between a
 * visitor filing a bug and a visitor clicking Download.
 */
export function previewRefusal(mime: string): string {
  if (isActiveMime(mime)) {
    return (
      `${mime} can contain scripts, so it is not shown inline - rendering it here would run it ` +
      `on this page's origin. Download it and open it yourself.`
    );
  }
  return `No preview for ${mime}. Download it to open it.`;
}

/** The `type` to put on a Blob that is being DOWNLOADED rather than displayed. Neutral for
 * anything active: a blob URL is same-origin, so a `text/html` blob is one accidental navigation
 * from being a page on the host's origin. The download is unaffected - the file saves under its
 * own name and the operating system opens it by extension. */
export function safeBlobType(mime: string): string {
  return isActiveMime(mime) ? "application/octet-stream" : mime;
}
