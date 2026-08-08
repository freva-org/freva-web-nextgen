# Real-browser tests

The unit suite runs in jsdom, which performs **no layout**: every `getBoundingClientRect()` is
`0x0`, `position: fixed` resolves against nothing, and a wrapped line box does not exist. Anything
of that shape - where a line broke, whether two boxes overlap, what an overlay's containing block
turned out to be - is measured in real Chromium instead.

The fixture pages load the built artifacts of both packages through an import map, so what is
measured is the code that ships.

```bash
npm run test:browser        -w @freva-org/databrowser
npm run test:browser:strict -w @freva-org/databrowser
```

`pretest:browser` builds both `dist/` trees first. `test:browser:strict` (`BROWSER_STRICT=1`) turns
"no browser installed" from a skip into a failure - a suite that did not execute proves nothing.

`run.mjs` is the list `test:browser` executes: a suite not in it does not run. Each suite's own
header says what it covers.

## Sandboxes with a pre-installed browser

Some CI images ship an engine at a fixed path and block the Playwright CDN. Point the harness at it
rather than skipping:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npm run test:browser:strict -w @freva-org/databrowser
```

Otherwise: `npm exec -w @freva-org/databrowser -- playwright install --with-deps chromium`.

## Adding a suite

Import from `harness.mjs` (`IMPORT_MAP`, `fakeApi`, `serve`, `requireDist`, `inChromium`, `report`,
`overlaps`), end with `process.exit(report(title, result))`, and add the filename to `run.mjs`. Keep
each check's `detail` populated with the numbers it measured - a failing layout assertion is only
actionable if it prints the rectangles.
