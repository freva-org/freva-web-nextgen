// Telling a program's OUTPUT apart from the console's ECHO of it - the pure half, so it can be
// tested without a browser.
//
// The console echoes a submitted program on the same transcript it later writes output to, so
// `print("FETCHED", ...)` puts FETCHED in the transcript the instant the line is submitted: a
// check waiting for a word the program CONTAINS returns before anything has run, then asserts
// against the test's own source. Every program is therefore wrapped in two markers BUILT IN
// PYTHON - `"<" + "<OUT>>"` - so the literal cannot appear in the echo of the line that prints it.
// What lies between them is output and nothing else. Hence `readTranscript`'s rule: **no opening
// marker means no output**, not "the whole transcript is the output" - falling back to the
// transcript hands a program that never ran its own echo back to the assertion.

export const OUT = "<<OUT>>";
export const DONE = "<<DONE>>";

/** The program as it is submitted: the caller's source between two markers it prints itself. */
export function wrap(source) {
  const body = source.endsWith("\n") ? source : `${source}\n`;
  return `print("<" + "<OUT>>")\n${body}print("<" + "<DONE>>")\n`;
}

/**
 * Read a transcript slice.
 *
 * `output` is `null` until the program has printed something - the opening marker is the first
 * thing it prints, so its absence means the program has not begun, or never did. `ended` is true
 * when the closing marker arrived (the program ran to its end) or the opening marker is present
 * and the interpreter is idle again (it raised, and the traceback is in `output`).
 */
export function readTranscript(text, { idle = false } = {}) {
  const opened = text.indexOf(OUT);
  if (opened < 0) return { output: null, ended: false, started: false };
  const body = text.slice(opened + OUT.length);
  const closed = body.indexOf(DONE);
  return {
    output: closed < 0 ? body : body.slice(0, closed),
    ended: closed >= 0 || idle,
    started: true,
  };
}
