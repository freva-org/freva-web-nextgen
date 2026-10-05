// Jupyter counts cursor positions in Unicode code points (protocol 5.2+); the engine counts UTF-16
// code units, as JavaScript strings do. They differ for every character outside the Basic
// Multilingual Plane, e.g. most emoji.

/** A code-point offset into `text`, as a UTF-16 index. Clamped to the text. */
export function codePointsToUtf16(text: string, offset: number): number {
  let index = 0;
  for (let count = 0; count < offset && index < text.length; count += 1) {
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return index;
}

/** A UTF-16 index into `text`, as a code-point offset. Clamped to the text. */
export function utf16ToCodePoints(text: string, index: number): number {
  let count = 0;
  for (let at = 0; at < Math.min(index, text.length); count += 1) {
    at += (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
  }
  return count;
}
