// wrap.ts - the shell-line wrapping CONTRACT, as a pure function.
//
// `.te-flow` is `white-space: pre-wrap; overflow-wrap: anywhere` with the prefix and the command as
// plain inline siblings, so the browser lays them out as one monospaced text flow. This function is
// the same flow written down: given the prefix tokens, the command and a column width, it says
// which visual line each piece lands on.
//
// It exists so the wrapping requirement can be asserted DETERMINISTICALLY - "with a prefix that
// occupies one, two, three or four visual lines, the command still begins immediately after the
// last prefix token, and every wrapped continuation starts at column 0". A jsdom width mock cannot
// check that (jsdom does no layout at all). The browser fixture in `fixtures/wrapping.html` checks
// that a real engine actually realises this contract; these two together are what replaced the old
// `--te-indent` measurement.
//
// NOTE what is deliberately absent: there is no indent, no threshold, and no "prefix on its own
// line" mode. Those were the defect.

export interface WrapPlan {
  /** Every visual line, in order. */
  lines: string[];
  /** How many visual lines the prefix occupies (its last line may also carry command text). */
  prefixLines: number;
  /** 0-based visual line the command's first character lands on. */
  commandLine: number;
  /** Column the command's first character starts at, on `commandLine`. */
  commandColumn: number;
}

/**
 * Lay out `prefixTokens` (space-separated) followed by `command` into `columns`-wide lines.
 *
 * Breaking rules mirror `pre-wrap` + `overflow-wrap: anywhere`:
 *  - a space is a break opportunity and is consumed by the break;
 *  - a token longer than one full line is hard-broken at the column edge;
 *  - a continuation line always starts at column 0.
 */
export function wrapPlan(prefixTokens: string[], command: string, columns: number): WrapPlan {
  const cols = Math.max(1, Math.floor(columns));
  const lines: string[] = [""];
  let commandLine = -1;
  let commandColumn = -1;
  let prefixLines = 0;

  const push = (text: string): void => {
    let cur = lines[lines.length - 1];
    for (const ch of text) {
      if (cur.length >= cols) {
        lines[lines.length - 1] = cur;
        lines.push("");
        cur = "";
      }
      cur += ch;
    }
    lines[lines.length - 1] = cur;
  };
  const width = (): number => lines[lines.length - 1].length;
  const newline = (): void => {
    lines.push("");
  };
  /** A space-separated word: break BEFORE it when it does not fit on the current line. */
  const pushWord = (word: string, separator: boolean): void => {
    const need = (separator ? 1 : 0) + word.length;
    if (width() > 0 && width() + need > cols && word.length <= cols) {
      newline(); // the separating space is consumed by the break, as in a real text flow
    } else if (separator && width() > 0) {
      push(" ");
    }
    push(word);
  };

  prefixTokens.forEach((tok, i) => pushWord(tok, i > 0));
  prefixLines = lines.length;

  if (command.length === 0) {
    return {
      lines,
      prefixLines,
      commandLine: lines.length - 1,
      commandColumn: width() + (prefixTokens.length ? 1 : 0),
    };
  }

  // One separating space between the prefix and the command, then the command's own words. The
  // command begins on the prefix's LAST line whenever its first word fits there.
  const words = command.split(" ");
  words.forEach((word, i) => {
    const separator = i > 0 || prefixTokens.length > 0;
    const before = lines.length - 1;
    const beforeWidth = width();
    pushWord(word, separator);
    if (i === 0) {
      const broke = lines.length - 1 !== before;
      commandLine = broke ? lines.length - 1 : before;
      commandColumn = broke ? 0 : beforeWidth + (separator && beforeWidth > 0 ? 1 : 0);
      // A long first word may itself have wrapped while being pushed; the START is what matters.
      if (broke) commandColumn = 0;
    }
  });

  return { lines, prefixLines, commandLine, commandColumn };
}
