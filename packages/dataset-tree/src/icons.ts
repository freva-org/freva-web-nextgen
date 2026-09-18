// icons.ts - the package's whole icon set, as path data: eleven glyphs, a few hundred bytes, no
// sprite sheet, no font, no remote asset, sharing one 16x16 grid and inheriting the row's colour,
// so a row does not look assembled from three icon sets. Controls are stroked and subjects filled;
// `icon()` in `dom.ts` carries the reason for the split.

/** A right-pointing chevron. Rotated 90 degrees by CSS when its row is open. */
export const CHEVRON = ["M6 3.5 10.5 8 6 12.5"];

// The three subject glyphs are filled rather than stroked - `icon()` in `dom.ts` says why - and
// each carries its own hole under the even-odd rule, not a second path in a second colour.

/** A folder, for collections and directories. One closed silhouette with the tab on the left. */
export const FOLDER = [
  "M1.6 3.4a1.15 1.15 0 0 1 1.15-1.15h2.8L7.1 3.9h6.15A1.15 1.15 0 0 1 14.4 5.05v6.5a1.15 1.15 0 0 1-1.15 1.15H2.75A1.15 1.15 0 0 1 1.6 11.55z",
];

/**
 * A cube, for a dataset: a store rather than a folder of bytes. Silhouette and open top face are
 * one path - even-odd cuts a hole between subpaths of a single `d`, where two `<path>` elements
 * would paint one over the other in the same colour - so it reads as an open container at 13px
 * rather than a wireframe box.
 */
export const CUBE = ["M8 1.4 14 4.6v6.8L8 14.6 2 11.4V4.6zM8 3.4 4.15 5.45 8 7.5l3.85-2.05z"];

/** A page, for an ordinary file, with the dog-ear cut out of the same path as the body. */
export const FILE = [
  "M4 1.5h4.5L12.5 5.5v8.1a.9.9 0 0 1-.9.9H4a.9.9 0 0 1-.9-.9V2.4a.9.9 0 0 1 .9-.9zM8.9 2.6v2.5h2.5z",
];

/** A magnifier, beside the filter field. */
export const SEARCH = ["M7.25 2.25a5 5 0 1 0 0 10 5 5 0 0 0 0-10z", "M10.9 10.9 14 14"];

/** An outward arrow, for a link that leaves the page. */
export const EXTERNAL = [
  "M6.5 3.25h-3.25v9.5h9.5V9.5",
  "M9.5 2.75h3.75v3.75",
  "M13.25 2.75 7.75 8.25",
];

/** An `i` in a circle, on the "How to access" disclosure. */
export const INFO = [
  "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5z",
  "M8 7.25v4",
  "M8 4.9h.01",
];

/**
 * A play triangle, for the run control. Filled rather than stroked, against the rule the other
 * controls follow: an outlined triangle at 13px is three hairlines reading as a caret, and the one
 * control that starts something rather than opening or copying it should not look like a chevron.
 */
export const PLAY = ["M5.6 3.6 12.6 8l-7 4.4z"];

/**
 * Two sheets, for the copy control that sits inside the address box. Stroked, like the other
 * controls: it is something you press, not something the row is about. The back sheet is an open
 * corner rather than a full rectangle, because two complete rectangles at 13px read as a single
 * thick-edged square.
 */
export const COPY = ["M6 5.75h6.5v7.5H6z", "M3.75 10.25V2.75h6.5"];

/** A tick, shown in place of the copy glyph for the moment after a successful copy. */
export const CHECK = ["M3.5 8.5 6.5 11.5 12.5 4.75"];

/** A cross, for the close control on the information card. */
export const CLOSE = ["M4.25 4.25 11.75 11.75", "M11.75 4.25 4.25 11.75"];
