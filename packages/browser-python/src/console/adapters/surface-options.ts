/**
 * surface-options.ts - the jQuery Terminal options this package sets, and why each one.
 *
 * A separate module from the adapter, which imports jQuery and the plugin and so costs a DOM.
 * This file imports nothing, which lets `tests/console/surface-options` hold these values against
 * the PINNED library's own `$.terminal.defaults` and fail if an option name stops existing or a
 * default this package overrides quietly changes. Every entry is a door closed on jQuery Terminal
 * interpreting Python as its own syntax; none is a workaround applied to the Python itself.
 */

/** Options exercised in the fidelity probe. Each one is off for a reason, named. */
export const SAFE_OPTIONS = {
  greetings: false,
  history: false, // history is this package's, with prefix navigation the plugin does not have
  prompt: ">>> ",
  // The library must NOT echo the submitted command: this package echoes it itself through
  // `appendText`, so it can render the prompt as a separate element and syntax-highlight the
  // source. Left on, every command prints twice - once plain, once highlighted.
  echoCommand: false,
  // The parsing switches. At their defaults, jQuery Terminal treats a command as a shell line: it
  // splits on whitespace, parses quotes, and interprets JSON-looking arguments, which is how
  // `{"Test": 'test'}` becomes something Python never sees. `processArguments: false` matters most;
  // the rest close adjacent doors.
  processArguments: false,
  checkArity: false,
  // The library's own built-in commands, matched against the SUBMITTED LINE before the
  // interpreter is ever called (jquery.terminal 2.47.0, the `/^\s*exit\s*$/` and `/^\s*clear\s*$/`
  // branches). Both are valid Python, so left on this package would silently swallow two commands.
  // `clear` IS answered, by this package rather than the library - see
  // `ConsoleController.#handleClearCommand` - and these stay off regardless: the behaviour is the
  // console's to define, narrowed to a bare word at a primary prompt, and it must not start
  // answering `exit` because a library release widened its own list.
  exit: false,
  clear: false,
  // Pasting an image would have the library insert its own markup into the command line. There
  // is nothing a PNG can mean at a Python prompt, and the input buffer must only ever contain what
  // the visitor could have typed.
  pasteImage: false,
  // Completion is this package's, driven by the engine's `complete()` and rendered as a menu. The
  // library's own word completion would compete for Tab and complete against the wrong vocabulary.
  // Both default off; set explicitly, because a default is a thing that can change in a release.
  completion: false,
  wordAutocomplete: false,
  // `execHash` and `historyState` write the command into the URL. On a portal page that is a
  // privacy leak into the address bar, the history stack and any referrer.
  execHash: false,
  historyState: false,
  // `invokeMethods` is what makes `[[ terminal::clear() ]]` in OUTPUT call a terminal method. It
  // defaults off in this version and is set explicitly anyway: a default can change in a minor
  // release, and this one is the difference between printing a string and executing it.
  invokeMethods: false,
  anyLinks: false,
  linksNoReferrer: true,
  // No automatic linkification. Python that prints a URL should print a URL; turning arbitrary
  // program output into clickable targets is how `javascript:` gets a click handler.
  convertLinks: false,
  // SCROLLING IS THIS ADAPTER'S. With this on - its default - the library scrolls its own bottom
  // into view on every echo, competing with the adapter's follow state (`#scheduleFollow`,
  // `#atBottom` and `Jump to latest` are one machine deciding when the view should move) and
  // winning, because it scrolls after the append. It only does this while the terminal is ENABLED,
  // so once the window focuses the prompt a reader parked partway up is taken to the end with no
  // unread affordance. Off, `echo` still follows when ALREADY at the bottom - the `bottom` term in
  // `(settings.scrollOnEcho && options.scroll) || bottom`.
  scrollOnEcho: false,
  /** Formatting is applied by this package, never parsed out of text. See `escapeFormatting`. */
  raw: false,
  exceptionHandler: null,
} as const;
