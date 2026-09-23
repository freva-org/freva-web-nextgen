// The browser suite's own honesty check. `browser-tests/python-open-installs.mjs` decides
// whether a Python program printed what it was supposed to by reading the console's transcript,
// and that transcript contains the ECHO of the program as well as its output. A helper that
// confuses the two passes without the browser having done anything - a green result standing in
// for evidence.
//
// Falling back to "the whole transcript is the output" when the opening marker is missing is
// how: a timed-out run whose transcript holds only `print("WORLDMAP", 3)` then satisfies a check
// waiting for `WORLDMAP`. These are the cases that must stay closed.

import { describe, expect, it } from "vitest";

import { DONE, OUT, readTranscript, wrap } from "../../browser-tests/fixtures/transcript.mjs";

/** What the console shows for a submitted program before anything has run. */
const echoOf = (source: string) => `>>> ${source.split("\n").join("... ")}`;

describe("reading a console transcript", () => {
  it("does not treat an echo as output", () => {
    // Exactly the defect: submitted, echoed, nothing executed.
    const source = 'print("WORLDMAP", 3)';
    const read = readTranscript(echoOf(wrap(source)), { idle: false });
    expect(read.output).toBeNull();
    expect(read.started).toBe(false);
    expect(read.ended).toBe(false);
  });

  it("does not treat an echo as output even once the interpreter is idle again", () => {
    // Idle with no opening marker means the program never printed - not that it finished quietly.
    const read = readTranscript(echoOf(wrap('print("WORLDMAP", 3)')), { idle: true });
    expect(read.output).toBeNull();
    expect(read.ended).toBe(false);
  });

  it("the markers cannot appear in the echo, because Python builds them", () => {
    const program = wrap('print("hello")');
    expect(program).not.toContain(OUT);
    expect(program).not.toContain(DONE);
    expect(program).toContain('print("<" + "<OUT>>")');
  });

  it("returns only what lies between the markers", () => {
    const read = readTranscript(`${echoOf("x")}${OUT}\nWORLDMAP 3\n${DONE}\n`, { idle: false });
    expect(read.output).toBe("\nWORLDMAP 3\n");
    expect(read.ended).toBe(true);
  });

  it("hands back a traceback the moment the interpreter goes idle without the closing marker", () => {
    const partial = `${echoOf("x")}${OUT}\nTraceback (most recent call last):\nValueError: no\n`;
    expect(readTranscript(partial, { idle: false }).ended).toBe(false);
    const read = readTranscript(partial, { idle: true });
    expect(read.ended).toBe(true);
    expect(read.output).toContain("ValueError");
  });
});
