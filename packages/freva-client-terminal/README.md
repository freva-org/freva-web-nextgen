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
| Copy feedback, the settings (⋮) menu, colour + opacity             | What "copy" copies, and what a commit does |
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

Two things hold this in place:

- `src/wrap.ts` states the contract as a pure function; `tests/wrap.test.ts` asserts it for prefixes
  occupying one, two, three and four visual lines.
- `fixtures/wrapping.html` measures the same four cases in a **real browser**, because jsdom performs
  no layout and a width mock cannot answer a layout question. Open the file directly, or drive it
  from a harness via `window.__fixtureResult`.

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
