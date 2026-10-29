/** `text` without its trailing `char`s. Linear, unlike `/x+$/`, which backtracks quadratically. */
export function trimTrailing(text: string, char: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === char) end--;
  return text.slice(0, end);
}
