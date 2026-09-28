// Runnable snippets on a documentation page: when their controls show, and what an editable one
// does. The console element is stubbed, as in `python-playground.mjs` - what is under test is the
// page and the coordinator, not Pyodide - and the stub records every example it is asked to run,
// so "what did a press send" is read from what arrived rather than inferred from the markup.
//
// Usage:  node browser-tests/code-snippets.mjs
//         FREVA_ONLY="<substring>" node browser-tests/code-snippets.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.env.BROWSER_STRICT === "1";
const ONLY = process.env.FREVA_ONLY;
const RUN = mkdtempSync(join(tmpdir(), "code-snippets-"));

function skip(message) {
  if (STRICT) {
    console.error(message);
    process.exit(1);
  }
  console.log(`SKIP  ${message}`);
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  skip(`playwright is not installed: ${error.message}`);
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>Mark</title><rect width="16" height="16" fill="#123456"/></svg>`;
const PLAIN = "total = 0\nfor i in range(4):\n    total += i\nprint('sum', total)";
// The last line is longer than a phone is wide, so the block scrolls sideways under its gutter.
const LONG =
  "print('a fairly long line of Python, wider than a phone screen, so the block scrolls', area(3))";
const EDIT = `def area(r):\n    return 3.14159 * r * r\n\nprint(area(2))\n${LONG}`;
/** An editable snippet with no title, in a landing page's prose block. */
const LANDING = `# on the landing page\nx = [i * i for i in range(5)]\n${LONG.replace("area(3)", "x")}`;

/** Running text long enough to wrap at the measure, on the landing and on the docs page. */
const RUNNING = Array.from(
  { length: 6 },
  () => "A paragraph of running text that keeps to the reading measure, however wide the panel is.",
).join(" ");
/** A two-column card grid, the Waterpark landing's "Where to start". */
const GRID = [
  ":::cards{columns=2}",
  "",
  ...["Guide", "Reference", "Workshop", "Examples"].map(
    (title, i) => `- **[${title}](https://www.example.org/${i})**\n  What is in the ${title}.\n`,
  ),
  ":::",
].join("\n");

/** A docs page with a read-only runnable snippet, an editable one and a plain bash block. */
function page(editable) {
  return (
    "---\ntitle: Guide\n---\n\n# Guide\n\nRead this, then run it.\n\n" +
    `\`\`\`python try-in-python title="plain.py"\n${PLAIN}\n\`\`\`\n\n` +
    `\`\`\`python try-in-python${editable ? " editable" : ""} title="edit.py"\n${EDIT}\n\`\`\`\n\n` +
    "A block nobody may run:\n\n```bash\nls\n```\n\n" +
    // Last, so the snippets above sit where the other checks expect them.
    `${RUNNING}\n`
  );
}

function buildSite(name, { editable = true, playground = "" } = {}) {
  const src = join(RUN, `${name}-src`);
  const put = (rel, body) => {
    const target = join(src, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  put("assets/logo.svg", LOGO);
  put("assets/favicon.svg", LOGO);
  put("content/guide.md", page(editable));
  put(
    "prose/intro.md",
    `${RUNNING}\n\n${GRID}\n\nTry it here.\n\n\`\`\`python try-in-python editable\n${LANDING}\n\`\`\`\n`,
  );
  put(
    "landings/home.yaml",
    "schemaVersion: 1\ntitle: Snippets\nblocks:\n  - type: hero\n    heading: Docs\n" +
      "  - type: prose\n    source: ../prose/intro.md\n",
  );
  put(
    "portal.yaml",
    `schemaVersion: 1
site:
  id: snippets-${name}
  title: Snippets
  language: en
  canonicalUrl: https://docs.example.org/
  identity:
    logo: ./assets/logo.svg
    favicon: ./assets/favicon.svg
theme:
  preset: default
  # A white light page, which is where a muted gutter has the least room.
  tokens:
    light:
      colorBackground: "#ffffff"
rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
landings:
  home:
    path: /
    source: ./landings/home.yaml
pythonPlayground:
  enabled: true
  profile: minimal
  autostart: never
  maxSessions: 2
${playground}  terminal:
    style: freva-client-terminal
    osControls: linux
    alwaysOnTop: true
    rememberAppearance: false
`,
  );
  const out = join(RUN, `${name}-built`);
  // prettier-ignore
  const built = spawnSync(process.execPath,
    [join(PKG, "bin", "freva-portal-builder.mjs"), "build", "--source-root", src,
     "--config", join(src, "portal.yaml"), "--out", out],
    { encoding: "utf8", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } });
  if (built.status !== 0) throw new Error(`${name}: build failed\n${built.stdout}${built.stderr}`);
  return { out, log: `${built.stdout}\n${built.stderr}` };
}

/** Every file under `dir`, relative to it. */
const files = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath ?? entry.path, entry.name)));

/**
 * The script chunk that holds the editor, found by what it does rather than by a file name the
 * bundler is free to change: the one chunk that builds the editor's grid.
 */
function editorChunk(out) {
  const chunks = files(out).filter(
    (file) =>
      file.endsWith(".js") &&
      readFileSync(join(out, file), "utf8").includes("portal-code-editor-grid"),
  );
  assert.equal(chunks.length, 1, `expected one editor chunk, found ${JSON.stringify(chunks)}`);
  return chunks[0].split("\\").join("/");
}

/**
 * A console element with the real API and no interpreter; see `python-playground.mjs`. It answers
 * `{ raised }` as the real one does - raised for a program containing `raise` - and records the
 * `comment` a run was given.
 */
const STUB = `
  class StubConsole extends HTMLElement {
    connectedCallback() {
      if (!this.firstChild) this.textContent = "stub console";
    }
    async start() {}
    async execute() {}
    runExample(example) {
      // One at a time, in arrival order, as the real console queues a press behind a busy
      // interpreter. A little slow, so a second press arrives while the first is running.
      const turn = (window.__queue ?? Promise.resolve()).then(async () => {
        window.__ran.push({
          title: example.title,
          source: example.source,
          ...(example.comment ? { comment: example.comment } : {}),
        });
        await new Promise((r) => setTimeout(r, 150));
        if (window.__failNext) {
          window.__failNext = false;
          throw new Error("the stub was told to fail");
        }
        return { raised: example.source.includes("raise") };
      });
      window.__queue = turn.catch(() => undefined);
      return turn;
    }
    transcript() { return ""; }
    focus() {}
    clear() {}
    clearHistory() {}
    async restart() {}
    dispose() {}
  }
  window.__ran = [];
  customElements.define("freva-python-console", StubConsole);
`;

const results = [];
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    const detail = process.env.BROWSER_VERBOSE
      ? String(error.stack ?? error.message)
      : String(error.message).split("\n").slice(0, 6).join("\n       ");
    console.log(`  FAIL ${name}\n       ${detail}`);
  }
}

/** Switch the page to `mode` with the header's own control, as a reader does. */
async function useMode(page, mode) {
  const current = await page.evaluate(
    () => document.documentElement.getAttribute("data-theme") ?? "light",
  );
  if (current !== mode) await page.locator(".portal-theme-toggle").click();
  await page.waitForFunction(
    (m) => document.documentElement.getAttribute("data-theme") === m,
    mode,
  );
}

/** The two places an editable snippet appears: a docs page, and a landing page's prose block. */
const PLACES = [
  { name: "a docs page", path: "docs/guide/", figure: ".portal-code-figure:nth-of-type(2)" },
  { name: "a landing prose block", path: "", figure: ".portal-code-figure[data-portal-editable]" },
];

/** Open the editor on `figure` by clicking into its code. */
async function openEditor(page, figure) {
  await page.click(`${figure} pre`);
  await page.waitForSelector(`${figure} .portal-code-editor-input`, { timeout: 10_000 });
}

/** WCAG contrast of two computed colours, `rgb()` or `color(srgb …)`, the second opaque. */
function contrastOf(fg, bg) {
  const parse = (value) => {
    const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(value);
    if (srgb) return [...srgb.slice(1, 4).map((c) => Number(c) * 255), Number(srgb[4] ?? 1)];
    const rgb = /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/.exec(value);
    if (rgb) return [...rgb.slice(1, 4).map(Number), Number(rgb[4] ?? 1)];
    throw new Error(`unparsed colour ${value}`);
  };
  const [br, bg2, bb] = parse(bg);
  const [fr, fg2, fb, fa] = parse(fg);
  const mix = [fr * fa + br * (1 - fa), fg2 * fa + bg2 * (1 - fa), fb * fa + bb * (1 - fa)];
  const lum = ([r, g, b]) =>
    [r, g, b]
      .map((c) => c / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(mix), lum([br, bg2, bb])].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Select one line (`line`) or everything (`all`) in the open editor, and compare where the
 * browser DRAWS the selection with where the code under it is. The textarea paints the
 * selection from its own metrics; the reader sees the layer's glyphs. Made measurable by
 * painting the selection a colour nothing else uses and hiding everything else in the block -
 * through the CSSOM, which the page's policy permits, so nothing is relaxed for the test - then
 * reading the pixels of a screenshot back in the page itself.
 */
async function selectionAgainstText(page, figure, which) {
  const layout = await page.evaluate(
    ({ figure, which }) => {
      const sheet = [...document.styleSheets].find((candidate) => {
        try {
          return candidate.href !== null && candidate.cssRules.length >= 0;
        } catch {
          return false;
        }
      });
      for (const rule of [
        ".portal-code-editor-view, .portal-code-gutter { visibility: hidden !important }",
        ".portal-code-editor-input { caret-color: transparent !important }",
        ".portal-code-editor-input::selection { background: #ff00ff !important }",
        ".portal-code-figure { outline: none !important }",
      ]) {
        sheet.insertRule(rule, sheet.cssRules.length);
      }
      const root = document.querySelector(figure);
      const input = root.querySelector("textarea");
      const pre = root.querySelector("pre");
      pre.scrollLeft = 0;
      const lines = input.value.split("\n");
      input.focus();
      // The second line: indented, so a drift in the indent shows too.
      const chosen = which === "line" ? 1 : -1;
      const start = lines.slice(0, 1).join("\n").length + 1;
      if (which === "line") input.setSelectionRange(start, start + lines[1].length);
      else input.setSelectionRange(0, input.value.length);
      const clip = pre.getBoundingClientRect();
      const spans = [...root.querySelectorAll(".portal-code-line")];
      const boxes = spans.map((span, index) => {
        const box = span.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(span);
        const text = span.textContent.replace(/\n$/, "");
        // The text's own extent, without the trailing newline.
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        const left = rects.length ? Math.min(...rects.map((r) => r.left)) : null;
        let right = null;
        if (text.trim()) {
          const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
          let last = null;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent.replace(/\n$/, "")) last = node;
          }
          const end = document.createRange();
          const length = last.textContent.replace(/\n$/, "").length;
          end.setStart(last, length - 1);
          end.setEnd(last, length);
          right = end.getBoundingClientRect().right;
        }
        return {
          index,
          top: box.top - clip.top,
          bottom: box.bottom - clip.top,
          left: left === null ? null : left - clip.left,
          right: right === null ? null : Math.min(right, clip.right) - clip.left,
          text: text.length > 0,
          selected: chosen === -1 || chosen === index,
          last: index === spans.length - 1,
        };
      });
      const space = (() => {
        const probe = document.createRange();
        const node = spans[0].firstChild?.firstChild ?? spans[0].firstChild;
        probe.setStart(node, 0);
        probe.setEnd(node, 1);
        return probe.getBoundingClientRect().width;
      })();
      return {
        clip: { x: clip.left, y: clip.top, width: clip.width, height: clip.height },
        boxes,
        space,
      };
    },
    { figure, which },
  );
  const shot = await page.screenshot({ clip: layout.clip, scale: "css" });
  // Magenta pixels, as a column span per row, decoded in the page: no image library needed.
  const rows = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const out = [];
    for (let y = 0; y < height; y += 1) {
      let min = -1;
      let max = -1;
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        if (data[i] > 180 && data[i + 1] < 100 && data[i + 2] > 180) {
          if (min < 0) min = x;
          max = x + 1;
        }
      }
      out.push(min < 0 ? null : [min, max]);
    }
    return out;
  }, shot.toString("base64"));

  const problems = [];
  const TOLERANCE = 1.5;
  const selected = layout.boxes.filter((box) => box.selected);
  // No selection outside the selected lines' boxes, and each selected line's box filled.
  const top = Math.min(...selected.map((b) => b.top));
  const bottom = Math.max(...selected.map((b) => b.bottom));
  rows.forEach((span, y) => {
    if (span && (y < top - TOLERANCE || y > bottom + TOLERANCE)) {
      problems.push(`selection at y=${y}, outside the selected lines (${top}-${bottom})`);
    }
  });
  for (const box of selected) {
    const band = rows.slice(Math.ceil(box.top + 1), Math.floor(box.bottom - 1)).filter(Boolean);
    if (!box.text) continue;
    const height = Math.floor(box.bottom - 1) - Math.ceil(box.top + 1);
    if (band.length < height * 0.8)
      problems.push(`line ${box.index}: selection covers ${band.length}/${height} rows`);
    if (band.length === 0) continue;
    const left = Math.min(...band.map((s) => s[0]));
    const right = Math.max(...band.map((s) => s[1]));
    if (Math.abs(left - box.left) > TOLERANCE) {
      problems.push(
        `line ${box.index}: selection starts at ${left}, text at ${box.left.toFixed(1)}`,
      );
    }
    // The newline of a line that is not the last may be painted as one space.
    const slack = which === "all" && !box.last ? layout.space : 0;
    if (right < box.right - TOLERANCE || right > box.right + slack + TOLERANCE) {
      problems.push(
        `line ${box.index}: selection ends at ${right}, text at ${box.right.toFixed(1)}`,
      );
    }
  }
  return { problems, detail: { boxes: layout.boxes.slice(0, 3), space: layout.space } };
}

const FIG = {
  plain: ".portal-code-figure:nth-of-type(1)",
  edit: ".portal-code-figure:nth-of-type(2)",
  bash: ".portal-code-figure:nth-of-type(3)",
};

const { createPreviewServer } = await import(join(PKG, "dist", "verify", "preview.js"));
const servers = [];
async function serve(dir) {
  const server = createPreviewServer({ dir, port: 0 });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
}

/**
 * Playwright's own Chromium - what CI installs - and the pinned one only as a fallback, or when
 * `FREVA_PORTAL_CHROMIUM` names it. The same launcher the other suites use.
 */
async function launch() {
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  if (process.env.FREVA_PORTAL_CHROMIUM) {
    return chromium.launch({ args, executablePath: process.env.FREVA_PORTAL_CHROMIUM });
  }
  try {
    return await chromium.launch({ args });
  } catch (error) {
    if (existsSync("/opt/pw-browsers/chromium")) {
      return chromium.launch({ args, executablePath: "/opt/pw-browsers/chromium" });
    }
    throw error;
  }
}

let browser;
try {
  const edit = buildSite("edit");
  const hover = buildSite("hover", { editable: false, playground: "  controls: hover\n" });
  const framed = buildSite("framed", {
    playground: "  playgroundOrigin: https://play.example.org\n",
  });
  // A copy of the editable site whose editable snippet was changed after the build, the way the
  // digest exists to notice.
  const tampered = join(RUN, "tampered-built");
  cpSync(edit.out, tampered, { recursive: true });
  const guide = join(tampered, "docs", "guide", "index.html");
  writeFileSync(guide, readFileSync(guide, "utf8").replace("3.14159", "2.71828"));

  const base = {
    edit: await serve(edit.out),
    hover: await serve(hover.out),
    framed: await serve(framed.out),
    tampered: await serve(tampered),
  };
  const chunk = {
    edit: editorChunk(edit.out),
    hover: editorChunk(hover.out),
    framed: editorChunk(framed.out),
  };

  browser = await launch();

  async function withPage(
    url,
    fn,
    { phone = false, path = "docs/guide/", mode, viewport = { width: 1440, height: 900 } } = {},
  ) {
    const context = await browser.newContext({
      viewport: phone ? { width: 390, height: 844 } : viewport,
      ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
      // No transitions, so a computed opacity is the settled one.
      reducedMotion: "reduce",
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(url).origin,
    });
    const page = await context.newPage();
    const problems = [];
    const requests = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    page.on("pageerror", (error) => problems.push(String(error).slice(0, 200)));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) =>
        (window.__csp ??= []).push(`${event.effectiveDirective}: ${event.blockedURI}`),
      );
      // Every state a run control passes through, in order.
      window.__states = [];
      new MutationObserver((records) => {
        for (const record of records) {
          const target = record.target;
          if (target instanceof HTMLElement && target.matches(".portal-code-run")) {
            window.__states.push(target.dataset.state ?? "idle");
          }
        }
      }).observe(document, { attributes: true, attributeFilter: ["data-state"], subtree: true });
    });
    await page.addInitScript(STUB);
    try {
      await page.goto(`${url}${path}`, { waitUntil: "networkidle" });
      if (mode) await useMode(page, mode);
      await page.waitForSelector(".portal-code-run:not([hidden])", { timeout: 15_000 });
      await fn(page, { problems, requests });
      assert.deepEqual(await page.evaluate(() => window.__csp ?? []), [], "policy violations");
      assert.deepEqual(problems, [], "page errors");
    } finally {
      await context.close();
    }
  }

  const opacity = (page, selector) =>
    page.$eval(selector, (element) => getComputedStyle(element).opacity);
  const ran = (page) => page.evaluate(() => window.__ran);
  const settled = (page, figure) =>
    page.waitForFunction(
      (selector) => {
        const state = document.querySelector(`${selector} .portal-code-run`)?.dataset.state;
        return state === "done" || state === "error";
      },
      figure,
      { timeout: 10_000 },
    );
  /** Start editing the editable snippet by clicking into its code. */
  const startEditing = async (page) => {
    await page.click(`${FIG.edit} pre`);
    await page.waitForSelector(`${FIG.edit} .portal-code-editor-input`, { timeout: 10_000 });
  };

  // Feature: the controls are visible

  for (const phone of [false, true]) {
    const where = phone ? "a phone" : "a desktop";
    await check(`Copy and Try are visible without hover on ${where}`, () =>
      withPage(
        base.edit,
        async (page) => {
          for (const figure of [FIG.plain, FIG.edit]) {
            assert.equal(await opacity(page, `${figure} .portal-code-run`), "1", figure);
            assert.equal(await opacity(page, `${figure} .portal-code-copy`), "1", figure);
          }
          // A plain block keeps its quiet Copy on a device that can hover.
          assert.equal(await opacity(page, `${FIG.bash} .portal-code-copy`), phone ? "1" : "0");
          // The keyboard focus is still drawn.
          await page.keyboard.press("Tab");
          await page.focus(`${FIG.plain} .portal-code-run`);
          const outline = await page.$eval(`${FIG.plain} .portal-code-run`, (element) => {
            const style = getComputedStyle(element);
            return `${element.matches(":focus-visible")} ${style.outlineStyle} ${style.outlineWidth}`;
          });
          assert.equal(outline, "true solid 2px");
        },
        { phone },
      ),
    );
  }

  await check("controls: hover hides them until hover or focus, and never on a phone", async () => {
    await withPage(base.hover, async (page) => {
      const run = `${FIG.plain} .portal-code-run`;
      assert.equal(await opacity(page, run), "0");
      assert.equal(await opacity(page, `${FIG.plain} .portal-code-copy`), "0");
      await page.hover(`${FIG.plain} pre`);
      assert.equal(await opacity(page, run), "1");
      await page.mouse.move(0, 0);
      assert.equal(await opacity(page, run), "0");
      await page.keyboard.press("Tab");
      await page.focus(run);
      assert.equal(await opacity(page, run), "1");
    });
    await withPage(
      base.hover,
      async (page) => {
        assert.equal(await opacity(page, `${FIG.plain} .portal-code-run`), "1");
      },
      { phone: true },
    );
  });

  // Feature: editable snippets

  await check("no editor code is loaded when editing is off", () =>
    withPage(base.hover, async (page, { requests }) => {
      assert.equal(await page.locator("[data-portal-editable]").count(), 0);
      await page.click(`${FIG.edit} pre`);
      await page.click(`${FIG.edit} .portal-code-run`);
      await settled(page, FIG.edit);
      assert.ok(!requests.some((path) => path.endsWith(chunk.hover)), "the editor was fetched");
      assert.equal(await page.locator(".portal-code-editor-input").count(), 0);
    }),
  );

  await check("the editor is fetched on the first click into the code, and not before", () =>
    withPage(base.edit, async (page, { requests }) => {
      const has = () => requests.some((path) => path.endsWith(chunk.edit));
      // Pressing Try on the snippet unedited is not a reason to fetch an editor either.
      await page.click(`${FIG.edit} .portal-code-run`);
      await settled(page, FIG.edit);
      assert.ok(!has(), "the editor was fetched before anyone edited");
      await startEditing(page);
      assert.ok(has(), "the editor never arrived");
      const focused = await page.evaluate(() => document.activeElement?.className);
      assert.equal(focused, "portal-code-editor-input");
    }),
  );

  await check("an unedited press sends the registered example, digest-checked", () =>
    withPage(base.edit, async (page) => {
      await page.click(`${FIG.edit} .portal-code-run`);
      await settled(page, FIG.edit);
      assert.deepEqual(await ran(page), [{ title: "edit.py", source: EDIT }]);
    }),
  );

  await check("a snippet changed after the build is neither runnable nor editable", () =>
    withPage(base.tampered, async (page) => {
      assert.equal(await page.locator(`${FIG.edit} .portal-code-run:not([hidden])`).count(), 0);
      assert.equal(await page.locator(`${FIG.plain} .portal-code-run:not([hidden])`).count(), 1);
      await page.click(`${FIG.edit} pre`);
      await page.waitForTimeout(300);
      assert.equal(await page.locator(".portal-code-editor-input").count(), 0);
    }),
  );

  await check("an edited run executes the edited code, labelled as an edit", () =>
    withPage(base.edit, async (page) => {
      await startEditing(page);
      const input = `${FIG.edit} .portal-code-editor-input`;
      await page.$eval(input, (element) => element.setSelectionRange(0, 0));
      await page.keyboard.type("r = 3\n");
      await page.click(`${FIG.edit} .portal-code-run`);
      await settled(page, FIG.edit);
      const edited = `r = 3\n${EDIT}`;
      // The edited code exactly, so its line numbers are the editor's; the label is a comment
      // the console prints above it and does not run.
      assert.deepEqual(await ran(page), [
        { title: "Edited snippet · edit.py", source: edited, comment: "Edited snippet · edit.py" },
      ]);
      // The highlighted layer shows the same text the visitor typed, drawn as nodes.
      const view = await page.$eval(`${FIG.edit} .portal-code-editor-view`, (element) => ({
        text: element.textContent,
        keyword: element.querySelector(".tok-keyword")?.textContent,
      }));
      assert.equal(view.text, edited);
      assert.equal(view.keyword, "def");
      assert.equal(await page.locator(`${FIG.edit} [style]`).count(), 0, "a style attribute");
    }),
  );

  await check("Copy copies the edited text, and Reset restores the author's code", () =>
    withPage(base.edit, async (page) => {
      await startEditing(page);
      const reset = `${FIG.edit} .portal-code-reset`;
      assert.equal(await page.locator(`${reset}:not([hidden])`).count(), 0, "Reset before edits");
      await page.keyboard.press("Control+End");
      await page.keyboard.type("\nprint('mine')");
      assert.equal(await page.locator(`${reset}:not([hidden])`).count(), 1, "no Reset to press");
      await page.click(`${FIG.edit} .portal-code-copy`);
      await page.waitForTimeout(200);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(clip, `${EDIT}\nprint('mine')`);

      await page.click(reset);
      assert.equal(await page.$eval(`${FIG.edit} textarea`, (element) => element.value), EDIT);
      assert.equal(await page.locator(`${reset}:not([hidden])`).count(), 0, "Reset stayed");
      assert.equal(
        await page.$eval(`${FIG.edit} .portal-code-copy`, (element) => element.dataset.portalCopy),
        EDIT,
      );
      // Back to the author's code, a press is the registered example again.
      await page.click(`${FIG.edit} .portal-code-run`);
      await settled(page, FIG.edit);
      assert.deepEqual(await ran(page), [{ title: "edit.py", source: EDIT }]);
    }),
  );

  await check(
    "the keyboard: Enter opens, Tab indents, Ctrl+Enter runs, Escape then Tab leaves",
    () =>
      withPage(base.edit, async (page) => {
        await page.focus(`${FIG.edit} pre`);
        await page.keyboard.press("Enter");
        await page.waitForSelector(`${FIG.edit} .portal-code-editor-input:focus`, {
          timeout: 10_000,
        });
        await page.keyboard.press("Control+End");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Tab");
        await page.keyboard.type("pass");
        const value = () => page.$eval(`${FIG.edit} textarea`, (element) => element.value);
        assert.equal(await value(), `${EDIT}\n    pass`);
        await page.keyboard.press("Control+Enter");
        await settled(page, FIG.edit);
        assert.equal((await ran(page))[0]?.title, "Edited snippet · edit.py");
        await page.keyboard.press("Escape");
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() => document.activeElement?.className ?? "");
        assert.notEqual(focused, "portal-code-editor-input", "the keyboard is trapped");
        assert.equal(await value(), `${EDIT}\n    pass`, "Tab after Escape indented");
      }),
  );

  await check("presses queue, and the control shows running, then done or failed", () =>
    withPage(base.edit, async (page) => {
      const run = `${FIG.plain} .portal-code-run`;
      await page.click(run);
      await page.$eval(run, (element) => element.click());
      await page.waitForFunction(() => window.__ran.length === 2);
      await settled(page, FIG.plain);
      assert.deepEqual(
        (await ran(page)).map((r) => r.title),
        ["plain.py", "plain.py"],
      );
      // Running until BOTH have finished, then done once.
      const states = await page.evaluate(() => window.__states);
      assert.deepEqual(states.slice(0, 3), ["running", "running", "done"], JSON.stringify(states));
      assert.equal(await page.$eval(run, (element) => element.textContent?.trim()), "Done");

      await page.evaluate(() => (window.__failNext = true));
      // On the element: the terminal window is open over the page by now.
      await page.$eval(`${FIG.edit} .portal-code-run`, (element) => element.click());
      await page.waitForFunction(
        (selector) => document.querySelector(selector)?.dataset.state === "error",
        `${FIG.edit} .portal-code-run`,
        { timeout: 10_000 },
      );
      assert.equal(
        await page.$eval(`${FIG.edit} .portal-code-run`, (element) => element.textContent?.trim()),
        "Failed",
      );
    }),
  );

  await check("a program that raises shows Failed", () =>
    withPage(base.edit, async (page) => {
      await startEditing(page);
      await page.keyboard.press("Control+End");
      await page.keyboard.type("\nraise ValueError('no')");
      await page.keyboard.press("Control+Enter");
      await settled(page, FIG.edit);
      const run = `${FIG.edit} .portal-code-run`;
      assert.equal(await page.$eval(run, (element) => element.dataset.state), "error");
      assert.equal(await page.$eval(run, (element) => element.textContent?.trim()), "Failed");
      // It ran: raising is the program's outcome, not a refusal.
      assert.equal((await ran(page)).length, 1);
    }),
  );

  // Feature: an editable snippet reads as an editor

  const lineCount = (text) => text.split("\n").length;
  const numbersFor = (count) => Array.from({ length: count }, (_, i) => i + 1).join("\n");
  const gutterText = (page, figure) =>
    page.$eval(`${figure} .portal-code-gutter`, (element) => element.textContent);

  await check("an editable snippet reads as an editor before anyone clicks", () =>
    withPage(base.edit, async (page) => {
      assert.equal(await gutterText(page, FIG.edit), numbersFor(lineCount(EDIT)));
      const state = await page.evaluate((figures) => {
        const edit = document.querySelector(figures.edit);
        const gutter = edit.querySelector(".portal-code-gutter");
        const tag = edit.querySelector(".portal-code-editable");
        return {
          hidden: gutter.getAttribute("aria-hidden"),
          select: getComputedStyle(gutter).userSelect,
          tag: tag?.textContent,
          tagAfterLanguage: tag?.previousElementSibling?.classList.contains("portal-code-lang"),
          tagShown: Boolean(tag && tag.getBoundingClientRect().width > 0),
          edited: edit.querySelector(".portal-code-edited")?.hidden,
          cursor: getComputedStyle(edit.querySelector("pre")).cursor,
          // Read-only blocks get no gutter and no tag, and keep their inset.
          others: [figures.plain, figures.bash].map((selector) => {
            const figure = document.querySelector(selector);
            return {
              gutter: figure.querySelector(".portal-code-gutter") !== null,
              tag: figure.querySelector(".portal-code-editable") !== null,
              padding: getComputedStyle(figure.querySelector("pre")).paddingLeft,
              display: getComputedStyle(figure.querySelector("pre")).display,
            };
          }),
        };
      }, FIG);
      assert.deepEqual(state, {
        hidden: "true",
        select: "none",
        tag: "Editable",
        tagAfterLanguage: true,
        tagShown: true,
        edited: true,
        cursor: "text",
        others: [
          { gutter: false, tag: false, padding: "16px", display: "block" },
          { gutter: false, tag: false, padding: "16px", display: "block" },
        ],
      });
    }),
  );

  await check(
    "the gutter follows the line count; Edited marks a change and Reset clears both",
    () =>
      withPage(base.edit, async (page) => {
        await startEditing(page);
        await page.keyboard.press("Control+End");
        await page.keyboard.type("\nfirst = 1\nsecond = 2");
        const typed = await page.$eval(`${FIG.edit} textarea`, (element) => element.value);
        assert.equal(lineCount(typed), lineCount(EDIT) + 2);
        assert.equal(await gutterText(page, FIG.edit), numbersFor(lineCount(typed)));
        assert.equal(await page.$eval(`${FIG.edit} .portal-code-edited`, (e) => e.hidden), false);
        // Removing a line takes its number away again.
        await page.keyboard.press("Shift+Home");
        await page.keyboard.press("Backspace");
        await page.keyboard.press("Backspace");
        assert.equal(await gutterText(page, FIG.edit), numbersFor(lineCount(typed) - 1));
        await page.click(`${FIG.edit} .portal-code-reset`);
        assert.equal(await gutterText(page, FIG.edit), numbersFor(lineCount(EDIT)));
        assert.equal(await page.$eval(`${FIG.edit} .portal-code-edited`, (e) => e.hidden), true);
        assert.equal(await page.$eval(`${FIG.edit} .portal-code-reset`, (e) => e.hidden), true);
      }),
  );

  await check("Copy copies the code and never the line numbers", () =>
    withPage(base.edit, async (page) => {
      await page.click(`${FIG.edit} .portal-code-copy`);
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), EDIT);
      await startEditing(page);
      await page.keyboard.press("Control+Home");
      await page.keyboard.type("# mine\n");
      await page.click(`${FIG.edit} .portal-code-copy`);
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `# mine\n${EDIT}`);
    }),
  );

  await check("the current line is marked only while the editor has the focus", () =>
    withPage(base.edit, async (page) => {
      await startEditing(page);
      await page.keyboard.press("Control+Home");
      await page.keyboard.press("ArrowDown");
      const marked = () =>
        page.$$eval(`${FIG.edit} .portal-code-line`, (lines) =>
          lines.flatMap((line, i) => (line.classList.contains("is-current") ? [i] : [])),
        );
      assert.deepEqual(await marked(), [1]);
      const background = await page.$eval(
        `${FIG.edit} .portal-code-line.is-current`,
        (line) => getComputedStyle(line).backgroundColor,
      );
      assert.notEqual(background, "rgba(0, 0, 0, 0)");
      await page.keyboard.press("ArrowDown");
      assert.deepEqual(await marked(), [2]);
      await page.$eval(`${FIG.edit} textarea`, (element) => element.blur());
      assert.deepEqual(await marked(), []);
    }),
  );

  const PROPS = [
    "fontFamily",
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "wordSpacing",
    "fontVariantLigatures",
    "fontFeatureSettings",
    "fontKerning",
    "tabSize",
    "paddingTop",
    "paddingBottom",
    "borderTopWidth",
    "whiteSpace",
  ];
  for (const place of PLACES) {
    for (const phone of [false, true]) {
      const where = `${place.name}${phone ? ", phone" : ""}`;

      await check(`the textarea and the code under it share every text metric (${where})`, () =>
        withPage(
          base.edit,
          async (page) => {
            await openEditor(page, place.figure);
            const measured = await page.evaluate(
              ({ figure, props }) => {
                const pick = (element) =>
                  Object.fromEntries(props.map((p) => [p, getComputedStyle(element)[p]]));
                const root = document.querySelector(figure);
                const input = root.querySelector("textarea");
                const line = root.querySelector(".portal-code-line");
                const view = root.querySelector(".portal-code-editor-view");
                const gutter = root.querySelector(".portal-code-gutter");
                const box = (element) => element.getBoundingClientRect();
                return {
                  input: pick(input),
                  view: pick(view),
                  line: pick(line),
                  gutter: {
                    size: getComputedStyle(gutter).fontSize,
                    height: getComputedStyle(gutter).lineHeight,
                  },
                  // Where the text starts, in each: the same pixel.
                  inputText: box(input).left + parseFloat(getComputedStyle(input).paddingLeft),
                  lineText: box(line).left + parseFloat(getComputedStyle(line).paddingLeft),
                  tops: [box(input).top, box(view).top],
                  heights: [box(input).height, box(view).height],
                };
              },
              { figure: place.figure, props: PROPS },
            );
            assert.deepEqual(measured.view, measured.input, "view");
            assert.deepEqual(measured.line, measured.input, "line");
            assert.deepEqual(
              measured.gutter,
              { size: measured.input.fontSize, height: measured.input.lineHeight },
              "gutter",
            );
            assert.equal(measured.inputText, measured.lineText);
            assert.equal(measured.tops[0], measured.tops[1]);
            assert.equal(measured.heights[0], measured.heights[1]);
          },
          { path: place.path, phone },
        ),
      );

      await check(`a click lands the caret on the character under it (${where})`, () =>
        withPage(
          base.edit,
          async (page) => {
            await openEditor(page, place.figure);
            // The longest line, scrolled to its end: the gutter must stay put while it scrolls.
            const target = await page.evaluate((figure) => {
              const root = document.querySelector(figure);
              const pre = root.querySelector("pre");
              const gutter = root.querySelector(".portal-code-gutter");
              const before = gutter.getBoundingClientRect().left;
              pre.scrollLeft = pre.scrollWidth;
              const input = root.querySelector("textarea");
              const lines = input.value.split("\n");
              const index = lines.reduce(
                (best, line, i) => (line.length > lines[best].length ? i : best),
                0,
              );
              const view = root.querySelectorAll(".portal-code-line")[index];
              const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
              let last = null;
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (node.textContent.replace(/\n$/, "")) last = node;
              }
              const text = last.textContent.replace(/\n$/, "");
              const range = document.createRange();
              range.setStart(last, text.length - 1);
              range.setEnd(last, text.length);
              const glyph = range.getBoundingClientRect();
              const start = lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0);
              return {
                y: glyph.top + glyph.height / 2,
                left: glyph.left + 1,
                right: glyph.right - 1,
                end: start + lines[index].length,
                scrolled: pre.scrollLeft,
                gutterMoved: gutter.getBoundingClientRect().left - before,
                inView: glyph.right <= pre.getBoundingClientRect().right,
              };
            }, place.figure);
            assert.equal(target.gutterMoved, 0, "the gutter scrolled away");
            assert.ok(target.inView, JSON.stringify(target));
            const caret = () =>
              page.$eval(`${place.figure} textarea`, (element) => element.selectionStart);
            await page.mouse.click(target.left, target.y);
            assert.equal(
              await caret(),
              target.end - 1,
              `left half of the last glyph ${JSON.stringify(target)}`,
            );
            await page.mouse.click(target.right, target.y);
            assert.equal(await caret(), target.end, "right half of the last glyph");
            // On a phone the block scrolls, and the page does not.
            const page_ = await page.evaluate(() => ({
              scroll: document.scrollingElement.scrollWidth,
              width: window.innerWidth,
            }));
            assert.ok(page_.scroll <= page_.width, JSON.stringify(page_));
            if (phone)
              assert.ok(target.scrolled > 0, "the long line did not make the block scroll");
          },
          { path: place.path, phone },
        ),
      );

      await check(`a selection is drawn exactly over the text it selects (${where})`, () =>
        withPage(
          base.edit,
          async (page) => {
            await openEditor(page, place.figure);
            for (const which of ["line", "all"]) {
              const result = await selectionAgainstText(page, place.figure, which);
              assert.deepEqual(result.problems, [], `${which}: ${JSON.stringify(result.detail)}`);
            }
          },
          { path: place.path, phone },
        ),
      );
    }
  }

  for (const mode of ["light", "dark"]) {
    await check(`the gutter and the header tags are readable in ${mode} mode`, () =>
      withPage(
        base.edit,
        async (page) => {
          await startEditing(page);
          await page.keyboard.type("x");
          const colours = await page.evaluate((figure) => {
            const root = document.querySelector(figure);
            const style = (selector) => getComputedStyle(root.querySelector(selector));
            return {
              gutter: [
                style(".portal-code-gutter").color,
                style(".portal-code-gutter").backgroundColor,
              ],
              tag: [
                style(".portal-code-editable").color,
                style(".portal-code-head").backgroundColor,
              ],
              edited: [
                style(".portal-code-edited").color,
                style(".portal-code-head").backgroundColor,
              ],
            };
          }, FIG.edit);
          for (const [name, [fg, bg]] of Object.entries(colours)) {
            const ratio = contrastOf(fg, bg);
            assert.ok(ratio >= 4.5, `${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
          }
        },
        { mode },
      ),
    );
  }

  await check("a phone shows the header tags as an icon and a dot, and nothing overflows", () =>
    withPage(
      base.edit,
      async (page) => {
        await startEditing(page);
        await page.keyboard.type("x");
        const layout = await page.evaluate((figure) => {
          const head = document.querySelector(`${figure} .portal-code-head`);
          return {
            head: head.scrollWidth <= head.clientWidth,
            page: document.scrollingElement.scrollWidth <= window.innerWidth,
            // The words are still there for a screen reader.
            words: [...head.querySelectorAll(".portal-code-editable, .portal-code-edited")].map(
              (e) => e.textContent,
            ),
            // …and take no room on screen.
            shown: [...head.querySelectorAll('[class$="-label"]')]
              .filter((e) => e.closest(".portal-code-editable, .portal-code-edited"))
              .map((e) => e.getBoundingClientRect().width > 1),
          };
        }, FIG.edit);
        assert.deepEqual(layout, {
          head: true,
          page: true,
          words: ["Edited", "Editable"],
          shown: [false, false],
        });
      },
      { phone: true },
    ),
  );

  // Feature: the measure is for running text; wide content takes the panel

  /** Edges, in the page's pixels, of the prose, its container and what is in it. */
  const LAYOUT = () => {
    const prose = document.querySelector(
      ".portal-document > .portal-prose, .portal-content-body > .portal-prose",
    );
    const panel = prose.parentElement;
    const box = (element) => element.getBoundingClientRect();
    const style = getComputedStyle(panel);
    const inner = {
      left: box(panel).left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth),
      right: box(panel).right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth),
    };
    // 108 of the prose's own "0", measured rather than trusted.
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(108);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    prose.append(probe);
    const measure = box(probe).width;
    probe.remove();
    const paragraph = [...prose.querySelectorAll(":scope > p")].sort(
      (a, b) => box(b).height - box(a).height,
    )[0];
    const lines = (() => {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    })();
    const wide = [".portal-cardgrid", ".portal-code-figure"]
      .map((selector) => prose.querySelector(`:scope > ${selector}`))
      .filter(Boolean)
      .map((element) => ({ name: element.className.split(" ")[0], ...box(element).toJSON() }));
    return {
      inner,
      prose: box(prose).toJSON(),
      measure,
      paragraph: { left: box(paragraph).left, width: box(paragraph).width, lines },
      wide,
      overflow: document.scrollingElement.scrollWidth - window.innerWidth,
    };
  };

  for (const place of [
    { name: "a landing prose block", path: "" },
    { name: "a docs page", path: "docs/guide/" },
  ]) {
    await check(
      `running text keeps the measure, wide content takes the panel (${place.name})`,
      () =>
        withPage(
          base.edit,
          async (page) => {
            const layout = await page.evaluate(LAYOUT);
            const near = (a, b) => Math.abs(a - b) <= 1;
            const detail = JSON.stringify(layout);
            // The prose block is the panel's width, not the measure's.
            assert.ok(near(layout.prose.right, layout.inner.right), `prose ${detail}`);
            assert.ok(
              layout.inner.right - layout.inner.left > layout.measure + 40,
              `panel ${detail}`,
            );
            // Running text wraps, and at no more than 108ch.
            assert.ok(layout.paragraph.lines > 1, `paragraph did not wrap ${detail}`);
            assert.ok(layout.paragraph.width <= layout.measure + 1, `paragraph ${detail}`);
            // Wide content meets the panel's inner edge, from the same left edge as the text.
            assert.ok(layout.wide.length >= (place.path ? 1 : 2), `wide ${detail}`);
            for (const item of layout.wide) {
              assert.ok(near(item.right, layout.inner.right), `${item.name} right ${detail}`);
              assert.ok(near(item.left, layout.paragraph.left), `${item.name} left ${detail}`);
            }
            assert.equal(layout.overflow, 0, `overflow ${detail}`);
          },
          { path: place.path, viewport: { width: 1456, height: 900 } },
        ),
    );

    await check(`no horizontal overflow at 390px (${place.name})`, () =>
      withPage(
        base.edit,
        async (page) => {
          const layout = await page.evaluate(LAYOUT);
          assert.equal(layout.overflow, 0, JSON.stringify(layout));
          for (const item of layout.wide) {
            assert.ok(item.right <= layout.inner.right + 1, JSON.stringify(layout));
          }
        },
        { path: place.path, phone: true },
      ),
    );
  }

  await check("with playgroundOrigin, editing is off and the build says why (FP1227)", async () => {
    assert.match(framed.log, /FP1227/);
    assert.ok(
      !readFileSync(join(framed.out, "docs/guide/index.html"), "utf8").includes(
        "data-portal-editable",
      ),
    );
    await withPage(base.framed, async (page, { requests }) => {
      assert.equal(await page.locator("[data-portal-editable]").count(), 0);
      await page.click(`${FIG.edit} pre`);
      await page.waitForTimeout(300);
      assert.equal(await page.locator(".portal-code-editor-input").count(), 0);
      assert.ok(!requests.some((path) => path.endsWith(chunk.framed)), "the editor was fetched");
    });
  });
} catch (error) {
  console.error(error);
  results.push({ name: "the suite ran at all", ok: false });
} finally {
  await browser?.close();
  for (const server of servers) server.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} code snippet checks passed`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
