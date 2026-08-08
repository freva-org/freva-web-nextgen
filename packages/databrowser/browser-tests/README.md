# Real-browser regression tests

The unit suite runs in jsdom, which performs **no layout**: every
`getBoundingClientRect()` there is `0x0`, `position: fixed` never resolves
against anything, and a wrapped line box does not exist. The requirements in
this directory are all of that shape - where a line actually broke, whether two
boxes overlap, what an overlay's containing block really turned out to be - so
they are measured in real Chromium instead of faked in jsdom.

The fixture pages load the **built artifacts of both packages** through an
import map (`/pkg/@freva-org/databrowser/index.js`,
`/pkg/@freva-org/freva-client-terminal/index.js`), so what is measured is the
code that ships, not a copy of its CSS.

The scripts live in **this package**, so from the repository root they need
`-w`. (The root `package.json` also carries passthroughs of the same two names,
so either form works; the `-w` form is the one that works from any checkout.)

```bash
npm run test:browser        -w @freva-org/databrowser
npm run test:browser:strict -w @freva-org/databrowser
```

`pretest:browser` runs `npm run build` for you, so both `dist/` trees are
current before anything is measured.

`test:browser:strict` (`BROWSER_STRICT=1`) turns "no browser installed" from a
skip into a failure. Use it as release evidence; a suite that did not execute
proves nothing.

## The suites

All thirteen are listed in `run.mjs`, and `run.mjs` is the list `test:browser`
executes - if a suite is not in it, it does not run.

| Suite                    | What only a real engine can answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal-wrapping.mjs`  | The mounted terminal's prefix + command share one `pre-wrap` flow. Sweeps widths until the prefix occupies 1, 2, 3 and 4 visual lines and checks the command either continues the prompt line or drops to column 0 - never to an indent.                                                                                                                                                                                                                                                                                                                                                  |
| `terminal-behaviour.mjs` | The terminal **typed into**, through `page.keyboard`, against the packaged window: both editors visible / focusable / hit-testable, the buffer after every character, the autocomplete ghost staying out of `Editor.value`, Tab and ArrowRight acceptance, caret movement, mid-line edits, selection replacement, paste, IME composition, multiline python with the ghost at the caret, resynchronisation after Clear all, and the minimized settings menu. jsdom drives the textarea fallback; a browser drives the contenteditable surface - only this file exercises what users touch. |
| `layout.mjs`             | Mobile chips at 320/375/390 px with long labels and Clear all (asserted via non-overlapping bounding rectangles); the sticky list header while its scroller moves; overview reorder from a non-interactive card surface, but not from a click, a sub-threshold move, or an input.                                                                                                                                                                                                                                                                                                         |
| `time-card.mjs`          | The Time range card at the narrowest realistic card width, in both themes: each `.daterow` painted as ONE line of THREE columns (the columns are counted from where the children actually landed - an implicit second grid row costs nothing in jsdom), the From row below the card header with nothing clipped under it, both calendar buttons hit-testable, all three modes visible without scrolling, and partial dates / open bounds / live application still working.                                                                                                                |
| `search-dropdown.mjs`    | The main search dropdown's height: capped at the stylesheet's 340px with many results (an inline style from the positioner used to override the rule and let it fill the component), content-sized with few, still clamped by a shorter component, and unchanged inside a transformed/clipped host. Plus the negative-facet round trip - exclude in Bash, wait for a response that no longer offers the value, remove the chip, and confirm neither terminal keeps it or re-commits it on the next edit.                                                                                  |
| `filters-and-chrome.mjs` | Removing a Time/BBox chip clearing its `*_select` partner everywhere (state, both terminals, the wire) and staying gone through the next edit; the two terminal tabs' immutable text keeping their ORIGINAL and different colours in both presets; the minimized colour palette keeping its flex row and 7px gaps; and inclusion vs exclusion told apart by `+N` filled / `-N` dashed under a red host accent, in greyscale and in `forced-colors`.                                                                                                                                       |
| `overview-order.mjs`     | Overview reordering across the **primary / additional** boundary by keyboard and by real pointer drag (`elementFromPoint` needs layout), the DOM and `overviewOrder` agreeing, and the arrangement surviving a remount; plus Draw mode suppressing native selection on the map's `+`/`-` controls while leaving them clickable and focusable.                                                                                                                                                                                                                                             |
| `embedded-host.mjs`      | Row, Export and Flavour overlays plus the terminal window inside a transformed **and** filtered ancestor, a clipped `overflow: hidden` mount and a scrolled page; the minimized terminal's settings menu opening upward with its colour and opacity controls still hit-testable.                                                                                                                                                                                                                                                                                                          |
| `picker.mjs`             | The compact picker in the same hostile host: overlays stay inside the picker root, two instances coexist, the listbox keyboard pattern works with real focus, the active-descendant id never outlives the option it names (through recycling and requery), virtualised options are in the accessibility tree with their position in the full result set, and one accepted drag produces exactly one host-side addition.                                                                                                                                                                   |
| `picker-scope.mjs`       | Fail-closed scoping, measured at the network layer: a scoped custom flavour issues zero searches before its key mapping arrives, exactly one correctly keyed search after it, and none at all if it fails.                                                                                                                                                                                                                                                                                                                                                                                |
| `picker-scale.mjs`       | 1,000 results produce a bounded number of live row nodes (windowed list), and scrolling recycles rather than accumulates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `export-menu.mjs`        | Both export menus - whole-result Export and selected-files Download - render from one renderer: label and description on **separate lines** with the label the prominent one, the scope stated once in a non-interactive heading, menu roles and 40 px targets, the whole menu inside a 320 px component, and the trigger's `aria-haspopup` / `aria-expanded` correct across every close route.                                                                                                                                                                                           |
| `picker-compact.mjs`     | The compact picker at ~320, ~560 and desktop widths plus a short embedded container: no horizontal overflow, the footer and Add button inside the host and hit-testable, Time/Area collapsed, and the "all filtered" walk - 120 results, zero rows ticked, `getReference()` in query mode, nothing committed until one press yields exactly one bounded reference.                                                                                                                                                                                                                        |

One file here is deliberately **not** a suite and is not in `run.mjs`:
`evidence.mjs` measures each visual fix twice - once with the pre-fix
declarations injected back in, once as shipped - and prints the two numbers. It
reports; it does not gate.

These found real defects. `layout.mjs` is why `.fdb-app` now uses
`grid-template-columns: minmax(0, 1fr)`: the top bar's min-content width was
setting the whole app's width, so at a 320 px viewport the chip row painted out
to x=401. No unit test could have seen that.

## Sandboxes with a pre-installed browser

Some CI images ship a Playwright engine at a fixed path and block the
Playwright CDN. Point the harness at the existing binary rather than skipping:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npm run test:browser:strict -w @freva-org/databrowser
```

Otherwise install the engine once with
`npm exec -w @freva-org/databrowser -- playwright install --with-deps chromium`.

## Adding a suite

Import from `harness.mjs` (`IMPORT_MAP`, `fakeApi`, `serve`, `requireDist`,
`inChromium`, `report`, `overlaps`), end with
`process.exit(report(title, result))`, and add the filename to `run.mjs`. Keep
each check's `detail` populated with the numbers it measured: a failing layout
assertion is only actionable if it prints the rectangles.
