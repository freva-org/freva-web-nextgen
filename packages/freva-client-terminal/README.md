# @freva-org/freva-client-terminal

A reusable, framework-free terminal **window** for freva-client commands. Zero third-party runtime
dependencies, its own scoped stylesheet, and no knowledge whatsoever of what your commands mean.

It was extracted from the Freva Data Browser so a second freva-client command can offer the same
terminal without importing a data browser.

```bash
npm install @freva-org/freva-client-terminal
```

## What it owns, and what you own

| The package                                                        | You                                        |
| ------------------------------------------------------------------ | ------------------------------------------ |
| Window chrome, traffic lights, drag / resize / maximize / minimize | Application state                          |
| Tabs: activate, close, reopen                                      | What a token means                         |
| The editable line, highlighting surface, caret                     | Which keys and values exist                |
| The completion menu (list + inline ghost)                          | Which candidates to offer                  |
| Copy feedback, the settings (⋮) menu, colour + opacity + text size | What "copy" copies, and what a commit does |
| The `Tab` / `Esc`-then-`Tab` keyboard contract (WCAG 2.1.2)        | Persisting the colour/opacity choice       |

Everything domain-specific arrives through `TerminalTab` callbacks. If a change to this package ever
needs to know about your data model, the seam has leaked.

## Usage

```ts
import { createTerminal } from "@freva-org/freva-client-terminal";

const handle = createTerminal(document.querySelector("#app")!, {
  tabs: [
    {
      id: "greet",
      label: "bash",
      // The IMMUTABLE prefix. It shares one inline flow with the editable command.
      prefix: () => [
        { text: "$", kind: "prompt" },
        { text: " " },
        { text: "freva-client greet", kind: "fixed" },
      ],
      text: () => state.args, // the buffer, derived from YOUR state
      highlight: (text) => ({ segments: [{ text, kind: "value" }] }),
      complete: (text, caret) => null, // or offer items / an inline ghost
      commit: (text, caret, final) => {
        state.args = text;
        return { dirty: false };
      },
      copyText: () => `freva-client greet ${state.args}`,
    },
  ],
});

handle.toggle(true); // open the window
```

`createTerminal` appends its own root to the mount and injects its own stylesheet, so nothing else
is required to make it look right.

## The window on its own

`createTerminal` is a tab strip drawn inside a window. The window is exported separately, so a host
that needs **this** window around content of its own - a Python console, a log viewer - reuses the
frame instead of drawing a second one that then has to be kept looking like it.

```ts
import { createTerminalWindow } from "@freva-org/freva-client-terminal";

const win = createTerminalWindow(document.querySelector("#overlay")!, {
  os: "linux",
  bounds: () => document.querySelector("#overlay"),
  copyText: () => session.transcript(), // what the copy control copies
  copyLabel: "transcript",
  closeLabel: "Hide",
  menuSections: [
    { title: "Transcript", items: [{ label: "Clear transcript", onSelect: clear }] },
    { title: "Session", items: [{ label: "End session…", onSelect: end, danger: true }] },
  ],
  onBodyActivate: () => console.focus(), // a press on empty body space
  onResize: () => console.fit(),
});

win.body.append(myConsoleElement); // the content slot
win.show();
```

The window owns the frame, the traffic lights, drag / resize / minimize-to-dock / maximize, the ⋮
menu, and the appearance model (colour, opacity, text size, reset). It owns **nothing** inside
`body`: it has no editor, no tabs and no transcript, and answers "what does copy copy?" by asking
you.

### The title bar is three slots

```
[ barStart: window controls, then yours ]  [ barSpacer ]  [ barEnd: copy, yours, ⋮ ]
```

Put host controls in one with `addBarControl`, and give their selector to `dragExclude` so pressing
one does not drag the window:

```ts
win.addBarControl(mySessionTitle, "start"); // with dragExclude: ".my-tab-chip"
win.addBarControl(myAction, "end"); // always lands BEFORE the ⋮ menu
```

`addBarControl` is preferred over reaching into `bar` directly because it is the only route that
keeps the ⋮ menu the last thing in the row - it is the overflow for everything beside it, and an
overflow menu that is not at the end of the row it overflows is a menu nobody finds.
`bar.insertBefore(node, barSpacer)` still lands in the left group, for consumers written before the
groups existed.

`controlsSide` decides which side the window's own close / minimise / maximise cluster sits on, and
defaults to `start` for every `os`. `os` decides how those controls **look** and in what order -
macOS dots, Windows labelled buttons, GNOME symbolic circles - and that is worth following. Where
they **sit** is a different question with a different answer: a window embedded in a page is not a
window on a desktop, and following the reader's OS for position means the same product has its close
button on different edges for two people looking at it together. Pass `controlsSide: "end"` for the
desktop convention; the application group stays right-aligned either way.

### Asking before something irreversible

```ts
const ok = await win.confirm({
  title: "Restart Session 1?",
  body: "Its variables, imports and in-memory interpreter state will be lost.",
  confirmLabel: "Restart session",
  danger: true,
});
```

A `role="alertdialog"` inside the window, in the window's own colours. It closes the ⋮ menu first,
focuses **Cancel**, traps Tab between the two buttons, cancels on Escape, and returns the focus to
the control that raised it. A second call while one is open resolves `false` immediately, so a
double press cannot perform the action twice.

### Appearance

Colour, opacity and text size are the window's, persisted through the `storage` you supply. Text
size is a **multiplier** (`--term-scale`, 0.8–1.6) applied to the content sizes only: the title bar,
the traffic lights and the ⋮ menu keep the size the frame was drawn for, because a window whose
controls grew with its text stops fitting them.

### Keeping the buffer in step with your own UI

When _your_ UI changes the query (a chip removed, a "clear all"), bump a counter from `revision()`.
The terminal then rebuilds the buffer from `text()` even while the editor is focused - otherwise a
half-typed draft survives the clear and re-commits the filters the user just removed. Anything that
should survive that rebuild is returned by `retain()`:

```ts
revision: () => state.externalEdits,
retain: (buffer) => uncommittedTokensIn(buffer),
```

### Geometry is container-relative

The window is positioned and clamped inside the mount (or an explicit `bounds()` element), never
against `window.innerWidth/innerHeight`. That is what lets it work inside a host that relocates the
mount into a clipped, transformed container - the case where `position: fixed` silently resolves
against the wrong box.

### Tooltips

By default hover help uses the native `title`. If your host renders its own tooltips, point the
terminal at your attribute so controls do not get two popups:

```ts
createTerminal(mount, { tabs, tooltipAttribute: "data-tip" });
```

## The wrapping contract

The editable command and the immutable prefix are ordinary inline siblings in one
`white-space: pre-wrap` flow. There is **no** `text-indent`, no absolutely-positioned prefix layer,
no width threshold, and no "prefix on its own line" mode.

That matters because an indent shifts only the _first_ line. The previous geometry used one, so as
soon as the prefix itself wrapped, the painted prompt and the typed text disagreed: the command
either overlapped the prompt or was pushed onto the following line. In one shared flow the command
starts immediately after the last prefix token at every width, and every continuation begins at the
container's left edge - exactly like a shell.

`src/wrap.ts` states the contract as a pure function; `tests/wrap.test.ts` asserts it for prefixes
occupying one, two, three and four visual lines. The mounted terminal is measured in a real browser
by `terminal-wrapping.mjs` in the databrowser package, because jsdom performs no layout and a width
mock cannot answer a layout question.

## Editing modes

- **rich** - a controlled `contenteditable="plaintext-only"` span. The highlight _is_ the editable
  surface, so there is no overlay to keep in sync. Used for single-line buffers where the engine
  supports `plaintext-only`.
- **plain** - the explicit fallback: a real `<textarea>` with a `<pre>` overlay and the prefix as a
  block above. Used for multi-line buffers, narrow viewports, a forced `fallback()`, and any engine
  without `plaintext-only` (which includes jsdom, so this is the mode the node tests exercise).

Pasted content is taken as plain text in both modes, and values reach the DOM through `textContent` -
never `innerHTML`. The one exception is `TerminalTab.icon`, which is assigned as markup and must
therefore always be a compile-time constant, never data.

## Styling

Every rule is scoped to `.freva-term`. Tokens (`--term-bg`, `--term-fg`, `--term-alpha`, and the
syntax colours) are set on the root, so a host can retheme without forking the stylesheet. Edit
`src/styles.css` and run `npm run gen:styles -w @freva-org/freva-client-terminal`; never edit the
generated `src/styles.ts` by hand - a test pins the two together.

## License

BSD-3-Clause
