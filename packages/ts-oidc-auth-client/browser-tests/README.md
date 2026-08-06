# Real-browser regression tests

Unit tests run in happy-dom, which does not implement the Fetch redirect rules
these two checks exist to verify. They drive real Chromium against real local
HTTP origins.

```bash
# Local macOS development
npm run browsers:install
npm run build
npm run test:browser

# Full release evidence — Linux CI/Docker only
npm run test:browser:strict
```

They import `../dist`, so `npm run build` has to come first.

## Which engines run where

`browser-tests/browsers.mjs` decides, from `process.platform`, in one place:

|               | `browsers:install` | `test:browser`    | `test:browser:strict`       |
| ------------- | ------------------ | ----------------- | --------------------------- |
| macOS         | chromium, firefox  | chromium, firefox | **refuses to run** (exit 3) |
| Linux / other | all three          | all three         | all three, no skips         |

**WebKit is omitted from local macOS runs** because this project has observed
Playwright/macOS compatibility failures launching it — an engine that will not
start produces no signal. That is this project's choice for its own local
workflow, not a general claim about Playwright on macOS. The run prints one
line saying so. The full three-engine matrix is release evidence and runs on
Linux CI or the Playwright Docker image:

```bash
docker run --rm -it --init --ipc=host \
    -v "$PWD":/w -v /w/node_modules -v /w/dist -w /w \
    mcr.microsoft.com/playwright:v1.62.1-noble \
    bash -lc 'npm ci && npm run build && npm run test:browser:strict'
```

`npm run build` is not optional — the suites import `../dist`, so a clean
checkout without it fails with "dist/ not found" before any browser opens.
`--init` reaps the processes browsers leave behind, `--ipc=host` gives Chromium
a large enough `/dev/shm`, and the anonymous volumes on `node_modules` and
`dist` keep the container's Linux-native dependencies and root-owned build
output out of the host checkout.

Contributors need **Node 22 or 24** (`.nvmrc` pins 24); Node 23 is not
supported by the pinned Vitest version.

On macOS the strict gate **fails immediately** with a message pointing at Linux
CI and the Docker one-liner. It does not launch the broken WebKit binary, and
it never reports a two-engine pass — "the strict gate passed" has to mean the
same thing on every machine.

`npm run browsers:install` only ever ADDS to Playwright's shared cache in
`~/.cache/ms-playwright`. It never uninstalls or prunes: that cache belongs to
every project on the machine, and "this package does not run WebKit here" is
not a reason to delete someone else's copy.

### `BROWSERS` override

`BROWSERS=chromium,firefox` narrows both the install list and the test run, on
any platform, for debugging — including `BROWSERS=webkit` on macOS if you want
to try it. An unknown engine name is an error rather than a silently empty run.

In **strict** mode the override is ignored, with a printed note: the release
matrix is fixed, and an override there could only narrow it into a gate that
reports "strict" while proving less.

`redirect.mjs` proves the credentialed-redirect guard: a
baseline `fetch(..., { redirect: "follow" })` delivers a custom `X-CSRFToken`
header to a cross-origin destination (the browser strips `Authorization`, but
not custom headers), while `auth.fetch` is pinned to `redirect: "error"` and
sends nothing there.

`callback.mjs` proves query-aware callback matching and that the authorization
code is scrubbed from the address bar while a configured static parameter
survives.

## Sandboxes with a pre-installed browser

Some CI sandboxes ship a Playwright browser at a fixed path and block the
Playwright CDN, so `npm run browsers:install` cannot run. Point the harness at
the existing binary instead — this is an escape hatch for the _location_ of a
browser, never a way to skip one:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:browser:strict
```

A browser that still cannot be launched is reported FAIL under
`BROWSER_STRICT=1`, and `prepublishOnly` exits non-zero. That is the intended
behaviour: an engine whose tests did not execute is unverified, and the release
gate must say so rather than pass.
