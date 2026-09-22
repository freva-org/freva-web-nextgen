/**
 * @vitest-environment happy-dom
 *
 * The options are checked against the PINNED library, not the documentation. jQuery Terminal's
 * failure mode with Python is a quiet rewrite, not a crash: a command parsed as a shell line, or
 * matched against a built-in, so what reaches the interpreter is not what was typed. Three
 * assertions: every option set is a REAL option in the pinned build (a typo is a no-op that looks
 * like a working setting); every dangerous default is overridden; and each overridden default is
 * still the unsafe value upstream, so one that becomes safe can be retired.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import jQuery from "jquery";
import installTerminal from "jquery.terminal";
import { SAFE_OPTIONS } from "../../src/console/adapters/surface-options.js";

const install = installTerminal as unknown as (root: unknown, jq: typeof jQuery) => typeof jQuery;
const $ = install(globalThis, jQuery) as unknown as {
  terminal: { defaults: Record<string, unknown> };
};
const defaults = $.terminal.defaults;

/** The library's own source, read from the installed copy. `$.terminal.defaults` is not the
 * whole option surface: `execHash` is honoured by the code (`settings.execHash`) but never listed,
 * so it is `undefined` unless a host sets it - and "not in defaults" is also what a typo looks
 * like, so the source is the tie-breaker. */
const librarySource = readFileSync(
  createRequire(import.meta.url).resolve("jquery.terminal/js/jquery.terminal.js"),
  "utf8",
);

/**
 * Options that are hooks or values rather than switches, so they have no meaningful default to
 * compare against. They still have to EXIST, which case 1 covers.
 */
const NOT_DEFAULTS = new Set(["greetings", "prompt"]);

describe("the surface is configured against the pinned library", () => {
  it("installs onto the private instance and exposes its defaults", () => {
    // If this fails, nothing else in the file means anything: it would be testing an empty object.
    expect(typeof defaults).toBe("object");
    expect(Object.keys(defaults).length).toBeGreaterThan(50);
  });

  it("sets no option the library does not have", () => {
    // Either it is in the defaults, or the code reads it as `settings.<name>`. Anything else is a
    // setting that does nothing, which is indistinguishable from a working one until it matters.
    const unknown = Object.keys(SAFE_OPTIONS).filter(
      (key) =>
        !NOT_DEFAULTS.has(key) && !(key in defaults) && !librarySource.includes(`settings.${key}`),
    );
    expect(unknown, `not options in jquery.terminal 2.47.0: ${unknown.join(", ")}`).toEqual([]);
  });

  // `execHash` is the one option this package sets that has no default at all. It is honoured -
  // the code branches on `settings.execHash` in three places - so setting it false is meaningful,
  // and this records why it will never appear in the defaults check above.
  it("execHash is honoured by the code even though it has no default", () => {
    expect("execHash" in defaults).toBe(false);
    expect(librarySource).toContain("settings.execHash");
    expect(SAFE_OPTIONS.execHash).toBe(false);
  });

  // The two built-in commands, at the source level. The library matches these against the
  // submitted line BEFORE the interpreter sees it, and both are valid Python.
  it.each(["exit", "clear"])(
    "%s is still intercepted before the interpreter, which is why it is disabled",
    (command) => {
      expect(librarySource).toContain(`settings.${command} && command.match`);
    },
  );

  // The list, restated. `processArguments` mangles `{"Test": 'test'}`; `exit` and `clear` swallow
  // a valid Python line whole; the rest are described one by one in `surface-options.ts`.
  it.each([
    ["processArguments", false], // splits the command into shell arguments
    ["checkArity", false], // rejects a command by argument count
    ["execHash", false], // writes the command into the URL fragment
    ["historyState", false], // writes the command into the history stack
    ["invokeMethods", false], // `[[ terminal::clear() ]]` in OUTPUT would call a method
    ["anyLinks", false], // arbitrary URI schemes, `javascript:` among them
    ["convertLinks", false], // linkifies whatever Python printed
    ["exit", false], // intercepts a bare `exit`, which is valid Python
    ["clear", false], // intercepts a bare `clear`, which is a name anyone might bind
    ["pasteImage", false], // would insert library markup into the command line
    ["echoCommand", false], // this package echoes, so it can highlight
    ["history", false], // history is this package's
    ["completion", false], // completion is the engine's
    ["wordAutocomplete", false], // would compete for Tab
    ["raw", false], // output is text, never markup
    ["linksNoReferrer", true], // the one that is deliberately ON
  ])("sets %s to %s", (option, expected) => {
    expect(SAFE_OPTIONS[option as keyof typeof SAFE_OPTIONS]).toBe(expected);
  });

  // The upstream side of the same list. Each is unsafe BY DEFAULT in 2.47.0, which is why the
  // override exists. A failure here is good news that needs acting on, not a regression.
  it.each([
    ["processArguments", true],
    ["checkArity", true],
    ["convertLinks", true],
    ["echoCommand", true],
    ["history", true],
    ["exit", true],
    ["clear", true],
    ["pasteImage", true],
    ["wordAutocomplete", true],
  ])(
    "%s is still unsafe by default upstream, so the override is still needed",
    (option, unsafe) => {
      expect(defaults[option]).toBe(unsafe);
    },
  );

  // `invokeMethods` and `anyLinks` already default off. They are set anyway: a default is a
  // thing that can change in a minor release, and these two are the difference between printing a
  // string and executing it.
  it.each(["invokeMethods", "anyLinks"])(
    "%s defaults off, and is set explicitly regardless",
    (o) => {
      expect(defaults[o]).toBe(false);
      expect(SAFE_OPTIONS[o as keyof typeof SAFE_OPTIONS]).toBe(false);
    },
  );

  it("leaves the prompt as the Python one", () => {
    expect(SAFE_OPTIONS.prompt).toBe(">>> ");
  });
});
