// Real-browser conformance for a built artifact.
//
// The claims these tests settle cannot be settled anywhere else: that a deep link is a file
// rather than a history fallback, that the pages work with JavaScript switched off, that the
// artifact runs under its own Content Security Policy without a violation, and that the
// accessibility target holds on rendered output rather than on markup we hoped was right.
//
// Strict mode (`BROWSER_STRICT=1`) makes a browser that will not launch a failure rather than a
// skip.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const REPO = resolve(PKG, "..", "..");
const STRICT = process.env.BROWSER_STRICT === "1";

const results = [];
let failures = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push(`  ok   ${name}`);
    })
    .catch((error) => {
      failures += 1;
      results.push(`  FAIL ${name}\n       ${error.message.split("\n")[0]}`);
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function build(sourceRoot, config, out, extraArgs = []) {
  execFileSync(
    process.execPath,
    [
      join(PKG, "bin", "freva-portal-builder.mjs"),
      "build",
      "--source-root",
      sourceRoot,
      "--config",
      config,
      "--out",
      out,
      "--quiet",
      ...extraArgs,
    ],
    { stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
  );
}

async function launchChromium(playwright) {
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  try {
    return await playwright.chromium.launch({ args });
  } catch (error) {
    const pinned = process.env.FREVA_PORTAL_CHROMIUM ?? "/opt/pw-browsers/chromium";
    if (existsSync(pinned)) return playwright.chromium.launch({ args, executablePath: pinned });
    throw error;
  }
}

const work = mkdtempSync(join(tmpdir(), "portal-browser-"));
const out = join(work, "site");

// Prepared STAC materials for the suite, or nothing. A build consumes the directory it is TOLD
// about, never looking around for one, so the suite answers the same question the developer does:
// `FREVA_PORTAL_STAC_MATERIALS` for CI that prepared them somewhere, otherwise the sibling
// workspace for a developer who ran the preparation locally, mirroring `tests/helpers/site.ts`.
// Without it the example portal enables `stac-browser`, no materials are passed, and the build
// fails with FP1604 before a single check runs.
function preparedStacMaterials() {
  const fromEnvironment = process.env.FREVA_PORTAL_STAC_MATERIALS;
  if (fromEnvironment && existsSync(join(fromEnvironment, "materials.json")))
    return fromEnvironment;
  const sibling = resolve(PKG, "..", "stac-browser", "materials");
  return existsSync(join(sibling, "materials.json")) ? sibling : undefined;
}

const STAC_MATERIALS = preparedStacMaterials();
if (!STAC_MATERIALS) {
  const message =
    "no prepared STAC materials; run 'npm run prepare -w @freva-org/stac-browser' or set " +
    "FREVA_PORTAL_STAC_MATERIALS. The example portal enables the component, so the build cannot " +
    "proceed without them.";
  if (STRICT) throw new Error(`[browser] ${message}`);
  console.log(`[browser] skipped - ${message}`);
  process.exit(0);
}

try {
  build(
    join(REPO, "examples", "full-portal"),
    join(REPO, "examples", "full-portal", "portal.yaml"),
    out,
    ["--effective-at", "2026-01-07T12:00:00Z", "--stac-materials", STAC_MATERIALS],
  );

  let playwright;
  try {
    playwright = await import("playwright");
  } catch (error) {
    const message = `playwright is not installed: ${error.message}`;
    if (STRICT) throw new Error(message);
    console.log(`[browser] skipped - ${message}`);
    process.exit(0);
  }

  const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));
  const { serveStac } = await import(join(PKG, "browser-tests", "fixtures", "stac", "catalog.mjs"));
  const { ROOT_VIEW, CHILD_VIEW } = await import(
    join(PKG, "browser-tests", "fixtures", "stac", "upstream-a11y.mjs")
  );
  const server = createPreviewServer({ dir: out, port: 0 });
  // A STAC API in front of the artifact server. The example portal's `stac` service points at
  // `/api/freva-nextgen/stac/`, and with nothing answering there the application renders its own
  // error state while still putting children in the mount and satisfying the readiness attribute.
  // Every question worth asking about this component is about what happens once a catalogue
  // LOADS. Prepended rather than routed through the artifact server, so the fixture cannot be
  // mistaken for something the build published: nothing under `/api/` exists in `out`.
  const stacRequests = [];
  const artifactListeners = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    const origin = `http://127.0.0.1:${server.address()?.port ?? 0}`;
    if (serveStac(request, response, origin, stacRequests)) return;
    for (const listener of artifactListeners) listener.call(server, request, response);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/site/`;

  let browser;
  let crossOriginServer;
  try {
    browser = await launchChromium(playwright);
  } catch (error) {
    const message = `chromium would not launch: ${error.message}`;
    if (STRICT) throw new Error(message);
    console.log(`[browser] skipped - ${message}`);
    server.close();
    process.exit(0);
  }

  // A SECOND artifact, whose catalogue is on an origin of its own. The example portal's catalogue
  // is same-origin, where `'self'` grants a thumbnail whatever the derivation does, so it cannot
  // answer this question. This one names an absolute origin, and the check below asks a real
  // browser - under the policy the preview server serves out of this artifact's own
  // `host-policy.json` - whether an image on that origin loads. The origin is never reached: the
  // request is fulfilled by Playwright, which is what makes the test exact, because CSP is
  // enforced in the renderer BEFORE a request reaches the network and a blocked image never
  // arrives at the handler at all.
  const CROSS_ORIGIN = "https://catalog.example.test";
  const crossOriginRoot = join(work, "cross-origin");
  const crossOriginOut = join(work, "cross-origin-site");
  mkdirSync(crossOriginRoot, { recursive: true });
  const MARK =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>\n';
  writeFileSync(join(crossOriginRoot, "logo.svg"), MARK);
  writeFileSync(join(crossOriginRoot, "favicon.svg"), MARK);
  writeFileSync(
    join(crossOriginRoot, "home.yaml"),
    [
      "schemaVersion: 1",
      "title: Cross-origin catalogue",
      "blocks:",
      "  - type: hero",
      "    heading: Catalogue",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(crossOriginRoot, "portal.yaml"),
    [
      "schemaVersion: 1",
      "site:",
      "  id: cross-origin",
      "  title: Cross-origin catalogue",
      "  language: en",
      "  canonicalUrl: https://portal.example.org/",
      "  identity:",
      "    logo: ./logo.svg",
      "    favicon: ./favicon.svg",
      "theme:",
      "  preset: default",
      "landings:",
      "  home:",
      "    path: /",
      "    source: ./home.yaml",
      "services:",
      "  publicCatalog:",
      "    kind: stac",
      `    catalogUrl: ${CROSS_ORIGIN}/stac/`,
      "components:",
      "  catalog:",
      "    kind: stac-browser",
      "    enabled: true",
      "    service: publicCatalog",
      "    route: /catalog/",
      "",
    ].join("\n"),
  );
  build(crossOriginRoot, join(crossOriginRoot, "portal.yaml"), crossOriginOut, [
    "--stac-materials",
    STAC_MATERIALS,
  ]);
  crossOriginServer = createPreviewServer({ dir: crossOriginOut, port: 0 });
  await new Promise((done) => crossOriginServer.listen(0, "127.0.0.1", done));
  const crossOriginBase = `http://127.0.0.1:${crossOriginServer.address().port}/`;

  const axeSource = readFileSync(require_.resolve("axe-core/axe.min.js"), "utf8");

  const AXE_URL = `${base}__axe-core.js`;

  const withPage = async (fn, contextOptions = {}) => {
    const context = await browser.newContext(contextOptions);
    // The scanner is served from the page's own origin, so the artifact's real CSP stays in force
    // during the accessibility pass rather than being relaxed for the convenience of the harness.
    await context.route(AXE_URL, (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript", body: axeSource }),
    );
    const violations = [];
    const page = await context.newPage();
    page.on("console", (message) => {
      const text = message.text();
      if (/Content Security Policy|Refused to/i.test(text)) violations.push(text);
    });
    page.on("pageerror", (error) => violations.push(`pageerror: ${error.message}`));
    try {
      return await fn(page, violations);
    } finally {
      await context.close();
    }
  };

  // routing
  await check("a deep link loads directly, with no SPA fallback", () =>
    withPage(async (page) => {
      const response = await page.goto(`${base}docs/guide/`, { waitUntil: "load" });
      assert(response.status() === 200, `expected 200, got ${response.status()}`);
      assert(
        (await page.locator("h1").first().innerText()) === "Guide",
        "the guide page did not render its own heading",
      );
      assert(
        (await page.locator("nav.portal-toc a").count()) > 0,
        "the table of contents is missing",
      );
    }),
  );

  await check("an unknown route returns the generated 404", () =>
    withPage(async (page) => {
      const response = await page.goto(`${base}nope/`, { waitUntil: "load" });
      assert(response.status() === 404, `expected 404, got ${response.status()}`);
      assert(
        (await page.locator("h1").first().innerText()).includes("not found"),
        "the 404 document did not render",
      );
    }),
  );

  await check("every status document renders in the shell, with the mark", () =>
    withPage(async (page) => {
      // A host points `error_page 503` at a file; if that file is not a real portal page, the
      // worst moment on the site is also the ugliest.
      for (const code of [400, 403, 429, 500, 503, 504]) {
        await page.goto(`${base}${code}.html`, { waitUntil: "load" });
        assert(
          (await page.locator(`[data-portal-status="${code}"]`).count()) === 1,
          `${code}.html did not render its status section`,
        );
        // TWO images, not one, and named rather than counted: the template exports the artwork's
        // first frame beside the animation as the still alternative for a reduced-motion reader,
        // so a page that dropped it for a drawn substitute would still fail.
        assert(
          (await page.locator(".portal-status-mark img.portal-status-logo").count()) === 1 &&
            (await page.locator(".portal-status-mark img.portal-status-logo-still").count()) === 1,
          `${code}.html is missing the Freva mark, or its still frame`,
        );
        assert(
          (await page.locator("header.portal-header").count()) === 1 &&
            (await page.locator("footer.portal-footer").count()) === 1,
          `${code}.html is not in the portal shell`,
        );
        const home = await page.locator(".portal-status-actions a").getAttribute("href");
        const expected = new URL(base).pathname;
        assert(home === expected, `${code}.html links home to ${home}, expected ${expected}`);
      }
    }),
  );

  await check("the chrome is the deployment's colour, flat and opaque", () =>
    withPage(async (page) => {
      // Three chrome experiments - translucency, a compensated fill, a glass material with a
      // derived darker colour - were rejected, so this is the guard that they do not come back:
      // both bars are the accent itself, painted flat.
      await page.goto(`${base}docs/showcase/`, { waitUntil: "load" });
      const seen = await page.evaluate(() => {
        const accent = getComputedStyle(document.documentElement)
          .getPropertyValue("--accent")
          .trim();
        const of = (selector) => {
          const cs = getComputedStyle(document.querySelector(selector));
          return {
            background: cs.backgroundColor,
            image: cs.backgroundImage,
            backdrop: cs.backdropFilter,
            colour: cs.color,
          };
        };
        const rootValue = (name) =>
          getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return {
          accent,
          strong: rootValue("--footer-strong"),
          header: of(".portal-header"),
          footer: of(".portal-footer"),
        };
      });

      for (const [name, bar] of Object.entries({
        header: seen.header,
        footer: seen.footer,
      })) {
        assert(bar.backdrop === "none", `${name} still has a backdrop filter: ${bar.backdrop}`);
        assert(bar.image === "none", `${name} still has a gradient layer: ${bar.image}`);
        assert(
          /^rgba?\(\s*\d+,\s*\d+,\s*\d+\s*\)$/.test(bar.background.trim()),
          `${name} is not an opaque flat fill: ${bar.background}`,
        );
      }
      // The header's own text is white; the footer's body text is the design's quieter white,
      // which is the hierarchy the original had - its emphasis colour was `#ffffff` and its body
      // text was not.
      assert(
        seen.header.colour === "rgb(255, 255, 255)",
        `header text is not white: ${seen.header.colour}`,
      );
      assert(
        ["#ffffff", "#fff"].includes(seen.strong),
        `--footer-strong is not white: ${seen.strong}`,
      );
      // The footer's body text is the design's quieter white rather than pure white, so it is
      // checked as a near-white rather than by exact value.
      const channels = (seen.footer.colour.match(/\d+/g) ?? []).map(Number);
      assert(
        channels.length >= 3 && channels.slice(0, 3).every((c) => c >= 200),
        `footer text is not a white: ${seen.footer.colour}`,
      );
    }),
  );

  await check("a hosted application gets a portal-level overlay layer", () =>
    withPage(async (page) => {
      // The layer the Data Browser's terminal window lives in. It is outside `.portal-main`,
      // which is contained, so a window in it is bounded by the viewport rather than by the
      // widget - and it catches no pointer events of its own, so a portal that hosts nothing is
      // unaffected by it.
      await page.goto(`${base}data/`, { waitUntil: "load" });
      const layer = await page.evaluate(() => {
        const root = document.getElementById("portal-overlay-root");
        if (!root) return null;
        const main = document.querySelector(".portal-main");
        const cs = getComputedStyle(root);
        const box = root.getBoundingClientRect();
        return {
          insideMain: main ? main.contains(root) : null,
          position: cs.position,
          pointerEvents: cs.pointerEvents,
          covers: Math.round(box.width) === innerWidth && Math.round(box.height) === innerHeight,
        };
      });
      assert(layer !== null, "there is no #portal-overlay-root");
      assert(layer.insideMain === false, "the overlay layer is inside the contained region");
      assert(layer.position === "fixed", `the overlay layer is ${layer.position}`);
      assert(layer.pointerEvents === "none", "the overlay layer swallows pointer events");
      assert(layer.covers, "the overlay layer does not cover the viewport");
    }),
  );

  await check("the Freva badge stays on the page at every width and on every route", () =>
    withPage(async (page) => {
      // The badge is `position: fixed` at `--fb-inset`, which the portal computes so the bird
      // lines up with the page's own gutter: `gutter - the disc's offset inside the artwork`. That
      // goes negative easily - the disc sits ~50px into the badge's box, the gutter is
      // `clamp(16px, 2.4vw, 48px)` plus centring, and below the width where centring begins there
      // is none - walking the badge off the left edge, -15px at 1440, -23px at 1100 and -33px on a
      // phone. The mark survives it because its artwork carries transparent margin; the open panel
      // starts at its own edge and does not. So: geometry, on all three route kinds and three
      // widths - nothing the badge draws may begin left of the viewport.
      for (const width of [1440, 1100, 700]) {
        await page.setViewportSize({ width, height: 900 });
        for (const [kind, path] of [
          ["landing", ""],
          ["document", "docs/guide/"],
          ["application", "data/"],
        ]) {
          await page.goto(`${base}${path}`, { waitUntil: "load" });
          await page.waitForTimeout(500);
          const seen = await page.evaluate(() => {
            const root = document.querySelector(".fb");
            if (!root) return null;
            const mark = root.querySelector(".badge");
            root.querySelector(".badge")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            const pop = root.querySelector(".pop");
            const rect = (n) => (n ? Math.round(n.getBoundingClientRect().left) : null);
            return {
              inset: getComputedStyle(root).getPropertyValue("--fb-inset").trim(),
              markLeft: rect(mark),
              popLeft: pop && pop.getBoundingClientRect().width > 10 ? rect(pop) : null,
            };
          });
          assert(seen !== null, `${kind}: the badge is not on the page`);
          assert(
            seen.markLeft >= 0,
            `${kind} at ${width}px: the badge starts at ${seen.markLeft}px, off the left edge`,
          );
          assert(
            seen.popLeft === null || seen.popLeft >= 0,
            `${kind} at ${width}px: the badge panel starts at ${seen.popLeft}px, off the left edge`,
          );
        }
      }
    }),
  );

  // JavaScript switched off
  await check("landing, navigation, prose and search work with JavaScript disabled", () =>
    withPage(
      async (page) => {
        await page.goto(base, { waitUntil: "load" });
        assert((await page.locator("header.portal-header a").count()) > 0, "no header links");
        assert((await page.locator("footer.portal-footer").count()) === 1, "no footer");
        assert(
          (await page.locator(".portal-hero h1").innerText()).length > 0,
          "the hero heading did not render",
        );
        assert(
          (await page.locator("section.portal-content-block .portal-prose").count()) > 0,
          "the prose block did not render",
        );
        // The search handoff is a plain GET form, so it still works.
        const action = await page.locator("form.portal-search-form").getAttribute("action");
        assert(action === "/site/data/", `unexpected search action ${action}`);
        await page.goto(`${base}docs/guide/`, { waitUntil: "load" });
        // Two SVGs, one per palette: mermaid bakes its colours in at build time, so the page
        // carries both and the stylesheet shows the one that matches. Exactly one is visible,
        // which the diagram check asserts; here the point is only that scriptless documents get
        // the diagram at all.
        assert(
          (await page.locator("figure.portal-diagram svg").count()) === 2,
          "the build-time diagram is not in the document",
        );
        assert((await page.locator(".katex").count()) > 0, "build-time mathematics is missing");
      },
      { javaScriptEnabled: false },
    ),
  );

  await check("the browser makes no settings or content API request", () =>
    withPage(async (page) => {
      const requests = [];
      page.on("request", (request) => requests.push(request.url()));
      for (const path of ["", "docs/guide/", "workshop/"]) {
        await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
      }
      const foreign = requests.filter((url) => !url.startsWith(`http://127.0.0.1:${port}/`));
      assert(foreign.length === 0, `unexpected off-artifact requests: ${foreign.join(", ")}`);
      const suspicious = requests.filter((url) =>
        /\/(api|settings|ui-config|portal-config|content)\b/.test(url),
      );
      assert(
        suspicious.length === 0,
        `the page asked a service what the site is: ${suspicious.join(", ")}`,
      );
    }),
  );

  // CSP
  await check("every page runs under the artifact's own CSP without a violation", () =>
    withPage(async (page, violations) => {
      for (const path of ["", "docs/guide/", "data/", "catalog/", "workshop/"]) {
        await page.goto(`${base}${path}`, { waitUntil: "load" });
      }
      assert(violations.length === 0, `CSP or page errors: ${violations.slice(0, 3).join(" | ")}`);
    }),
  );

  // islands
  /**
   * Measure a mounted application region. "The loading boundary disappeared" and "the URL changed"
   * are both true of a mount that rendered nothing at all, so neither is evidence on its own. This
   * measures the region: real size, real visible descendants, real visible controls, and the
   * component's own chrome in the rendered text.
   */
  const measureMount = (page, selector) =>
    page.evaluate((sel) => {
      const mount = document.querySelector(sel);
      if (!mount) return { present: false };
      const rect = mount.getBoundingClientRect();
      const visible = (el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          box.width > 4 &&
          box.height > 4 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };
      const boundary = mount.querySelector("[data-portal-boundary]");
      return {
        present: true,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visibleElements: [...mount.querySelectorAll("*")].filter(visible).length,
        visibleControls: [
          ...mount.querySelectorAll("input, button, select, textarea, [role=button]"),
        ].filter(visible).length,
        boundaryStillShown: Boolean(boundary && visible(boundary)),
        text: (mount.innerText || "").replace(/\s+/g, " ").trim(),
      };
    }, selector);

  const mountProblems = (
    m,
    { minHeight = 240, minVisible = 20, minControls = 3, needles = [] },
  ) => {
    if (!m.present) return ["the mount is not in the document"];
    const problems = [];
    if (m.boundaryStillShown) problems.push("the no-JavaScript boundary is still on screen");
    if (m.height <= minHeight) problems.push(`the mount measured ${m.width}x${m.height}`);
    if (m.visibleElements < minVisible) problems.push(`${m.visibleElements} visible elements`);
    if (m.visibleControls < minControls) problems.push(`${m.visibleControls} visible controls`);
    for (const needle of needles) {
      if (!m.text.toLowerCase().includes(needle.toLowerCase())) {
        problems.push(`does not show '${needle}'`);
      }
    }
    return problems;
  };

  /**
   * Wait for a mount to actually render, then return what was measured. Polled rather than sampled
   * once: an application that has signalled readiness may still be painting, and a single snapshot
   * would turn a slow frame into a failure. A mount that never renders still fails, with the
   * measurement in the message.
   */
  const renderedMount = async (page, selector, options = {}) => {
    let m = { present: false };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      m = await measureMount(page, selector);
      if (mountProblems(m, options).length === 0) return m;
      await page.waitForTimeout(250);
    }
    throw new Error(
      `${selector}: ${mountProblems(m, options).join("; ")}` +
        (m.present ? ` - it shows '${m.text.slice(0, 120)}'` : ""),
    );
  };

  await check("the Data Browser mount contains visible application UI", () =>
    withPage(async (page) => {
      await page.goto(`${base}data/`, { waitUntil: "load" });
      await page.waitForFunction(
        () => !document.querySelector("[data-portal-boundary]"),
        undefined,
        {
          timeout: 20_000,
        },
      );
      // The fixture points at a service this harness does not run, so what must be on screen is
      // the component's own chrome and its failure state, not a blank region.
      await page.waitForFunction(
        () => /retry|unavailable|not found/i.test(document.body.innerText),
        undefined,
        { timeout: 20_000 },
      );
      await renderedMount(page, "#portal-databrowser-mount", {
        needles: ["filter", "browse", "overview"],
      });
      // And the same at a narrow viewport, where a collapsed panel could hide everything without
      // any of the counts above changing.
      await page.setViewportSize({ width: 390, height: 844 });
      await renderedMount(page, "#portal-databrowser-mount", {
        minVisible: 12,
        needles: ["browse"],
      });
    }),
  );

  await check("the Data Browser island mounts and normalizes a landing search", () =>
    withPage(async (page) => {
      await page.goto(`${base}data/?siv=1&q=temperature&flavour=freva&project=example`, {
        waitUntil: "load",
      });
      await page.waitForFunction(
        () => !document.querySelector("[data-portal-boundary]"),
        undefined,
        { timeout: 20_000 },
      );
      const search = await page.evaluate(() => window.location.search);
      assert(!search.includes("siv="), `the intent version survived in ${search}`);
      assert(!search.includes("q="), `the raw free text survived in ${search}`);
      assert(search.includes("project=example"), `the facet was lost from ${search}`);
      assert(search.includes("file="), `free text did not become a facet in ${search}`);
    }),
  );

  await check("the landing search says it is working, and knows what the values mean", () =>
    withPage(async (page) => {
      // A deliberately slow facet index, because the point of the check is the gap: the first
      // keystroke costs a round trip, and until it lands the box has nothing to show.
      await page.route("**/metadata-search/**", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            facets: { project: ["cmip5", 120, "cmip6", 90], variable: ["tas", 300] },
          }),
        });
      });
      await page.goto(base, { waitUntil: "load" });

      await page.fill(".portal-search-input", "cmip");
      await page.waitForSelector('.portal-search-field[data-portal-suggesting="true"]', {
        timeout: 5_000,
      });
      const busy = await page.getAttribute(".portal-search-input", "aria-busy");
      assert(busy === "true", `the input did not announce itself busy (aria-busy=${busy})`);
      // The mark fades in after a beat, so that a locally-ranked keystroke never flashes one;
      // waiting for it to become visible is the assertion.
      const opacity = () =>
        page.evaluate(() => {
          const mark = document.querySelector(".portal-search-suggesting");
          return mark ? Number.parseFloat(getComputedStyle(mark).opacity) : 0;
        });
      await page.waitForFunction(
        () => {
          const mark = document.querySelector(".portal-search-suggesting");
          return mark !== null && Number.parseFloat(getComputedStyle(mark).opacity) > 0.2;
        },
        undefined,
        { timeout: 5_000 },
      );
      assert((await opacity()) > 0.2, "the waiting mark is not visible");

      // The rows carry the Data Browser's own descriptions ...
      await page.waitForSelector(".portal-suggest-item", { timeout: 10_000 });
      const described = await page.evaluate(() =>
        [...document.querySelectorAll(".portal-suggest-item")].map((li) => ({
          value: li.querySelector(".portal-suggest-value")?.textContent ?? "",
          desc: li.querySelector(".portal-suggest-desc")?.textContent ?? "",
        })),
      );
      const cmip5 = described.find((row) => row.value === "cmip5");
      assert(cmip5, `cmip5 was not offered: ${JSON.stringify(described)}`);
      assert(
        /coupled model intercomparison/i.test(cmip5.desc),
        `the shared description is missing from the row: ${JSON.stringify(cmip5)}`,
      );
      // ... and the marker clears once they are on screen.
      assert(
        (await page.locator('.portal-search-field[data-portal-suggesting="true"]').count()) === 0,
        "the waiting mark outlived the lookup",
      );

      // Searching by what a value MEANS finds it, which is the whole reason the descriptions are
      // here rather than only in the Data Browser.
      await page.fill(".portal-search-input", "");
      await page.fill(".portal-search-input", "Coupled Model Intercomparison Project 5");
      await page.waitForSelector(".portal-suggest-item", { timeout: 10_000 });
      const byMeaning = await page.evaluate(() =>
        [...document.querySelectorAll(".portal-suggest-value")].map((n) => n.textContent),
      );
      assert(byMeaning.includes("cmip5"), `a description query found ${JSON.stringify(byMeaning)}`);

      // Choosing a row navigates without a submit event, so it sets the busy marker itself;
      // recorded inside the page, because the document is gone by the time anything else can look.
      await page.evaluate(() => {
        document.querySelector(".portal-suggest-item").addEventListener("mousedown", () => {
          const form = document.querySelector(".portal-search-form");
          sessionStorage.setItem(
            "portal-probe",
            JSON.stringify({
              busy: form.dataset.portalSearching ?? null,
              spinner: getComputedStyle(document.querySelector(".portal-search-spinner")).display,
            }),
          );
        });
      });
      await page.evaluate(() =>
        document
          .querySelector(".portal-suggest-item")
          .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
      );
      await page.waitForFunction(() => sessionStorage.getItem("portal-probe") !== null, undefined, {
        timeout: 5_000,
      });
      const probe = JSON.parse(await page.evaluate(() => sessionStorage.getItem("portal-probe")));
      assert(probe.busy === "true", "choosing a row left the form looking idle");
      assert(probe.spinner === "block", `the submit spinner stayed ${probe.spinner}`);
    }),
  );

  /** The signal the island publishes only after upstream imported and rendered. */
  const waitForStacReady = async (page) => {
    await page.waitForSelector('#stac-browser-mount[data-portal-stac-state="ready"]', {
      state: "attached",
      timeout: 30_000,
    });
    // And the DOM upstream actually produced, so a readiness attribute alone cannot be what passes
    // the test.
    const children = await page.evaluate(
      () => document.getElementById("stac-browser-mount")?.childElementCount ?? 0,
    );
    assert(children > 0, "the catalog browser reported ready with an empty mount");
    // Readiness plus a non-empty mount is still not evidence that anything is on screen, so the
    // region itself is measured.
    await renderedMount(page, "#stac-browser-mount", { minControls: 1 });
  };

  // Diagrams: centred, and following the theme. With no rule for `.portal-diagram` a 267px drawing
  // sits hard-left in a 1072px figure, and mermaid writes its palette into the SVG at build time,
  // so a diagram rendered once shows white boxes with black labels on a dark page. Checked as a
  // reader meets it - measured gaps and computed colours - rather than as the presence of a rule.
  await check("a diagram is centred in its figure and follows the theme", () =>
    withPage(async (page) => {
      await page.goto(`${base}docs/guide/`, { waitUntil: "load" });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((mode) => {
          document.documentElement.dataset.theme = mode;
        }, theme);
        await page.waitForTimeout(60);
        const m = await page.evaluate(() => {
          const figure = document.querySelector(".portal-diagram");
          if (!figure) return null;
          const copies = [...figure.querySelectorAll(".portal-diagram-copy")];
          const shown = copies.filter((c) => getComputedStyle(c).display !== "none");
          const svg = (shown[0] ?? figure).querySelector("svg");
          const f = figure.getBoundingClientRect();
          const v = svg.getBoundingClientRect();
          const label = svg.querySelector(".nodeLabel, .label, text");
          const paint = label ? getComputedStyle(label) : null;
          return {
            copies: copies.length,
            shownCount: shown.length,
            shownClass: shown[0]?.className ?? "",
            left: Math.round(v.left - f.left),
            right: Math.round(f.right - v.right),
            fits: v.width <= f.width + 1,
            ink: paint ? paint.fill || paint.color : null,
          };
        });
        assert(m, "the guide page has no diagram to measure");
        // Centred: the two gaps agree to within a pixel of rounding.
        assert(
          Math.abs(m.left - m.right) <= 2,
          `${theme}: the diagram sits ${m.left}px from the left and ${m.right}px from the right`,
        );
        assert(m.fits, `${theme}: the diagram overflows its figure`);
        // Exactly one palette is on the page at a time - two would be the same diagram twice,
        // including for a screen reader.
        assert(m.copies === 2, `${theme}: ${m.copies} palette(s) emitted, expected 2`);
        assert(m.shownCount === 1, `${theme}: ${m.shownCount} copies visible`);
        assert(
          m.shownClass.includes(`portal-diagram-${theme}`),
          `${theme}: the visible copy is ${m.shownClass}`,
        );
        // And the ink actually differs between the two, which is the whole point: a diagram that
        // rendered dark markup but painted the light palette would pass every check above.
        const channel = Number(/rgb\((\d+)/.exec(m.ink ?? "")?.[1] ?? "-1");
        assert(channel >= 0, `${theme}: could not read the label colour (${m.ink})`);
        if (theme === "light") assert(channel < 120, `light labels paint ${m.ink}`);
        else assert(channel > 120, `dark labels paint ${m.ink}`);
      }
    }),
  );

  // Every other route asks for nothing STAC. The embed is one route's feature, and the evidence
  // has to be network traffic rather than a module graph: an artifact can be correctly partitioned
  // and still preload, prefetch or lazily import the third-party bundle from a page with no
  // catalogue on it. Nobody would notice - the page works - and every visitor to the Data Browser
  // would pay for a megabyte of an application they never see.
  await check("no route but the catalogue asks for a STAC asset", () =>
    withPage(async (page) => {
      const asked = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (/\/stac\//.test(url.pathname)) asked.push(url.pathname);
      });
      for (const route of ["", "data/", "docs/guide/", "404.html"]) {
        await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
        // A moment for anything speculative - a preload, a prefetch, an idle-time import.
        await page.waitForTimeout(400);
      }
      assert(
        asked.length === 0,
        `pages other than the catalogue requested ${asked.length} STAC asset(s): ` +
          `${[...new Set(asked)].slice(0, 4).join(", ")}`,
      );
      // And the same pages must not even name one, so a future change that adds a preload tag
      // rather than a request is caught too.
      await page.goto(`${base}data/`, { waitUntil: "load" });
      const references = await page.evaluate(() =>
        [...document.querySelectorAll("script[src],link[href]")]
          .map((element) => element.getAttribute("src") ?? element.getAttribute("href") ?? "")
          .filter((value) => value.includes("/stac/")),
      );
      assert(references.length === 0, `the Data Browser page references ${references.join(", ")}`);
    }),
  );

  await check("the STAC island mounts on its generated route and uses hash routing", () =>
    withPage(async (page) => {
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForFunction(() => Boolean(window.STAC_BROWSER_CONFIG), undefined, {
        timeout: 20_000,
      });
      const config = await page.evaluate(() => ({
        historyMode: window.STAC_BROWSER_CONFIG.historyMode,
        pathPrefix: window.STAC_BROWSER_CONFIG.pathPrefix,
        allowExternalAccess: window.STAC_BROWSER_CONFIG.allowExternalAccess,
      }));
      assert(config.historyMode === "hash", `historyMode is ${config.historyMode}`);
      assert(config.pathPrefix === "/site/catalog/", `pathPrefix is ${config.pathPrefix}`);
      assert(config.allowExternalAccess === false, "external catalogs are not denied");
      // A reload of the component route is served by the generated file itself, with no SPA
      // fallback from the host. Navigating away first makes the hash form a real navigation rather
      // than a same-document fragment change.
      await page.goto(base, { waitUntil: "load" });
      const response = await page.goto(`${base}catalog/#/collections/example`, {
        waitUntil: "load",
      });
      assert(
        response !== null && response.status() === 200,
        "the hash route did not load as a file",
      );
      assert(
        (await page.locator("#stac-browser-mount").count()) === 1,
        "the component route did not render its mount",
      );
    }),
  );

  await check("the catalogue actually loads, and readiness means that", () =>
    withPage(async (page) => {
      // With nothing answering at the configured catalogue URL the application renders its own
      // error state and the readiness attribute is satisfied by the mount having acquired
      // children. That is the readiness signal this check replaces: it asserts the fixture's own
      // content is on the page and that the application asked the API for the root document.
      stacRequests.length = 0;
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      // The catalogue's own children, which only a parsed document can produce. The root's TITLE
      // is deliberately not the probe here: the portal projects its own onto the root, so a check
      // that waited for the API's title would be asserting that the projection had failed.
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Absolute Collection"),
        undefined,
        { timeout: 30_000 },
      );
      assert(
        stacRequests.some((path) => path.startsWith("/api/freva-nextgen/stac/")),
        `the application never asked the catalogue API: ${JSON.stringify(stacRequests)}`,
      );
      // The catalogue's two children are what a loaded root shows, so their titles are the
      // evidence that a document was parsed rather than an error rendered.
      const text = await page.locator("#stac-browser-mount").innerText();
      for (const title of ["Absolute Collection", "Relative Collection"]) {
        assert(text.includes(title), `the loaded root does not show "${title}"`);
      }
    }),
  );

  await check("a relative catalogue link resolves against the document that supplied it", () =>
    withPage(async (page) => {
      // The fixture's root advertises one child with an absolute href and one document-relative.
      // Both name a document under the catalogue; a relative link resolved against the PORTAL page
      // would be fetched from `/site/catalog/collections/relative` - the artifact server, a 404.
      stacRequests.length = 0;
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Relative Collection"),
        undefined,
        { timeout: 30_000 },
      );
      const link = page
        .locator("#stac-browser-mount a", { hasText: "Relative Collection" })
        .first();
      await link.click();
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Description of Relative Collection"),
        undefined,
        { timeout: 30_000 },
      );
      assert(
        stacRequests.includes("/api/freva-nextgen/stac/collections/relative"),
        `the relative child was not fetched from the catalogue: ${JSON.stringify(stacRequests)}`,
      );
    }),
  );

  await check("the portal's catalogue introduction appears at the root and nowhere else", () =>
    withPage(async (page) => {
      // The introduction is portal-owned markup rendered by the portal's own content pipeline into
      // a region of the component route, and it belongs to the ROOT catalogue. The route document
      // is one file for every view, so "root only" has to survive normal navigation, a hash change,
      // back and forward, a deep link and a reload - all five exercised here, in that order,
      // against a catalogue that actually loads. The signal is `data-portal-stac-view` on the root
      // element, derived from upstream's router state via the `historyMode` and `pathPrefix` the
      // adapter itself configured, and shown only once the configured catalogue has loaded.
      const intro = page.locator("[data-portal-stac-intro]");

      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForFunction(() => document.documentElement.dataset.portalStacView === "root", {
        timeout: 30_000,
      });
      // The root view is what takes the introduction in - `PortalIntro` moves it into the metadata
      // column when that view mounts - and it is hidden until then, so a deep link to an item never
      // flashes the catalogue's introduction in the document's own flow. `root` is published as the
      // document is preprocessed, before the view has painted, so this waits for the placement.
      await page.waitForFunction(
        () => Boolean(document.querySelector("[data-portal-stac-intro]")?.closest("#stac-browser")),
        undefined,
        { timeout: 30_000 },
      );
      assert(await intro.isVisible(), "the introduction was not shown at the catalogue root");
      const introText = await intro.innerText();
      assert(
        introText.includes("presentation-only text supplied by the portal"),
        `the introduction region is empty: ${JSON.stringify(introText.slice(0, 120))}`,
      );

      // A navigation into a collection. The listing's own child documents arrive after the root, so
      // the link is waited for rather than assumed to be there when the root has painted.
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Absolute Collection"),
        undefined,
        { timeout: 30_000 },
      );
      await page
        .locator("#stac-browser-mount a", { hasText: "Absolute Collection" })
        .first()
        .click();
      await page.waitForFunction(
        () => document.documentElement.dataset.portalStacView === "child",
        { timeout: 30_000 },
      );
      assert(!(await intro.isVisible()), "the introduction stayed visible on a collection");
      const deepLink = page.url();
      assert(deepLink !== `${base}catalog/`, `navigation did not change the URL: ${deepLink}`);

      // Back to the root.
      await page.goBack();
      await page.waitForFunction(() => document.documentElement.dataset.portalStacView === "root", {
        timeout: 30_000,
      });
      assert(await intro.isVisible(), "the introduction did not return on going back");

      // The deep link, loaded cold: this is the case a post-render hide would flash.
      await page.goto(deepLink, { waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForFunction(
        () => document.documentElement.dataset.portalStacView === "child",
        { timeout: 30_000 },
      );
      assert(!(await intro.isVisible()), "a deep-linked collection showed the root introduction");

      // And a reload, which is the case a signal derived from in-page navigation would lose.
      await page.reload({ waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForFunction(
        () => document.documentElement.dataset.portalStacView === "child",
        { timeout: 30_000 },
      );
      assert(!(await intro.isVisible()), "a reloaded collection showed the root introduction");

      // Back at the root, from cold.
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForFunction(() => document.documentElement.dataset.portalStacView === "root", {
        timeout: 30_000,
      });
      assert(await intro.isVisible(), "the introduction did not return at the root");
    }),
  );

  await check("the embed wears the portal's palette, and stays inside its box", () =>
    withPage(async (page) => {
      // `freva-stac.css` maps upstream's own `--sb-*` hooks onto the shell's tokens and contains
      // Bootstrap's negative row margins. Scoped to class names the route template never emits
      // (`.portal-stac-mount`, `.portal-feature-stac`) every rule in it is inert: the embed renders
      // in upstream's palette and its header bar runs past both window edges. Both halves are
      // asserted, because rescoping to `#stac-browser-mount` alone fixes the containment and leaves
      // the theming losing on source order to upstream's own mount-time stylesheet, which declares
      // the same properties on the same element. The class is what wins it.
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Absolute Collection"),
        undefined,
        { timeout: 30_000 },
      );

      const seen = await page.evaluate(() => {
        const mount = document.getElementById("stac-browser-mount");
        const shell = getComputedStyle(document.documentElement);
        const outside = [...document.querySelectorAll("#stac-browser-mount *")].filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && (box.left < -0.5 || box.right > window.innerWidth + 0.5);
        });
        return {
          headerBackground: getComputedStyle(mount)
            .getPropertyValue("--sb-header-background")
            .trim(),
          h1: getComputedStyle(mount).getPropertyValue("--sb-h1-color").trim(),
          ink: shell.getPropertyValue("--ink").trim(),
          surface: shell.getPropertyValue("--surface-2").trim(),
          regionOverflowX: getComputedStyle(mount.closest(".portal-feature")).overflowX,
          outside: outside.length,
          firstOutside: outside[0]?.className?.toString().slice(0, 60) ?? null,
          scrolls: document.documentElement.scrollWidth > window.innerWidth,
        };
      });

      // The portal's tokens, not upstream's defaults.
      assert(
        seen.h1 === seen.ink,
        `the embed's heading colour is ${seen.h1 || "unset"}, the shell's ink is ${seen.ink}`,
      );
      assert(
        seen.headerBackground === seen.surface,
        `the embed's header is ${seen.headerBackground}, the shell's surface is ${seen.surface}`,
      );

      // And Bootstrap's grid stays in the box it was given.
      assert(
        seen.regionOverflowX === "hidden",
        `the application region is overflow-x: ${seen.regionOverflowX}`,
      );
      assert(
        seen.outside === 0,
        `${seen.outside} element(s) outside the window: ${seen.firstOutside}`,
      );
      assert(!seen.scrolls, "the catalogue route scrolls sideways");
    }),
  );

  await check("the embed restyles nothing outside its mount", () =>
    withPage(async (page) => {
      // THE OTHER HALF OF CONTAINMENT, and the half that can only be settled here.
      // `tests/components/stac-containment.test.ts` asserts that the rewrite handles the selector
      // shapes it knows about; this asks a real browser, on a real built artifact with the
      // catalogue loaded, whether any rule in the embed's stylesheet matches an element outside the
      // mount - because a containment pass is only as good as its list of shapes and nothing in a
      // unit test can tell it what it forgot. Measured here, 27 selectors reached outside: `*` on
      // 357 nodes, `a` on 33 (Bootstrap's reboot, `a:hover { text-decoration: underline }`,
      // underlining the portal's own header links), `button` on 12, `img` and `svg` on 35, plus
      // `:root`, `h1`, `h2`, `p`, `ul`, `code`, `[hidden]` and a `.badge` on a portal button.
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Absolute Collection"),
        undefined,
        { timeout: 30_000 },
      );

      const escapes = await page.evaluate(() => {
        const mount = document.getElementById("stac-browser-mount");
        const found = [];
        // Pseudo-elements cannot be queried, and a rule that has one still selects the element it
        // is attached to - so they are stripped and the element behind them is what is asked about.
        const queryable = (selector) =>
          selector
            .replace(/::?-(webkit|moz|ms)-[\w-]+/g, "")
            .replace(/::[\w-]+(\([^)]*\))?/g, "")
            .trim();
        const walk = (rules) => {
          for (const rule of rules) {
            if (rule.cssRules && !rule.selectorText) {
              walk(rule.cssRules);
              continue;
            }
            if (!rule.selectorText) continue;
            for (const part of rule.selectorText.split(/,(?![^([]*[)\]])/)) {
              const selector = queryable(part);
              if (!selector) continue;
              let nodes;
              try {
                nodes = document.querySelectorAll(selector);
              } catch {
                continue;
              }
              for (const node of nodes) {
                if (node === mount || mount.contains(node)) continue;
                found.push(`${part.trim()} -> ${node.tagName.toLowerCase()}`);
                break;
              }
            }
          }
        };
        for (const sheet of document.styleSheets) {
          if (!sheet.href || !/\/stac\/assets\//.test(sheet.href)) continue;
          try {
            walk(sheet.cssRules);
          } catch {
            // A stylesheet this document cannot read is not one it is serving.
          }
        }
        return found;
      });
      assert(
        escapes.length === 0,
        `${escapes.length} embed selector(s) reach the shell: ${escapes.slice(0, 5).join("; ")}`,
      );

      // And the symptom itself, asked the way it was reported: hover a navigation link and look.
      const link = page.locator(".portal-header a.portal-nav-item").first();
      await link.hover();
      const decoration = await link.evaluate((el) => {
        el.getAnimations().forEach((animation) => animation.finish());
        return getComputedStyle(el).textDecorationLine;
      });
      assert(
        decoration === "none",
        `a navigation link is text-decoration: ${decoration} on hover with the catalogue open`,
      );
    }),
  );

  await check("the Browse drawer stays put while the catalogue scrolls", () =>
    withPage(async (page) => {
      // The drawer is `position: fixed`, and `.portal-main` carries `contain: layout` - so
      // `.portal-main` is its containing block, deliberately, which is what keeps the drawer
      // between the portal's header and its footer instead of under them.
      //
      // A fixed element whose containing block is a SCROLLER scrolls with it, and opening the
      // drawer can give `.portal-main` something to scroll: upstream's backdrop is
      // `width: 100vw; height: 100vh`, which overhangs a containing block that is not the viewport.
      // At 1440x800 an 800px backdrop in a 623px region computes `inset: 0px 0px -177px` and takes
      // scrollHeight from 623 to 800; scrolling those 177px carries the drawer, its top going from
      // 143px to -34px with its own header and close button off the screen. So both halves are
      // asserted: that the region has nothing to scroll, which is the cause, and that the drawer
      // does not move, which is the symptom. Either alone would pass on a page broken the other way.
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Absolute Collection"),
        undefined,
        { timeout: 30_000 },
      );

      await page.locator("#stac-browser .btn", { hasText: "Browse" }).first().click();
      await page.waitForSelector("#stac-browser .offcanvas.show", { timeout: 10_000 });
      // The panel slides in, and a rectangle read during the transition is the animated one.
      await page.evaluate(() => {
        for (const element of document.querySelectorAll(
          "#stac-browser .offcanvas, .offcanvas-backdrop",
        ))
          element.getAnimations().forEach((animation) => animation.finish());
      });

      const before = await page.evaluate(() => {
        const main = document.querySelector(".portal-main");
        const drawer = document.querySelector("#stac-browser .offcanvas");
        const box = drawer.getBoundingClientRect();
        return {
          top: box.top,
          bottom: box.bottom,
          mainScrollHeight: main.scrollHeight,
          mainClientHeight: main.clientHeight,
        };
      });
      assert(
        before.mainScrollHeight === before.mainClientHeight,
        `the open drawer gave the application region ${before.mainScrollHeight - before.mainClientHeight}px to scroll`,
      );

      const after = await page.evaluate(() => {
        const main = document.querySelector(".portal-main");
        const region = document.querySelector(".portal-feature-stac");
        main.scrollTop = 400;
        region.scrollTop = 400;
        window.scrollTo(0, 400);
        const box = document.querySelector("#stac-browser .offcanvas").getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, regionScrolled: region.scrollTop > 0 };
      });
      assert(after.regionScrolled, "the catalogue did not scroll, so nothing was exercised");
      assert(
        after.top === before.top && after.bottom === before.bottom,
        `the drawer moved from ${before.top}..${before.bottom} to ${after.top}..${after.bottom} when the catalogue scrolled`,
      );
    }),
  );

  await check("the catalogue introduction is inside the catalogue, not stacked on top of it", () =>
    withPage(async (page) => {
      // Where the introduction is placed IS the feature. Rendered where the route template writes
      // it - in the document's own flow, above the mount - a visitor meets a band of portal page,
      // an image and three paragraphs, and only under it the application's toolbar and the
      // catalogue's own title, as though the introduction belonged to some other page. It also
      // makes the region's geometry a permanent argument: the band is in the shell's flow and wants
      // the shell's gutter, the application is full-bleed and wants the window. `PortalIntro`
      // (patch 0009) settles it by moving the fragment into upstream's own metadata column, at the
      // top, where a reader looks for what a catalogue is, so it inherits the application's column.
      // Four things are asserted, and the first is the load-bearing one: the node is INSIDE the
      // application, not merely somewhere on the page.
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForFunction(() => document.documentElement.dataset.portalStacView === "root", {
        timeout: 30_000,
      });
      await page.waitForFunction(
        () => Boolean(document.querySelector("[data-portal-stac-intro]")?.closest("#stac-browser")),
        undefined,
        { timeout: 30_000 },
      );

      const measured = await page.evaluate(() => {
        const intro = document.querySelector("[data-portal-stac-intro]");
        const mount = document.getElementById("stac-browser-mount");
        const app = mount?.querySelector("#stac-browser.container");
        const meta = document.querySelector("#stac-browser .cc > .row > .meta");
        const shell = getComputedStyle(document.documentElement);
        const box = app?.getBoundingClientRect();
        const pad = app ? getComputedStyle(app) : null;
        return {
          insideApp: Boolean(intro?.closest("#stac-browser")),
          visible: Boolean(intro?.checkVisibility()),
          // At the top of `section.intro` - the item the metadata row shares with the providers.
          // Not in a wrapper of its own at the top of the column: above `xl` that column is a flex
          // row whose `> section` children divide it, so a fragment outside them is a third item
          // that takes a line to itself and pushes the providers below it, which is the layout
          // this placement exists to fix, arrived at from the other side.
          firstInIntro: Boolean(
            meta?.querySelector("section.intro")?.firstElementChild?.contains(intro),
          ),
          introTop: intro?.getBoundingClientRect().top ?? -1,
          metaTop: meta?.getBoundingClientRect().top ?? -1,
          introLeft: intro?.getBoundingClientRect().left ?? -1,
          introRight: intro?.getBoundingClientRect().right ?? -1,
          // The catalogue's own heading, which the description sits under and must line up with.
          headingLeft:
            document
              .querySelector("#stac-browser .title h1, #stac-browser header h1")
              ?.getBoundingClientRect().left ?? -1,
          // The application's own content column, inside `.container`'s padding.
          appLeft: box && pad ? box.left + parseFloat(pad.paddingLeft || "0") : -1,
          appRight: box && pad ? box.right - parseFloat(pad.paddingRight || "0") : -1,
          mountLeft: mount?.getBoundingClientRect().left ?? -1,
          mountWidth: mount?.getBoundingClientRect().width ?? -1,
          contentMax: parseFloat(shell.getPropertyValue("--content-max")) || 0,
          // Measured, not parsed. `--shell-pad` is a `clamp()`, and a custom property that is not
          // registered keeps its expression as its computed value - so reading the token gives the
          // text, not the number. An element sized by it gives the number the page actually used.
          shellPad: (() => {
            const probe = document.createElement("div");
            probe.style.cssText = "position:absolute;visibility:hidden;width:var(--shell-pad)";
            document.body.append(probe);
            const width = probe.getBoundingClientRect().width;
            probe.remove();
            return width;
          })(),
          viewport: window.innerWidth,
        };
      });

      assert(measured.insideApp, "the introduction is still outside the mounted application");
      assert(measured.visible, "the introduction was moved into the application but is not shown");
      assert(
        measured.firstInIntro,
        `the introduction is not at the top of the catalogue's own description section (intro y=${measured.introTop}, column y=${measured.metaTop})`,
      );
      assert(
        measured.introLeft >= measured.appLeft - 1 && measured.introRight <= measured.appRight + 1,
        `the introduction spans ${measured.introLeft}-${measured.introRight}, the column ${measured.appLeft}-${measured.appRight}`,
      );
      // And FLUSH with the catalogue's heading, not merely inside the column. The widget's own
      // element is a mount point that holds nothing once the fragment has moved; given
      // `display: contents` it is still a flex item in a row with a 30px gap - `contents` promotes
      // a child rather than removing the box from the row - so the gap after it pushes the
      // description column 30px right of the title and carries the providers panel with it.
      assert(
        measured.headingLeft > 0,
        `the catalogue heading was not found (${measured.headingLeft})`,
      );
      assert(
        Math.abs(measured.introLeft - measured.headingLeft) <= 1,
        `the description starts at ${measured.introLeft}, the heading above it at ${measured.headingLeft}`,
      );

      // And the geometry it inherits: the window, less the shell's gutter, on both sides. Both
      // bounds are asserted because both have been wrong. `.portal-stac-mount > * {
      // max-width: 100% }`, written to contain Bootstrap's negative row margins, beats
      // `.container`'s own max-width and puts the toolbar at x=12 on a 1689px window; capping the
      // container at the shell's READING column instead takes the browsing surface down to a
      // measure meant for prose. A catalogue is not a document.
      assert(
        measured.mountLeft <= 1 && measured.mountWidth >= measured.viewport - 1,
        `the mount is no longer full-bleed: x=${measured.mountLeft} w=${measured.mountWidth}`,
      );
      // Bootstrap's own 12px and nothing else: the rows run to the window on both sides.
      assert(
        measured.appLeft <= 13,
        `the application starts at ${measured.appLeft}, past Bootstrap's own gutter`,
      );
      assert(
        measured.appRight >= measured.viewport - 13,
        `the application ends at ${measured.appRight} of ${measured.viewport}`,
      );

      // And the route is one surface from top to bottom. Upstream's `body` rule is scoped to the
      // mount by the containment pass, so it paints `--bs-body-bg` - white - on an element only as
      // tall as the application: the page changes colour partway down, at whatever height the
      // catalogue happens to end. The mount and the region it fills are compared rather than the
      // mount and the page, because that is the visible seam.
      const paint = await page.evaluate(() => {
        const mount = document.getElementById("stac-browser-mount");
        return {
          mount: getComputedStyle(mount).backgroundColor,
          region: getComputedStyle(mount.closest(".portal-feature")).backgroundColor,
          mountHeight: mount.getBoundingClientRect().height,
          regionHeight: mount.closest(".portal-feature").getBoundingClientRect().height,
        };
      });
      assert(
        paint.mount === paint.region || paint.mount === "rgba(0, 0, 0, 0)",
        `the embed paints ${paint.mount} inside a region painted ${paint.region}`,
      );
      // And the seam is real, not hidden by the two happening to be the same height.
      assert(
        paint.regionHeight > 0,
        `the application region has no height (${paint.regionHeight})`,
      );

      // And it goes back where it came from when the view that took it in is torn down.
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Absolute Collection"),
        undefined,
        { timeout: 30_000 },
      );
      await page
        .locator("#stac-browser-mount a", { hasText: "Absolute Collection" })
        .first()
        .click();
      await page.waitForFunction(
        () => document.documentElement.dataset.portalStacView === "child",
        { timeout: 30_000 },
      );
      const onChild = await page.evaluate(() => {
        const all = document.querySelectorAll("[data-portal-stac-intro]");
        return { count: all.length, visible: all[0]?.checkVisibility() ?? null };
      });
      assert(onChild.count === 1, `${onChild.count} copies of the introduction after navigating`);
      assert(!onChild.visible, "the root introduction is shown on a collection page");
    }),
  );

  await check("the deployment's root metadata is presented on the root and never below it", () =>
    withPage(async (page) => {
      // The portal states a title, keywords, a licence and a provider for the catalogue root: this
      // deployment's PRESENTATION of the catalogue, applying to the root document and nothing under
      // it, never claiming to have changed the remote API. The fixture serves a root with a title,
      // description, keywords, licence and provider of its own, all different from the configured
      // ones, so a value that leaks downward or an override that fails to apply is visible.
      const mount = page.locator("#stac-browser-mount");
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      // Waited for by its rendered TEXT, not by the view attribute: the attribute is published
      // while the document is being preprocessed, before the application has painted it, so
      // reading the mount then can catch the previous frame and fail for an unrelated reason.
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Example Research Catalog"),
        undefined,
        { timeout: 30_000 },
      );
      const rootText = await mount.innerText();
      assert(
        rootText.includes("Example Research Catalog"),
        "the configured root title is not what the catalogue shows",
      );
      for (const leaked of [
        "Fixture Catalogue",
        // The API's own description: the portal supplies an introduction, so showing the API's
        // description as well would print two blurbs one above the other.
        "The catalogue's own description",
        "proprietary",
        "API Provider",
      ]) {
        assert(!rootText.includes(leaked), `the root still shows the API's own "${leaked}"`);
      }

      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Absolute Collection"),
        undefined,
        { timeout: 30_000 },
      );
      await page
        .locator("#stac-browser-mount a", { hasText: "Absolute Collection" })
        .first()
        .click();
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Description of Absolute Collection"),
        undefined,
        { timeout: 30_000 },
      );
      const childText = await mount.innerText();
      assert(
        childText.includes("Description of Absolute Collection"),
        "the collection's own description was replaced",
      );
      for (const leaked of ["reanalysis", "CC-BY-4.0", "Example Institute"]) {
        assert(
          !childText.includes(leaked),
          `root-only metadata "${leaked}" reached a collection page`,
        );
      }
      assert(childText.includes("CC0-1.0"), "the collection's own licence was replaced or dropped");
    }),
  );

  await check("the component route is named by the deployment, not by the framework", () =>
    withPage(async (page) => {
      // One page, one name. A route titled "Catalog" - the framework's generic default - while the
      // application header says "Example Catalog" and the root document says "Example Research
      // Catalog" is three names for one page. The browser tab and the meta description are the two
      // surfaces a visitor and a search engine actually see, so both are checked in the built file.
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      const title = await page.title();
      assert(
        title.includes("Example Research Catalog"),
        `the document title is still generic: ${JSON.stringify(title)}`,
      );
      const heading = await page.locator(".portal-feature h1").first().innerText();
      assert(
        heading.includes("Example Research Catalog"),
        `the route heading is still generic: ${JSON.stringify(heading)}`,
      );
    }),
  );

  await check("a direct visit to the auth callback scrubs its parameters and stays safe", () =>
    withPage(async (page) => {
      await page.goto(`${base}auth/callback/?code=secret&state=xyz`, { waitUntil: "load" });
      await page.waitForFunction(() => window.location.search === "", undefined, {
        timeout: 20_000,
      });
      const body = await page.locator("[data-portal-callback]").innerText();
      assert(!body.includes("secret"), "the callback rendered its parameters");
      assert(
        (await page
          .locator('[data-portal-callback][data-portal-callback-state="error"]')
          .count()) === 1,
        "a direct visit did not reach the safe error state",
      );
      const home = await page.locator("[data-portal-callback] a").getAttribute("href");
      assert(home === "/site/", `expected a link home, got ${home}`);
    }),
  );

  // accessibility
  //
  // On a component route the portal owns the shell, the heading, the description and the loading
  // boundary; the mounted application is a separately released package with its own accessibility
  // gates. Scanning it here would report that package's findings as this one's, so the mount is
  // excluded and the exclusion is stated rather than hidden.
  const SCAN = [
    { path: "", exclude: [] },
    { path: "docs/guide/", exclude: [] },
    { path: "docs/showcase/", exclude: [] },
    // The same page again in the dark theme: admonition headers and syntax colours have a
    // different background there, and a contrast decision that only holds in one theme is not one.
    { path: "docs/showcase/", exclude: [], theme: "dark" },
    { path: "workshop/", exclude: [] },
    { path: "data/", exclude: ["#portal-databrowser-mount"] },
    // `catalog/` is deliberately NOT in this list: scanning it here would run before the
    // application has mounted, so excluding the mount would hide nothing and including it would
    // measure an empty box. It gets its own pair of checks below, against a loaded catalogue.
  ];

  for (const { path, exclude, theme } of SCAN) {
    await check(`accessibility scan of /${path}${theme ? ` (${theme})` : ""}`, () =>
      withPage(async (page) => {
        if (theme) {
          await page.addInitScript(
            (mode) => window.localStorage.setItem("freva.portal.theme", mode),
            theme,
          );
        }
        await page.goto(`${base}${path}`, { waitUntil: "load" });
        await page.addScriptTag({ url: AXE_URL });
        const report = await page.evaluate(
          async (excluded) =>
            window.axe.run(excluded.length ? { exclude: excluded.map((s) => [s]) } : document, {
              runOnly: {
                type: "tag",
                values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
              },
            }),
          exclude,
        );
        const serious = report.violations.filter(
          (v) => v.impact === "serious" || v.impact === "critical",
        );
        assert(
          serious.length === 0,
          `axe found ${serious.length} serious violation(s): ${serious.map((v) => v.id).join(", ")}`,
        );
      }),
    );
  }

  // The catalogue route, scanned rather than excluded. `axeInside` and `axeOutside` use axe's own
  // context so the two halves are measured separately: the portal owns everything outside the
  // mount - the shell, the heading, the introduction region - and is held to zero serious or
  // critical findings there, while what the pinned third-party application inside costs is written
  // down in `fixtures/stac/upstream-a11y.mjs` rather than hidden behind an exclusion.
  const axeIds = async (page, context) => {
    await page.addScriptTag({ url: AXE_URL });
    const report = await page.evaluate(
      async (ctx) =>
        window.axe.run(ctx, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
          },
        }),
      context,
    );
    return [
      ...new Set(
        report.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => v.id),
      ),
    ].sort();
  };
  const insideMount = { include: [["#stac-browser-mount"]] };
  const outsideMount = { exclude: [["#stac-browser-mount"]] };

  await check("the catalogue root is scanned with the catalogue on the page", () =>
    withPage(async (page) => {
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Absolute Collection"),
        undefined,
        { timeout: 30_000 },
      );

      const outside = await axeIds(page, outsideMount);
      assert(
        outside.length === 0,
        `the portal's own markup on the catalogue route: ${outside.join(", ")}`,
      );

      // Exactly, not at most: the root view draws no map, so this set is deterministic, and an
      // upgrade that fixes one of these has to shrink the list rather than leave a stale excuse.
      const inside = await axeIds(page, insideMount);
      const recorded = Object.keys(ROOT_VIEW).sort();
      assert(
        JSON.stringify(inside) === JSON.stringify(recorded),
        `upstream's findings changed: found [${inside.join(", ")}], recorded [${recorded.join(", ")}]`,
      );
    }),
  );

  await check("a collection view adds only the map findings already written down", () =>
    withPage(async (page) => {
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Absolute Collection"),
        undefined,
        { timeout: 30_000 },
      );
      await page
        .locator("#stac-browser-mount a", { hasText: "Absolute Collection" })
        .first()
        .click();
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Description of Absolute Collection"),
        undefined,
        { timeout: 30_000 },
      );
      // The map paints asynchronously, and its controls are two of the findings.
      await page.waitForTimeout(2_000);

      const outside = await axeIds(page, outsideMount);
      assert(
        outside.length === 0,
        `the portal's own markup on a collection: ${outside.join(", ")}`,
      );

      // An upper bound here rather than an equality: whether the map has painted by now is a
      // timing question, and a check that fails when the map is slow measures the machine.
      const inside = await axeIds(page, insideMount);
      const recorded = new Set(Object.keys(CHILD_VIEW));
      const unrecorded = inside.filter((id) => !recorded.has(id));
      assert(unrecorded.length === 0, `unrecorded upstream findings: ${unrecorded.join(", ")}`);
    }),
  );

  await check("the skip link and the navigation disclosure are keyboard reachable", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => document.activeElement?.className ?? "");
      assert(focused.includes("portal-skip"), `first tab stop was '${focused}'`);
      await page.setViewportSize({ width: 380, height: 800 });
      const toggle = page.locator(".portal-compact-button");
      await toggle.waitFor({ state: "visible", timeout: 10_000 });
      await toggle.press("Enter");
      assert(
        (await toggle.getAttribute("aria-expanded")) === "true",
        "the navigation disclosure did not toggle",
      );
    }),
  );

  await check("every code block has a copy control that copies the raw source", () =>
    withPage(
      async (page) => {
        await page.goto(`${base}docs/showcase/`, { waitUntil: "load" });
        const figures = await page.locator(".portal-code-figure").count();
        const buttons = await page.locator(".portal-code-head > .portal-code-copy").count();
        const labels = await page.locator(".portal-code-head > .portal-code-lang").count();
        assert(figures > 0, "the showcase rendered no code blocks");
        assert(buttons === figures, `${figures} code blocks but ${buttons} copy controls`);
        assert(labels === figures, `${figures} code blocks but ${labels} language labels`);
        // The label has to say what the highlighter actually used, not the word the author
        // happened to type.
        const shown = await page
          .locator('[data-portal-code="bash"] .portal-code-lang')
          .first()
          .innerText();
        assert(shown.trim().toLowerCase() === "bash", `the bash block is labelled '${shown}'`);
        // Revealed only once the script is live: without it the button cannot copy anything, and
        // the code itself is still readable.
        const hidden = await page.locator(".portal-code-copy[hidden]").count();
        assert(hidden === 0, `${hidden} copy controls stayed hidden with a script running`);

        const target = page.locator('[data-portal-code="bash"] .portal-code-copy').first();
        // Reached and operated from the keyboard alone.
        await target.focus();
        const focused = await page.evaluate(() => document.activeElement?.className ?? "");
        assert(focused.includes("portal-code-copy"), `focus went to '${focused}'`);
        await page.keyboard.press("Enter");
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        const source = await page
          .locator('[data-portal-code="bash"] .portal-code-block')
          .first()
          .innerText();
        assert(copied.trim() === source.trim(), `clipboard held '${copied}'`);
        assert(!copied.includes("Copy"), "the button's own label was copied");
        const state = await target.getAttribute("data-state");
        assert(state === "copied", `expected the copied state, got '${state}'`);
      },
      { permissions: ["clipboard-read", "clipboard-write"] },
    ),
  );

  await check("code is readable with no script at all", () =>
    withPage(
      async (page) => {
        await page.goto(`${base}docs/showcase/`, { waitUntil: "load" });
        const text = await page.locator('[data-portal-code="bash"] .portal-code-block').innerText();
        assert(text.includes("freva-portal-builder"), "the code did not render without a script");
        const shown = await page.locator(".portal-code-copy:not([hidden])").count();
        assert(shown === 0, "a copy control that cannot copy was shown anyway");
      },
      { javaScriptEnabled: false },
    ),
  );

  await check("the landing hero draws both columns on a desktop and stacks them on a phone", () =>
    withPage(async (page) => {
      const measure = () =>
        page.evaluate(() => {
          const box = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
            };
          };
          return {
            columns:
              document.querySelector(".portal-hero-row")?.getAttribute("data-columns") ?? null,
            lead: box(document.querySelector(".portal-hero-lead")),
            aside: box(document.querySelector(".portal-hero-aside")),
            search: box(document.querySelector(".portal-search-block")),
            featureLink: box(document.querySelector(".portal-feature-link")),
            input: box(document.querySelector(".portal-search-input")),
          };
        });

      const solid = (m, name) => {
        const b = m[name];
        assert(b, `${name} is absent from the landing page`);
        assert(b.w > 120 && b.h > 30, `${name} measured ${b.w}x${b.h}`);
      };

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(base, { waitUntil: "load" });
      await page.waitForTimeout(400);
      const wide = await measure();
      assert(wide.columns === "two", `the hero row is '${wide.columns}' at 1280px`);
      // `featureLink` only when the fixture declares a component-link block.
      const parts = ["lead", "aside", "search", "input"];
      for (const part of parts) solid(wide, part);
      assert(
        wide.aside.x >= wide.lead.x + wide.lead.w - 1,
        `the aside starts at ${wide.aside.x}, inside the lead which ends at ${wide.lead.x + wide.lead.w}`,
      );
      assert(
        Math.abs(wide.aside.y - wide.lead.y) < 60,
        "the aside is not on the same row as the lead at 1280px",
      );

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      const narrow = await measure();
      for (const part of parts) solid(narrow, part);
      assert(
        narrow.aside.y >= narrow.lead.y + narrow.lead.h - 1,
        "the aside is not stacked under the lead at 390px",
      );
    }),
  );

  await check("a narrow table is centred and a wide one scrolls itself", () =>
    withPage(async (page) => {
      // `.portal-prose table` is `display: block; width: max-content`, which is what makes a table
      // with more columns than fit scroll instead of pushing the page sideways. It also leaves a
      // table NARROWER than the measure flush left in a column two-thirds wider - 615px inside
      // 1099px on a real page. Both halves are asserted because they are in tension: the centring
      // is auto margins, which only distribute space that exists, and the wide case has none.
      for (const width of [1440, 900]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${base}docs/guide/`, { waitUntil: "load" });
        const tables = await page.evaluate(() =>
          [...document.querySelectorAll(".portal-prose table")].map((table) => {
            const column = table.closest(".portal-prose").getBoundingClientRect();
            const box = table.getBoundingClientRect();
            return {
              width: Math.round(box.width),
              column: Math.round(column.width),
              left: Math.round(box.left - column.left),
              right: Math.round(column.right - box.right),
              scrolls: table.scrollWidth > table.clientWidth + 1,
              page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          }),
        );
        assert(tables.length >= 2, `${width}: the guide has ${tables.length} tables`);
        for (const table of tables) {
          // Nothing a table does may widen the document. This is the rule the block display and
          // the max-content width exist for, and the alignment must not cost it.
          assert(table.page === 0, `${width}: a table widened the page by ${table.page}px`);
          if (table.width < table.column - 2) {
            assert(
              Math.abs(table.left - table.right) <= 2,
              `${width}: a ${table.width}px table in a ${table.column}px column sits ${table.left}px from the left and ${table.right}px from the right`,
            );
          } else {
            // At the measure there is no free space, so the margins are zero and the box scrolls.
            assert(table.left === 0, `${width}: a full-width table is inset ${table.left}px`);
          }
        }
      }
    }),
  );

  await check("every heading carries a permalink that lands on it", () =>
    withPage(async (page) => {
      await page.goto(`${base}docs/showcase/`, { waitUntil: "load" });
      const headings = await page.locator(".portal-prose :is(h2, h3)[id]").count();
      const anchors = await page
        .locator(".portal-prose :is(h2, h3)[id] > .portal-heading-anchor")
        .count();
      assert(headings > 0, "the showcase rendered no headings");
      assert(anchors === headings, `${headings} headings but ${anchors} permalinks`);
      const first = page.locator(".portal-heading-anchor").first();
      const href = await first.getAttribute("href");
      const id = await page.locator(".portal-prose :is(h2, h3)[id]").first().getAttribute("id");
      assert(href === `#${id}`, `the permalink points at '${href}', the heading is '${id}'`);
      // It is reachable from the keyboard, and following it lands on the heading rather than under
      // the fixed header.
      await first.focus();
      const focused = await page.evaluate(() => document.activeElement?.className ?? "");
      assert(focused.includes("portal-heading-anchor"), `focus went to '${focused}'`);
      await first.click();
      await page.waitForTimeout(400);
      assert(page.url().endsWith(`#${id}`), `the address bar shows ${page.url()}`);
      const box = await page.locator(`#${id}`).boundingBox();
      const headerHeight = await page.evaluate(
        () => document.querySelector(".portal-header")?.getBoundingClientRect().height ?? 0,
      );
      assert(
        box !== null && box.y >= headerHeight - 1,
        `the heading landed at ${box?.y} under a ${headerHeight}px header`,
      );
    }),
  );

  await check("the site index unrolls with the scroll rather than appearing at once", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      await page.waitForTimeout(500);
      const read = () =>
        page.evaluate(() => {
          const footer = document.querySelector(".portal-footer");
          const panel = document.querySelector(".portal-footer-expanded");
          return {
            open: Number(footer?.style.getPropertyValue("--footer-open") || 0),
            height: Math.round(panel?.getBoundingClientRect().height ?? 0),
            reserved: getComputedStyle(document.documentElement).getPropertyValue(
              "--footer-index-h",
            ),
          };
        });
      const seek = async (fraction) => {
        await page.evaluate((f) => {
          const max = document.documentElement.scrollHeight - window.innerHeight;
          window.scrollTo(0, Math.round(max * f));
        }, fraction);
        await page.waitForTimeout(250);
        return read();
      };

      const top = await seek(0);
      assert(top.open === 0, `the index is ${top.open} open at the top of the page`);
      assert(top.height === 0, `the index is ${top.height}px tall at the top of the page`);
      assert(/\d+px/.test(top.reserved), `no index height was published: '${top.reserved}'`);

      const part = await seek(0.9);
      const bottom = await seek(1);
      assert(bottom.open > 0.99, `the index is only ${bottom.open} open at the bottom`);
      // Partly open partway through: a boolean that flips at the bottom would read 0 here and 1
      // one pixel later.
      assert(
        part.open > 0.05 && part.open < 0.99,
        `the index was ${part.open} open nine tenths of the way down`,
      );
      assert(
        part.height > 0 && part.height < bottom.height,
        `the index measured ${part.height}px partway and ${bottom.height}px at the bottom`,
      );

      // And the last line of content is above the bar rather than behind it.
      const clear = await page.evaluate(() => {
        const main = document.querySelector(".portal-main");
        const last = main?.querySelector(".portal-landing > :last-child");
        const bar = document.querySelector(".portal-footer-bar");
        if (!last || !bar) return null;
        return Math.round(bar.getBoundingClientRect().top - last.getBoundingClientRect().bottom);
      });
      assert(clear !== null && clear >= 0, `the last block overlaps the footer bar by ${-clear}px`);
    }),
  );

  await check("an announcement can be dismissed but never invented by the browser", () =>
    withPage(async (page) => {
      await page.goto(base, { waitUntil: "load" });
      const announcements = page.locator("[data-portal-announcement]");
      const ids = await announcements.evaluateAll((nodes) =>
        nodes.map((node) => node.dataset.portalAnnouncement),
      );
      // Both are present because the build recorded --effective-at inside the dated window. The
      // browser did not decide this and cannot change it.
      assert(
        JSON.stringify(ids) === JSON.stringify(["winter-maintenance", "always-on"]),
        `unexpected announcements: ${ids.join(", ")}`,
      );
      const dismiss = page.locator("[data-portal-dismiss]").first();
      await dismiss.waitFor({ state: "visible", timeout: 10_000 });
      await dismiss.click();
      assert(await announcements.first().isHidden(), "dismissal did not hide the announcement");
    }),
  );

  await check("an announcement begins where the brand does, and is ruled in both themes", () =>
    withPage(async (page) => {
      // The band is full-bleed - the notice colour is meant to run edge to edge - but its text
      // belongs in the same column the chrome keeps its contents in. Read at four widths, because
      // the inset is only non-zero above `--chrome-max`: a rule that merely used `--shell-pad`
      // would agree at 1280 and be a couple of hundred pixels out at 1920.
      const channels = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const distance = (a, b) => {
        const [x, y, z] = channels(a);
        const [p2, q, r] = channels(b);
        return Math.abs(x - p2) + Math.abs(y - q) + Math.abs(z - r);
      };
      for (const theme of ["light", "dark"]) {
        for (const width of [1280, 1440, 1920, 2560]) {
          await page.setViewportSize({ width, height: 900 });
          for (const route of ["", "docs/guide/", "data/"]) {
            await page.goto(base + route, { waitUntil: "load" });
            const seen = await page.evaluate((wanted) => {
              document.documentElement.setAttribute("data-theme", wanted);
              const brand = document.querySelector(".portal-brand");
              const shell = document.querySelector(".portal-shell");
              const page_ = getComputedStyle(document.body).backgroundColor;
              const rows = [...document.querySelectorAll(".portal-announcement")].map((node) => {
                const style = getComputedStyle(node);
                const band = node.getBoundingClientRect();
                const text = node
                  .querySelector(".portal-announcement-text")
                  .getBoundingClientRect();
                return {
                  textLeft: Math.round(text.left),
                  bandLeft: Math.round(band.left),
                  bandRight: Math.round(band.right),
                  top: style.borderTopWidth,
                  bottom: style.borderBottomWidth,
                  rule: style.borderBottomColor,
                  fill: style.backgroundColor,
                };
              });
              return {
                view: shell?.dataset.view ?? "",
                brandLeft: Math.round(brand.getBoundingClientRect().left),
                inner: window.innerWidth,
                page: page_,
                rows,
              };
            }, theme);
            assert(seen.rows.length > 1, `fewer than two announcements on /${route}`);
            seen.rows.forEach((row, index) => {
              const where = `/${route} (${seen.view}) ${theme} at ${width}`;
              assert(
                Math.abs(row.textLeft - seen.brandLeft) <= 1,
                `${where}: announcement text at ${row.textLeft}, brand at ${seen.brandLeft}`,
              );
              assert(
                row.bandLeft === 0 && row.bandRight >= seen.inner - 1,
                `${where}: the band stopped short of the edges (${row.bandLeft}..${row.bandRight} of ${seen.inner})`,
              );
              // Dark mode puts the chip within a few percent of both the page and the header
              // bar, so the rules are what make it a band at all. The first notice is ruled on
              // both sides; the ones under it share the rule above them rather than doubling it.
              assert(
                row.bottom !== "0px" && (index === 0 ? row.top !== "0px" : row.top === "0px"),
                `${where}: notice ${index} is ruled ${row.top}/${row.bottom}`,
              );
              assert(
                distance(row.rule, row.fill) >= 24 && distance(row.rule, seen.page) >= 24,
                `${where}: the rule ${row.rule} does not separate ${row.fill} from ${seen.page}`,
              );
            });
          }
        }
      }
    }),
  );

  await check("the trusted subsite runs its own code under its own policy", () =>
    withPage(async (page, violations) => {
      const response = await page.goto(`${base}reference/`, { waitUntil: "load" });
      assert(response.status() === 200, `subsite returned ${response.status()}`);
      await page.waitForSelector("[data-subsite-ready]", { timeout: 10_000 });
      assert(violations.length === 0, `subsite CSP violations: ${violations.join(" | ")}`);
      const requests = [];
      page.on("request", (request) => requests.push(request.url()));
      await page.goto(`${base}reference/api/index.html`, { waitUntil: "load" });
      const external = requests.filter((url) => !url.startsWith(`http://127.0.0.1:${port}/`));
      assert(external.length === 0, `subsite made external requests: ${external.join(", ")}`);
    }),
  );

  await check("the catalog browser survives a deep hash route and a reload", () =>
    withPage(async (page, violations) => {
      await page.goto(`${base}catalog/#/collections/example`, { waitUntil: "load" });
      await waitForStacReady(page);
      assert(
        page.url().endsWith("#/collections/example"),
        `the hash route was rewritten to ${page.url()}`,
      );
      await page.reload({ waitUntil: "load" });
      await waitForStacReady(page);
      assert(violations.length === 0, `CSP violations after reload: ${violations.join(" | ")}`);
    }),
  );

  await check("leaving and re-entering the catalog route leaves nothing behind", () =>
    withPage(async (page, violations) => {
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);

      // Whatever the application does to the document while it is mounted, the portal must get
      // its own document back. The drawer's scroll lock is a class on <body>, and a portal that
      // cannot scroll is the visible symptom.
      await page.evaluate(() => document.body.classList.add("modal-open"));
      await page.goto(`${base}docs/guide/`, { waitUntil: "load" });
      const leftBehind = await page.evaluate(() => [...document.body.classList]);
      assert(
        !leftBehind.includes("modal-open"),
        `the catalog left '${leftBehind.join(" ")}' on the portal's body`,
      );

      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      assert(violations.length === 0, `CSP violations on re-entry: ${violations.join(" | ")}`);
    }),
  );

  await check("the catalog browser follows the host theme rather than its own", () =>
    withPage(async (page) => {
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);

      // The host owns light/dark. The patched application watches `<html data-theme>` and mirrors
      // it onto its own root, and it hides its own toggle so a reader cannot put the two into
      // disagreement.
      const light = await page.evaluate(() => ({
        host: document.documentElement.getAttribute("data-theme"),
        app: document.getElementById("stac-browser-mount")?.getAttribute("data-bs-theme"),
      }));
      assert(
        light.app === (light.host === "dark" ? "dark" : "light"),
        `host theme ${light.host} but the catalog is ${light.app}`,
      );

      // Change the host's mind and the application must follow, without a reload: this is the
      // observer the patch adds, not a start-up read.
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await page.waitForFunction(
        () =>
          document.getElementById("stac-browser-mount")?.getAttribute("data-bs-theme") === "dark",
        undefined,
        { timeout: 10_000 },
      );

      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      await page.waitForFunction(
        () =>
          document.getElementById("stac-browser-mount")?.getAttribute("data-bs-theme") === "light",
        undefined,
        { timeout: 10_000 },
      );
    }),
  );

  await check("a catalog whose application cannot load fails instead of showing a shell", () =>
    withPage(async (page) => {
      // The failure mode the readiness signal exists for: block the entry module and confirm the
      // island says so rather than leaving an empty mount a weaker check would have called ready.
      await page.route(`**/stac/assets/index-*.js`, (route) => route.abort());
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      const state = await page
        .waitForSelector('#stac-browser-mount[data-portal-stac-state="failed"]', {
          state: "attached",
          timeout: 30_000,
        })
        .then(() => "failed")
        .catch(() => "never-failed");
      assert(state === "failed", "a blocked entry module did not mark the island failed");
      const ready = await page
        .locator('#stac-browser-mount[data-portal-stac-state="ready"]')
        .count();
      assert(ready === 0, "the island reported ready with no application");
    }),
  );

  await check("the catalog makes no forbidden request after it has initialized", () =>
    withPage(async (page, violations) => {
      const requests = [];
      page.on("request", (request) => requests.push(request.url()));
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      // Asynchronous initialization is exactly when a third-party fetch would appear, so the
      // requests are collected across it rather than before.
      await page.waitForTimeout(1_000);
      const external = requests.filter((url) => !url.startsWith(`http://127.0.0.1:${port}/`));
      assert(external.length === 0, `the catalog requested ${external.join(", ")}`);
      assert(violations.length === 0, `CSP violations: ${violations.join(" | ")}`);
    }),
  );

  await check("a footprint draws no third-party tile, and no policy violation", () =>
    withPage(async (page, violations) => {
      // The check above visits the catalogue ROOT, which has no map. Every collection and item
      // does, and upstream's basemap table fetches those tiles from openstreetmap.org, once per
      // tile, from the visitor's browser. Under `default-src 'none'` the browser refuses them and
      // the map draws blank with the console full of violations. A deployment that lists no basemap
      // origin - the default, and what the example portal does - gets no request to refuse.
      const requests = [];
      page.on("request", (request) => requests.push(request.url()));
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Absolute Collection"),
        undefined,
        { timeout: 30_000 },
      );
      await page
        .locator("#stac-browser-mount a", { hasText: "Absolute Collection" })
        .first()
        .click();
      await page.waitForFunction(
        () =>
          document
            .getElementById("stac-browser-mount")
            ?.textContent?.includes("Description of Absolute Collection"),
        undefined,
        { timeout: 30_000 },
      );
      // And into the item, which has a geometry as well as an extent.
      const item = page.locator("#stac-browser-mount a", { hasText: "First Item" }).first();
      if ((await item.count()) > 0) {
        await item.click();
        await page.waitForFunction(
          () =>
            document
              .getElementById("stac-browser-mount")
              ?.textContent?.includes("The item's own description"),
          undefined,
          { timeout: 30_000 },
        );
      }
      // The map is asynchronous, and a tile request would arrive after the text does.
      await page.waitForTimeout(2_000);

      const external = requests.filter((url) => !url.startsWith(`http://127.0.0.1:${port}/`));
      assert(
        external.length === 0,
        `a document with a footprint requested ${external.slice(0, 4).join(", ")}`,
      );
      assert(violations.length === 0, `CSP violations: ${violations.slice(0, 3).join(" | ")}`);
    }),
  );

  await check("no service worker is registered, and none is published to register one", () =>
    withPage(async (page) => {
      // The prepared application ships StreamSaver: `sw.js`, a service worker, and `mitm.html`,
      // the frame that hands it a message port. Neither can work here - the portal serves
      // `default-src 'none'` with no `worker-src` and no `frame-src` - but a service worker at the
      // deployment's own origin is not therefore harmless: it is an interceptor for every request
      // under its scope, one relaxed directive or one self-served policy away from being live, and
      // it would outlive the page that registered it. The preparation stage drops both, along with
      // the `.htaccess` that asks for the SPA fallback this artifact deliberately does not have.
      await page.goto(`${base}catalog/`, { waitUntil: "load" });
      await waitForStacReady(page);
      await page.waitForTimeout(1_000);
      const registrations = await page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).map(
          (registration) => registration.scope,
        ),
      );
      assert(
        registrations.length === 0,
        `a service worker is registered: ${registrations.join(", ")}`,
      );

      for (const path of ["stac/sw.js", "stac/mitm.html", "stac/.htaccess", "stac/index.html"]) {
        const response = await page.request.get(`${base}${path}`);
        assert(response.status() === 404, `${path} is published (${response.status()})`);
      }

      const served = await page.goto(`${base}catalog/`);
      const csp = served.headers()["content-security-policy"] ?? "";
      assert(/default-src 'none'/.test(csp), `the route's policy is not closed: ${csp}`);
      assert(!/worker-src/.test(csp), `the route's policy grants worker-src: ${csp}`);
    }),
  );

  await check("the trusted subsite frames its own page and runs its own worker", () =>
    withPage(async (page, violations) => {
      // Both are policy decisions the artifact records, so both are observed in a browser rather
      // than read back out of host-policy.json. `frame-src` without `'self'` blocks the first;
      // `worker-src 'none'` blocks the second.
      await page.goto(`${base}reference/`, { waitUntil: "load" });

      const frame = page.frameLocator('iframe[src="embedded.html"]');
      await frame.locator("[data-embedded-ready]").waitFor({ state: "attached", timeout: 10_000 });

      // `attached`, not `visible`: the marker carries its answer in an attribute and has no text,
      // so a visibility wait would never settle.
      await page.waitForSelector("[data-subsite-worker]", { state: "attached", timeout: 10_000 });
      const answer = await page.getAttribute("[data-subsite-worker]", "data-subsite-worker");
      assert(answer === "indexed:reference", `worker replied ${JSON.stringify(answer)}`);

      assert(violations.length === 0, `subsite CSP violations: ${violations.join(" | ")}`);
    }),
  );

  await check("an image on the catalogue's own origin loads under the policy we publish", () =>
    withPage(async (page) => {
      // The asymmetry this catches: every service origin is derived into `connect-src`, because
      // that is how the artifact reaches a service, and into nothing else. A STAC document carries
      // its thumbnails as assets on the service's own origin, so an artifact could load the
      // catalogue and not one image it pointed at - on the live deployment every collection tile
      // drew its `alt` text. `preview` applies no policy, which is why that stays invisible until a
      // real host applies one, so this check reads the artifact's own `host-policy.json` and lets a
      // browser enforce it.
      const policy = JSON.parse(readFileSync(join(crossOriginOut, "host-policy.json"), "utf8")).csp
        .portal;
      assert(
        policy["img-src"].includes(CROSS_ORIGIN),
        `img-src omits the service origin: ${policy["img-src"]}`,
      );
      assert(
        policy["connect-src"].includes(CROSS_ORIGIN),
        `connect-src omits the service origin: ${policy["connect-src"]}`,
      );

      const violations = [];
      page.on("console", (message) => {
        if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
      });
      // Reached only if the policy permitted the request: CSP is enforced before the network.
      let served = 0;
      await page.route(`${CROSS_ORIGIN}/**`, (route) => {
        served += 1;
        route.fulfill({
          status: 200,
          contentType: "image/png",
          headers: { "access-control-allow-origin": "*" },
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            "base64",
          ),
        });
      });

      await page.goto(`${crossOriginBase}catalog/`, { waitUntil: "domcontentloaded" });
      const outcome = await page.evaluate(
        (src) =>
          new Promise((resolve) => {
            const image = document.createElement("img");
            image.alt = "";
            image.addEventListener("load", () => resolve("loaded"));
            image.addEventListener("error", () => resolve("blocked"));
            image.src = src;
            document.body.appendChild(image);
            setTimeout(() => resolve("timeout"), 8000);
          }),
        `${CROSS_ORIGIN}/thumbnail.png`,
      );
      assert(outcome === "loaded", `a thumbnail on the service origin was ${outcome}`);
      assert(served > 0, "the image request never reached the network - the policy refused it");
      assert(violations.length === 0, `policy violations: ${violations.join(" | ")}`);
    }),
  );

  await check("the subsite's served policy permits its own frames and workers", () =>
    withPage(async (page) => {
      const response = await page.goto(`${base}reference/`, { waitUntil: "load" });
      const csp = response.headers()["content-security-policy"] ?? "";
      assert(/frame-src[^;]*'self'/.test(csp), `frame-src omits 'self': ${csp}`);
      assert(/worker-src[^;]*'self'/.test(csp), `worker-src is not 'self': ${csp}`);
      assert(!/frame-src[^;]*'none'/.test(csp), `frame-src forbids frames: ${csp}`);
    }),
  );

  await browser.close();
  server.close();
  crossOriginServer?.close();
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("\n[browser] results\n");
console.log(results.join("\n"));
console.log(`\n[browser] ${results.length - failures}/${results.length} passed`);
process.exit(failures > 0 ? 1 : 0);
