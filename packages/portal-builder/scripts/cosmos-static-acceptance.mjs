#!/usr/bin/env node
// COSMOS STATIC ACCEPTANCE - one command, two builds, no DevTools. Two questions, written down.
//
//   node scripts/cosmos-static-acceptance.mjs --dir <after> [--before <before>] [--out <dir>]
//
//   1. IS THE SCENE ACTUALLY STILL? Not "does it look still": every element under the Cosmos root
//      is asked for its Web Animations objects, the document for its CSS animations and
//      transitions, the LIVE dot for its pulse, and every subject the brief removes is looked for
//      by name. A scene with a PAUSED animation passes a screenshot and fails here.
//   2. WHAT DOES IT COST, AGAINST THE BUILD IT REPLACES? The same content, viewport, device pixel
//      ratio and theme, in three shapes: repeated stationary windows at the sky and at the coast,
//      a full down-and-back traversal, and repeated light/dark switches.
//
// What it measures, and what it refuses to claim:
//
//   - Browser CPU in ms per wall second, from two `SystemInfo.getProcessInfo` snapshots. These are
//     ENDPOINT COUNTERS: a process that started and exited inside a window is invisible to them,
//     and one that appeared or vanished makes the TOTAL unavailable, not a subtotal of survivors.
//   - Paint call counts by target name, inside explicit `performance.mark` boundaries and divided
//     by the interval those marks actually span. They nest: a count is not a frame rate.
//   - Main-thread CALLBACK GAPS, maximum included, from a `requestAnimationFrame` chain the RUNNER
//     owns - the page has no frame loop. A gap is between callbacks, NOT presented-frame timing: a
//     frame the compositor never showed leaves no gap, so this is responsiveness, not smoothness.
//   - THEME READINESS: when `data-theme` and the scene's `data-sky` agree and the rebuild has
//     settled. Explicitly not the time to a presented frame, which needs a display.
//
// Reporting rules:
//
//   - MEDIAN is the arithmetic mean of the middle pair for an even sample count, not nearest-rank.
//   - AN EXTERNAL RESPONSE is an http(s) one; `data:` and `blob:` are not fetches off this origin.
//     FAILED requests are reported separately: a machine that could not reach a configured source
//     measured a different foreground.
//   - A window is kept only if its invariants held at the close as well as at the open. Failed
//     windows are listed with their reason and EXCLUDED from every summary.
//   - No CPU threshold is asserted: a ceiling inferred from runs with a different layout and
//     foreground would be a number dressed as a gate. What is asserted is structural - no
//     animation objects, no removed subject, no recurring idle Paint from Cosmos or the LIVE dot.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const RUNNER = "cosmos-static-acceptance 1.0.0";

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes("--" + n);

const AFTER = resolve(arg("dir", "build/portal"));
const BEFORE = arg("before") ? resolve(arg("before")) : null;
const OUT = resolve(
  arg("out", `cosmos-acceptance-${new Date().toISOString().replace(/[:.]/g, "")}`),
);
const WINDOW_S = Number(arg("window", "20"));
const REPEATS = Number(arg("repeats", "2"));
const SWITCHES = Number(arg("switches", "6"));
const PORT = Number(arg("port", "4407"));
const VW = Number(arg("vw", "1440"));
const VH = Number(arg("vh", "813"));
const DPR = Number(arg("dpr", "2"));
const THEMES = (arg("themes", "dark,light") || "").split(",").filter(Boolean);
const CHROME = arg("chrome", process.env.COSMOS_CHROME);
const CHANNEL = arg("channel", CHROME ? undefined : "chrome");

const log = (s) => process.stdout.write(s + "\n");
const cleanup = [];
let save = () => {};
async function shutdown() {
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      // going down anyway
    }
  }
}
const die = async (lines) => {
  console.error("\n" + (Array.isArray(lines) ? lines.join("\n") : lines) + "\n");
  try {
    save();
  } catch {
    // nothing to save yet
  }
  await shutdown();
  process.exit(1);
};
process.on("SIGINT", () => void shutdown().then(() => process.exit(130)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(143)));

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  await die([
    "This runner needs Playwright, which drives the browser and collects the trace.",
    "",
    "  npm install          # in THIS checkout, then re-run",
  ]);
}

// Artifacts.

/** A build's identity: the digest of every file it contains, so a result names what produced it. */
function identify(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const files = [];
  const walk = (at, rel) => {
    for (const e of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(at, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else
        files.push({
          path: r,
          digest: createHash("sha256").update(readFileSync(full)).digest("hex"),
          bytes: statSync(full).size,
        });
    }
  };
  walk(dir, "");
  const artifact = createHash("sha256")
    .update(files.map((f) => `${f.path}:${f.digest}`).join("\n"))
    .digest("hex");
  const cosmos = files.filter((f) => f.path.startsWith("_cosmos/")).map((f) => f.path);
  return {
    dir,
    files: files.length,
    bytes: files.reduce((s, f) => s + f.bytes, 0),
    artifactSha256: artifact,
    cosmosAssets: cosmos,
  };
}

const afterId = identify(AFTER);
if (!afterId) await die(`No built artifact at ${AFTER}.`);
const beforeId = BEFORE ? identify(BEFORE) : null;
if (BEFORE && !beforeId) await die(`No built artifact at ${BEFORE}.`);

// Servers.

async function portFree(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.once("listening", () => probe.close(() => done(true)));
    probe.listen(port, "127.0.0.1");
  });
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LOCAL = resolve(HERE, "..", "..", "..", "node_modules", ".bin", "freva-portal-builder");
const BIN = arg("builder", process.env.FREVA_PORTAL_BUILDER || (existsSync(LOCAL) ? LOCAL : null));
if (!BIN || !existsSync(BIN)) {
  await die([
    "The preview server (`freva-portal-builder`) is not available.",
    "",
    "  npm install          # in this checkout, then re-run",
  ]);
}

// A binary that exists is not a binary that runs: `bin/freva-portal-builder.mjs` imports
// `../dist/index.js`, `npm install` does not produce it, and building this one package cannot work
// from a clean extraction because it compiles against its siblings' declarations. So the
// repository's own bootstrap runs, and it touches neither the portal artifact, the STAC materials
// nor the Python helper.
const pkgDir = (() => {
  try {
    return dirname(dirname(realpathSync(BIN)));
  } catch {
    return null;
  }
})();
const distEntry = pkgDir ? join(pkgDir, "dist", "index.js") : null;
if (distEntry && !existsSync(distEntry)) {
  const repoRoot = resolve(pkgDir, "..", "..");
  const bootstrap = join(repoRoot, "scripts", "bootstrap.mjs");
  log(`\n  The preview server is not compiled yet. Running the workspace bootstrap once.\n`);
  const built = existsSync(bootstrap)
    ? spawnSync(process.execPath, [bootstrap, "--build"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "inherit", "pipe"],
      })
    : spawnSync("npm", ["run", "build"], {
        cwd: pkgDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
  if (built.status !== 0 || !existsSync(distEntry)) {
    await die([
      "Could not compile the preview server.",
      "",
      `  in: ${repoRoot}`,
      "  node scripts/bootstrap.mjs --build",
      "",
      (built.stderr || built.stdout || "").trim().slice(0, 2000),
    ]);
  }
  log("  Built.\n");
}

async function serve(dir, port) {
  if (!(await portFree(port))) await die(`Port ${port} is already in use. Use --port.`);
  const child = spawn(BIN, ["preview", "--dir", dir, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  let died = null;
  child.on("error", (e) => (died = e.message));
  child.on("exit", (c, s) => (died ??= `preview exited (${s || `code ${c}`})`));
  cleanup.push(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120 && !died; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      if ((await fetch(base + "/")).ok) return base;
    } catch {
      // not listening yet
    }
  }
  await die([died || `preview did not come up on ${base}`, out.trim()]);
  return base;
}

// Browser.

const browser = await chromium
  .launch({
    headless: flag("headless"),
    ...(CHROME ? { executablePath: CHROME } : {}),
    ...(CHANNEL && !CHROME ? { channel: CHANNEL } : {}),
  })
  .catch(async (e) => {
    await die([
      "Could not launch a browser.",
      "",
      "  --channel chrome | msedge | chromium",
      "  --chrome /path/to/binary",
      "",
      String(e.message || e),
    ]);
  });
cleanup.push(() => browser.close());
const cdp = await browser.newBrowserCDPSession();

/** Which renderer did we actually get? Headed Chrome is not the same claim as hardware rendering. */
const backend = await (async () => {
  try {
    const info = await cdp.send("SystemInfo.getInfo");
    const status = info?.gpu?.featureStatus ?? {};
    const raster = status.rasterization ?? "unknown";
    return {
      rasterization: raster,
      gpuCompositing: status.gpu_compositing ?? "unknown",
      hardwareRendering: /^enabled/i.test(String(raster)) && !/software/i.test(String(raster)),
      glRenderer: info?.gpu?.auxAttributes?.glRenderer ?? null,
    };
  } catch (e) {
    return { error: String(e.message || e), hardwareRendering: null };
  }
})();

// The page.

/**
 * Everything the page is asked about itself, installed once and called by name. Nothing here
 * changes the page: `__probe` reads, `__gaps` is the runner's own instrument, `__mark` writes a
 * trace boundary.
 */
const PAGE = () => {
  const host = () => document.querySelector(".portal-cosmos");

  // EVERY ANIMATION UNDER THE SCENE, not every running one: `getAnimations()` returns paused
  // animations too, and a scene that installs its keyframes and pauses them is one attribute away
  // from moving again.
  const sceneAnimations = () => {
    const h = host();
    if (!h) return [];
    const out = [];
    for (const el of [h, ...h.querySelectorAll("*")]) {
      for (const a of el.getAnimations()) {
        out.push({
          name: a.animationName ?? a.transitionProperty ?? a.constructor.name,
          playState: a.playState,
          node:
            el.tagName.toLowerCase() +
            (el.className ? "." + String(el.className).split(/\s+/)[0] : ""),
        });
      }
    }
    return out;
  };

  const liveDot = () => {
    const dot = document.querySelector(".dataset-tree__mode--live .dataset-tree__dot");
    if (!dot) return { present: false, animations: 0, boxShadow: null };
    return {
      present: true,
      animations: dot.getAnimations().length,
      boxShadow: getComputedStyle(dot).boxShadow,
      labelled: !!dot.closest(".dataset-tree__mode--live")?.textContent?.trim(),
    };
  };

  window.__probe = () => {
    const h = host();
    const doc = document.documentElement;
    return {
      present: !!h,
      theme: doc.dataset.theme ?? null,
      sky: h ? (h.dataset.sky ?? null) : null,
      state: doc.dataset.portalCosmos ?? null,
      hidden: document.hidden,
      scrollY: Math.round(window.scrollY),
      pageHeight: Math.round(doc.scrollHeight),
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      sceneAnimations: sceneAnimations(),
      // Animations ANYWHERE on the page, so a claim about the scene is not quietly a claim about
      // the whole document. The foreground has its own.
      documentAnimations: document.getAnimations().length,
      liveDot: liveDot(),
      // The stage machinery, which must not be present.
      legacy: {
        dataLive: h ? (h.dataset.live ?? null) : null,
        dataMotion: h ? (h.dataset.motion ?? null) : null,
        zoneStrips: document.querySelectorAll(".portal-cosmos .zone[data-zone]").length,
        animClass: document.querySelectorAll(".portal-cosmos .anim").length,
        dataZ: document.querySelectorAll(".portal-cosmos [data-z]").length,
      },
      // The subjects the brief removes, by the marks they would leave in the DOM.
      removedSubjects: {
        labels: [...document.querySelectorAll(".portal-cosmos .lbl")].map((n) =>
          n.textContent.trim(),
        ),
        images: [...document.querySelectorAll(".portal-cosmos img")].map((n) =>
          (n.currentSrc || n.src).split("/").pop(),
        ),
      },
      // What the scene DOES draw, so "nothing moves" is not satisfied by "nothing is there".
      kept: {
        canvases: document.querySelectorAll(".portal-cosmos canvas").length,
        svgs: document.querySelectorAll(".portal-cosmos svg").length,
        layers: document.querySelectorAll(".portal-cosmos .lyr").length,
        caption: document.querySelector(".portal-cosmos .cap")?.textContent?.trim() ?? null,
      },
    };
  };

  // THE RUNNER'S OWN FRAME CHAIN. The page has no frame loop; this one belongs to the measurement
  // and reports main-thread responsiveness. Started and stopped explicitly, its own cost is
  // present in every window equally, before and after, which is what makes the comparison fair.
  let gaps = null;
  window.__gaps = {
    start() {
      gaps = { last: performance.now(), samples: [], max: 0 };
      const tick = (t) => {
        if (!gaps) return;
        const dt = t - gaps.last;
        gaps.last = t;
        gaps.samples.push(dt);
        if (dt > gaps.max) gaps.max = dt;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    stop() {
      if (!gaps) return null;
      const s = gaps.samples.slice(1).sort((a, b) => a - b);
      const out = s.length
        ? {
            callbacks: s.length,
            medianMs: +(
              s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2
            ).toFixed(2),
            p95Ms: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(2),
            maxMs: +gaps.max.toFixed(2),
            note: "gaps between the RUNNER's own rAF callbacks; not presented-frame timing",
          }
        : null;
      gaps = null;
      return out;
    },
  };

  window.__mark = (name) => performance.mark(name);

  // A THEME SWITCH, TIMED TO READINESS: the root's `data-theme` is the new one, the scene's
  // `data-sky` agrees, and the deferred rebuild the island schedules has run. That last part is
  // why this waits for a frame and then a task rather than resolving on the attribute write, and
  // why the number is readiness, not "time to a new frame on the glass", unavailable from here.
  window.__switchTheme = (to) =>
    new Promise((done) => {
      const t0 = performance.now();
      const doc = document.documentElement;
      const want = to === "dark" ? "night" : "day";
      doc.dataset.theme = to;
      const settled = () => {
        const h = document.querySelector(".portal-cosmos");
        return doc.dataset.theme === to && (!h || h.dataset.sky === want);
      };
      const check = (tries) => {
        if (settled() || tries <= 0) {
          requestAnimationFrame(() =>
            setTimeout(
              () => done({ to, readyMs: +(performance.now() - t0).toFixed(2), settled: settled() }),
              0,
            ),
          );
          return;
        }
        requestAnimationFrame(() => setTimeout(() => check(tries - 1), 0));
      };
      check(240);
    });
};

// Measurement.

const procKey = (p) => `${p.type}#${p.id}`;
async function processCpu() {
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
  return { at: Date.now(), byKey: new Map(processInfo.map((p) => [procKey(p), p])) };
}
function cpuDelta(a, b) {
  const seconds = (b.at - a.at) / 1000;
  const gone = [...a.byKey.keys()].filter((k) => !b.byKey.has(k));
  const born = [...b.byKey.keys()].filter((k) => !a.byKey.has(k));
  const byType = {};
  for (const [k, after] of b.byKey) {
    const before = a.byKey.get(k);
    if (!before) continue;
    const ms = (after.cpuTime - before.cpuTime) * 1000;
    byType[after.type] = +((byType[after.type] || 0) + ms).toFixed(2);
  }
  const perType = {};
  for (const [t, ms] of Object.entries(byType)) perType[t] = +(ms / seconds).toFixed(2);
  const complete = gone.length === 0 && born.length === 0;
  return {
    seconds: +seconds.toFixed(3),
    perTypeMsPerS: perType,
    totalMsPerS: complete
      ? +(Object.values(byType).reduce((s, v) => s + v, 0) / seconds).toFixed(2)
      : null,
    totalUnavailableBecause: complete
      ? null
      : `process set changed (exited: ${gone.join(", ") || "none"}; started: ${born.join(", ") || "none"})`,
    caveat:
      "endpoint counters: a process that both started and exited inside the window is not counted",
  };
}

const TRACE_CATEGORIES = [
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "devtools.timeline",
  "blink.user_timing",
];

/**
 * One measured window, bounded by two marks that are themselves in the trace. `during` runs
 * between the marks, so a traversal or a run of theme switches is measured by the same code path
 * as a stationary window rather than by a second one that could disagree with it.
 */
async function window_(page, seconds, index, during) {
  const events = [];
  const onData = (e) => events.push(...e.value);
  cdp.on("Tracing.dataCollected", onData);
  const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: { includedCategories: TRACE_CATEGORIES, recordMode: "recordAsMuchAsPossible" },
  });
  await page.evaluate(() => {
    window.__mark("cosmos:start");
    window.__gaps.start();
  });
  const before = await processCpu();
  const payload = during
    ? await during()
    : await new Promise((r) => setTimeout(() => r(null), seconds * 1000));
  const after = await processCpu();
  const gaps = await page.evaluate(() => {
    window.__mark("cosmos:end");
    return window.__gaps.stop();
  });
  await cdp.send("Tracing.end");
  await done;
  cdp.off("Tracing.dataCollected", onData);

  const markTs = (name) =>
    events.find((e) => e.name === name && typeof e.ts === "number")?.ts ?? null;
  const startTs = markTs("cosmos:start");
  const endTs = markTs("cosmos:end");
  const bounded = startTs !== null && endTs !== null && endTs > startTs;
  const tracedSeconds = bounded ? (endTs - startTs) / 1e6 : null;
  const inWindow = bounded
    ? events.filter((e) => typeof e.ts === "number" && e.ts >= startTs && e.ts <= endTs)
    : events;

  const paint = {};
  let paintTotal = 0;
  for (const ev of inWindow) {
    if (ev.name !== "Paint" || ev.ph === "e") continue;
    paintTotal++;
    const node = ev.args?.data?.nodeName;
    if (node) paint[node] = (paint[node] || 0) + 1;
  }
  const per = (n) => (tracedSeconds ? +(n / tracedSeconds).toFixed(2) : null);
  const byTarget = Object.entries(paint)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([nodeName, count]) => ({ nodeName, count, perSecond: per(count) }));

  mkdirSync(join(OUT, "traces"), { recursive: true });
  const traceFile = join(OUT, "traces", `window-${String(index).padStart(3, "0")}.json.gz`);
  writeFileSync(
    traceFile,
    gzipSync(
      JSON.stringify({
        window: { startTs, endTs, tracedSeconds, requestedSeconds: seconds },
        cpuEndpoints: {
          before: { at: before.at, processes: [...before.byKey.values()] },
          after: { at: after.at, processes: [...after.byKey.values()] },
        },
        traceEvents: inWindow,
      }),
    ),
  );

  return {
    cpu: cpuDelta(before, after),
    boundaries: {
      bounded,
      tracedSeconds: tracedSeconds === null ? null : +tracedSeconds.toFixed(3),
      requestedSeconds: seconds,
    },
    paint: { total: paintTotal, perSecond: per(paintTotal), byTarget },
    callbackGaps: gaps,
    payload,
    traceFile,
    traceEvents: inWindow.length,
  };
}

// The runs.

const median = (values) => {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return +(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2).toFixed(2);
};

const results = {
  runner: RUNNER,
  when: new Date().toISOString(),
  artifacts: { after: afterId, before: beforeId },
  conditions: {
    requestedViewport: `${VW}x${VH}`,
    requestedDevicePixelRatio: DPR,
    themes: THEMES,
    browser: await browser.version(),
    launchedVia: CHROME ? `executablePath ${CHROME}` : `channel ${CHANNEL}`,
    headless: flag("headless"),
    renderingBackend: backend,
    windowSeconds: WINDOW_S,
    repeats: REPEATS,
    themeSwitches: SWITCHES,
  },
  reporting: {
    median: "arithmetic mean of the middle pair for an even sample count",
    externalResponse: "http(s) only; data: and blob: are not external fetches",
    cpu: "browser CPU ms per wall second from two endpoint snapshots; null when the process set changed",
    paint:
      "counts of trace Paint events between two performance marks, divided by the interval those marks span",
    callbackGaps:
      "gaps between the RUNNER's own requestAnimationFrame callbacks, including the maximum - main-thread responsiveness, NOT presented-frame timing",
    themeReadiness:
      "time until data-theme and the scene's data-sky agree and the deferred rebuild has run - NOT time to a presented frame",
    thresholds:
      "none asserted for CPU; earlier runs had a different layout and foreground, and a universal ceiling derived from them would be a number dressed as a gate",
  },
  stillness: {},
  windows: [],
  excludedWindows: [],
  summary: {},
  externalHttpResponses: [],
  externalRequestsThatFailed: [],
  consoleErrors: [],
};

save = () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
};

let index = 0;

/** Open one build, in one theme, warmed and settled. Returns the page and its first probe. */
async function open(base, theme, seen) {
  const context = await browser.newContext({
    viewport: { width: VW, height: VH },
    deviceScaleFactor: DPR,
    colorScheme: theme,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  await page.addInitScript(PAGE);
  page.on("response", (r) => {
    const url = r.url();
    if (!/^https?:/i.test(url) || url.startsWith(base)) return;
    seen.responses.push({ url, status: r.status() });
  });
  page.on("requestfailed", (r) => {
    const url = r.url();
    if (!/^https?:/i.test(url) || url.startsWith(base)) return;
    seen.failed.push({ url, failure: r.failure()?.errorText || "unknown" });
  });
  page.on("console", (m) => m.type() === "error" && seen.console.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => seen.console.push("pageerror: " + String(e.message).slice(0, 200)));

  await page.goto(base + "/", { waitUntil: "load" });
  await page.waitForTimeout(6000);
  await page.evaluate(() =>
    Promise.race([
      Promise.all([...document.images].map((i) => i.decode().catch(() => {}))),
      new Promise((r) => setTimeout(r, 5000)),
    ]),
  );
  // Warm both routes once, then come back, so nothing in a measured window is first-visit work.
  const height = await page.evaluate(async () => {
    const h = document.documentElement.scrollHeight;
    for (let y = 0; y <= h; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
    return h;
  });
  await page.waitForTimeout(1500);
  return { context, page, height, probe: await page.evaluate(() => window.__probe()) };
}

/** A window, guarded at open and close. A window whose invariants moved is listed, never averaged. */
async function measured(page, label, build, theme, position, seconds, during) {
  const n = ++index;
  const before = await page.evaluate(() => window.__probe());
  const m = await window_(page, seconds, n, during);
  const after = await page.evaluate(() => window.__probe());
  const bad = [];
  if (before.hidden || after.hidden) bad.push("the page was hidden");
  if (before.theme !== after.theme && position !== "theme-switch")
    bad.push(`theme changed: ${before.theme} -> ${after.theme}`);
  if (before.viewport !== after.viewport)
    bad.push(`viewport changed: ${before.viewport} -> ${after.viewport}`);
  if (before.devicePixelRatio !== DPR) bad.push(`devicePixelRatio is ${before.devicePixelRatio}`);
  if (position !== "traversal" && position !== "theme-switch" && before.scrollY !== after.scrollY) {
    bad.push(`scroll changed: ${before.scrollY} -> ${after.scrollY}`);
  }
  if (!m.boundaries.bounded) bad.push("the window's performance marks were not found in the trace");
  const valid = bad.length === 0;
  const row = {
    index: n,
    build,
    theme,
    position,
    label,
    valid,
    why: valid ? null : bad,
    probe: { before, after },
    measured: m,
  };
  results.windows.push(row);
  if (!valid) results.excludedWindows.push({ index: n, build, theme, position, label, why: bad });
  const doc = m.paint.byTarget.find((p) => p.nodeName === "#document");
  log(
    `  ${build.padEnd(6)} ${theme.padEnd(5)} ${label.padEnd(26)}` +
      ` CPU ${String(m.cpu.totalMsPerS ?? "n/a").padStart(8)} ms/s` +
      `  Paint ${String(m.paint.perSecond ?? "n/a").padStart(7)}/s` +
      `  #document ${String(doc?.perSecond ?? 0).padStart(6)}/s` +
      `  gap max ${String(m.callbackGaps?.maxMs ?? "n/a").padStart(7)} ms` +
      (valid ? "" : `  INVALID: ${bad[0]}`),
  );
  save();
  return row;
}

const seen = { responses: [], failed: [], console: [] };

try {
  log(`\n  runner   : ${RUNNER}`);
  log(`  after    : ${AFTER}`);
  log(`             sha256 ${afterId.artifactSha256.slice(0, 16)}…  ${afterId.files} files`);
  if (beforeId) {
    log(`  before   : ${BEFORE}`);
    log(`             sha256 ${beforeId.artifactSha256.slice(0, 16)}…  ${beforeId.files} files`);
  } else {
    log(`  before   : (none given - pass --before <dir> to compare against the previous build)`);
  }
  log(
    `  browser  : ${CHROME || `channel:${CHANNEL}`}  headless=${flag("headless")}  ${VW}x${VH} @ DPR ${DPR}`,
  );
  log(
    `  renderer : rasterization=${backend.rasterization ?? "?"}  gpu_compositing=${backend.gpuCompositing ?? "?"}`,
  );
  if (backend.hardwareRendering === false)
    log("             SOFTWARE RENDERING - this machine's rasteriser, not a GPU's.");
  else if (backend.hardwareRendering === null) log("             RENDERING BACKEND UNKNOWN.");
  log("");

  const builds = [{ name: "after", dir: AFTER, port: PORT }];
  if (beforeId) builds.push({ name: "before", dir: BEFORE, port: PORT + 1 });

  for (const build of builds) {
    const base = await serve(build.dir, build.port);
    for (const theme of THEMES) {
      const { context, page, probe } = await open(base, theme, seen);

      // Stillness, on the after build only.
      if (build.name === "after") {
        results.stillness[theme] = {
          probe,
          // THE STRUCTURAL ASSERTIONS. No threshold, no judgement call - either the page
          // contains these things or it does not.
          checks: {
            sceneMounted: probe.present && probe.state === "ready",
            noSceneAnimations: probe.sceneAnimations.length === 0,
            noLiveDotAnimation: !probe.liveDot.present || probe.liveDot.animations === 0,
            liveDotStillShown: !probe.liveDot.present || probe.liveDot.labelled === true,
            noStageMachinery:
              probe.legacy.dataLive === null &&
              probe.legacy.dataMotion === null &&
              probe.legacy.zoneStrips === 0 &&
              probe.legacy.animClass === 0 &&
              probe.legacy.dataZ === 0,
            noRemovedSubjectImages: probe.removedSubjects.images.every((n) =>
              /^(sky-sphere|moon|sun)\.webp$/.test(n),
            ),
            noRemovedSubjectLabels: !probe.removedSubjects.labels.some((l) =>
              /SCATTEROMETER|IMAGER|SONDE|TRANSIT|VESSEL|BUOY/i.test(l),
            ),
            keptTheLandscape:
              probe.kept.canvases > 0 && probe.kept.svgs > 0 && probe.kept.layers > 0,
            keptTheCaption: /ILLUSTRATIVE, NOT AN ANALYSIS/.test(probe.kept.caption ?? ""),
            skyMatchesTheme: probe.sky === (theme === "dark" ? "night" : "day"),
          },
        };
      }

      // 1. Stationary windows.
      const coastY = Math.max(
        0,
        Math.round(
          (await page.evaluate(() => {
            const z = document.querySelector('[data-zone="surface"]');
            if (z) return z.getBoundingClientRect().top + window.scrollY;
            const g = window.__portalCosmos?.geom;
            return g ? g.groundY : document.documentElement.scrollHeight * 0.75;
          })) -
            VH * 0.45,
        ),
      );
      for (let r = 0; r < REPEATS; r++) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(1200);
        await measured(page, `sky (${r + 1}/${REPEATS})`, build.name, theme, "sky", WINDOW_S);
        await page.evaluate((y) => window.scrollTo(0, y), coastY);
        await page.waitForTimeout(1200);
        await measured(page, `coast (${r + 1}/${REPEATS})`, build.name, theme, "coast", WINDOW_S);
      }

      // 2. A full traversal, down and back.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1000);
      await measured(
        page,
        "traversal (down and back)",
        build.name,
        theme,
        "traversal",
        0,
        async () => {
          // COVERAGE IS DERIVED FROM THE PAGE: the step is a third of a viewport and the loop
          // runs until the bottom is actually reached, so a page that grew is still fully walked
          // and one that shrank is not walked past its end.
          return page.evaluate(async (vh) => {
            const doc = document.documentElement;
            const bottomOf = () => doc.scrollHeight - window.innerHeight;
            const step = Math.max(120, Math.round(vh / 3));
            let reachedBottom = false;
            for (let y = 0; y <= bottomOf() + step; y += step) {
              window.scrollTo(0, Math.min(y, bottomOf()));
              await new Promise((r) => setTimeout(r, 60));
              if (Math.abs(window.scrollY - bottomOf()) <= 2) {
                reachedBottom = true;
                break;
              }
            }
            await new Promise((r) => setTimeout(r, 400));
            const atBottom = Math.round(window.scrollY);
            for (let y = bottomOf(); y >= -step; y -= step) {
              window.scrollTo(0, Math.max(0, y));
              await new Promise((r) => setTimeout(r, 60));
              if (window.scrollY === 0) break;
            }
            await new Promise((r) => setTimeout(r, 400));
            return {
              pageHeight: doc.scrollHeight,
              maxScroll: bottomOf(),
              reachedBottom,
              bottomScrollY: atBottom,
              returnedToTop: Math.round(window.scrollY) === 0,
              step,
            };
          }, VH);
        },
      );

      // 3. Repeated theme switches.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1000);
      await measured(
        page,
        `theme switches x${SWITCHES}`,
        build.name,
        theme,
        "theme-switch",
        0,
        async () => {
          const readiness = [];
          for (let i = 0; i < SWITCHES; i++) {
            const to = i % 2 === 0 ? (theme === "dark" ? "light" : "dark") : theme;
            readiness.push(await page.evaluate((t) => window.__switchTheme(t), to));
            await page.waitForTimeout(700);
          }
          // Leave the page on the theme it started in, so the next window is comparable.
          await page.evaluate((t) => window.__switchTheme(t), theme);
          await page.waitForTimeout(500);
          return {
            readiness,
            medianReadyMs: (() => {
              const v = readiness.map((r) => r.readyMs).sort((a, b) => a - b);
              const m = v.length >> 1;
              return v.length ? +(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2).toFixed(2) : null;
            })(),
            maxReadyMs: readiness.length ? Math.max(...readiness.map((r) => r.readyMs)) : null,
            allSettled: readiness.every((r) => r.settled),
            note: "readiness, not presented-frame timing",
          };
        },
      );

      // 4. Idle paint, after settling.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(2500);
      const idle = await measured(
        page,
        "idle (settled)",
        build.name,
        theme,
        "sky",
        Math.max(8, Math.round(WINDOW_S / 2)),
      );
      if (build.name === "after" && idle.valid) {
        const cosmosPaint = idle.measured.paint.byTarget.filter((p) =>
          /portal-cosmos|CANVAS|#document/i.test(p.nodeName),
        );
        results.stillness[theme] = results.stillness[theme] ?? {};
        results.stillness[theme].idlePaint = {
          totalPerSecond: idle.measured.paint.perSecond,
          byTarget: idle.measured.paint.byTarget,
          cosmosAttributable: cosmosPaint,
          note: "measured after the page settled, with nothing touching it",
        };
      }

      await context.close();
      log("");
    }
  }
} catch (error) {
  results.abortedAfterWindow = index;
  results.abortedBecause = String(error?.stack || error?.message || error);
  log(`\n  RUN ABORTED after window ${index}: ${error?.message || error}`);
  log("  Everything measured before that point is kept and summarised below.\n");
  save();
}

// Summary.

results.externalHttpResponses = [
  ...new Map(seen.responses.map((r) => [`${r.url} ${r.status}`, r])).values(),
];
results.externalRequestsThatFailed = [
  ...new Map(seen.failed.map((r) => [`${r.url} ${r.failure}`, r])).values(),
];
results.consoleErrors = [...new Set(seen.console)];

for (const row of results.windows) {
  if (!row.valid) continue;
  const key = `${row.position} @ ${row.theme}`;
  const bucket = (results.summary[key] ??= {});
  const side = (bucket[row.build] ??= {
    samples: 0,
    cpu: [],
    paint: [],
    gapMax: [],
    gapMedian: [],
    themeReadyMs: [],
  });
  side.samples++;
  side.cpu.push(row.measured.cpu.totalMsPerS);
  side.paint.push(row.measured.paint.perSecond);
  if (row.measured.callbackGaps) {
    side.gapMax.push(row.measured.callbackGaps.maxMs);
    side.gapMedian.push(row.measured.callbackGaps.medianMs);
  }
  if (row.measured.payload?.medianReadyMs != null)
    side.themeReadyMs.push(row.measured.payload.medianReadyMs);
}
for (const [, bucket] of Object.entries(results.summary)) {
  for (const [, side] of Object.entries(bucket)) {
    side.cpuMedian = median(side.cpu);
    side.paintMedian = median(side.paint);
    side.gapMaxMedian = median(side.gapMax);
    side.gapMedianMedian = median(side.gapMedian);
    side.themeReadyMedian = median(side.themeReadyMs);
  }
  if (
    bucket.before &&
    bucket.after &&
    bucket.before.cpuMedian != null &&
    bucket.after.cpuMedian != null
  ) {
    bucket.delta = {
      cpuMsPerS: +(bucket.after.cpuMedian - bucket.before.cpuMedian).toFixed(2),
      paintPerSecond: +((bucket.after.paintMedian ?? 0) - (bucket.before.paintMedian ?? 0)).toFixed(
        2,
      ),
      note: "after minus before; negative is a reduction",
    };
  }
}
save();

const lines = ["", `  ACCEPTANCE — ${RUNNER}`, ""];
const failures = [];
for (const [theme, s] of Object.entries(results.stillness)) {
  if (!s.checks) continue;
  lines.push(`  STILLNESS (${theme})`);
  for (const [name, ok] of Object.entries(s.checks)) {
    lines.push(`    ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failures.push(`${name} (${theme})`);
  }
  if (s.idlePaint) {
    const idle = s.idlePaint.totalPerSecond ?? 0;
    const ok = idle < 1;
    lines.push(
      `    ${ok ? "PASS" : "FAIL"}  noRecurringIdlePaint  (${idle}/s over the settled window)`,
    );
    if (!ok) failures.push(`noRecurringIdlePaint (${theme}) - ${idle}/s`);
  }
  lines.push("");
}
lines.push("  MEASURED (valid windows only; CPU is browser ms per wall second)");
lines.push("");
for (const [key, bucket] of Object.entries(results.summary)) {
  const fmt = (side) =>
    side
      ? `CPU ${String(side.cpuMedian ?? "n/a").padStart(8)}  Paint ${String(side.paintMedian ?? "n/a").padStart(7)}/s  gap-max ${String(side.gapMaxMedian ?? "n/a").padStart(7)}ms  n=${side.samples}`
      : "—";
  lines.push(`    ${key}`);
  if (bucket.before) lines.push(`      before  ${fmt(bucket.before)}`);
  if (bucket.after) lines.push(`      after   ${fmt(bucket.after)}`);
  if (bucket.delta)
    lines.push(
      `      delta   CPU ${bucket.delta.cpuMsPerS > 0 ? "+" : ""}${bucket.delta.cpuMsPerS} ms/s   Paint ${bucket.delta.paintPerSecond > 0 ? "+" : ""}${bucket.delta.paintPerSecond}/s`,
    );
  if (bucket.after?.themeReadyMedian != null)
    lines.push(`      theme readiness (after): median ${bucket.after.themeReadyMedian} ms`);
}
lines.push("");
const traversals = results.windows.filter((w) => w.position === "traversal" && w.valid);
if (traversals.length) {
  lines.push("  TRAVERSAL");
  for (const t of traversals) {
    const p = t.measured.payload ?? {};
    lines.push(
      `    ${t.build.padEnd(6)} ${t.theme.padEnd(5)} height ${p.pageHeight}  step ${p.step}  reached bottom: ${p.reachedBottom}  returned to top: ${p.returnedToTop}`,
    );
    if (!p.reachedBottom || !p.returnedToTop)
      failures.push(`traversal did not cover the page (${t.build}/${t.theme})`);
  }
  lines.push("");
}
if (results.excludedWindows.length) {
  lines.push(`  ${results.excludedWindows.length} window(s) EXCLUDED:`);
  for (const w of results.excludedWindows)
    lines.push(`    #${w.index} ${w.build}/${w.theme} ${w.label}: ${[].concat(w.why)[0]}`);
  lines.push("");
}
if (results.externalRequestsThatFailed.length) {
  lines.push(
    `  ${results.externalRequestsThatFailed.length} external request(s) failed on this machine; see results.json.`,
  );
  lines.push("");
}
if (backend.hardwareRendering === false) {
  lines.push("  SOFTWARE RENDERING: the CPU figures are this machine's rasteriser, not a GPU's.");
  lines.push("  The STILLNESS results above do not depend on the backend; the timings do.");
  lines.push("");
}
lines.push(`  artifact (after)  sha256:${afterId.artifactSha256}`);
if (beforeId) lines.push(`  artifact (before) sha256:${beforeId.artifactSha256}`);
lines.push("");
lines.push(
  failures.length
    ? `  RESULT: ${failures.length} structural check(s) FAILED:`
    : "  RESULT: every structural check passed.",
);
for (const f of failures) lines.push(`    - ${f}`);
lines.push("");
lines.push(`  results: ${join(OUT, "results.json")}`);
lines.push(`  traces : ${join(OUT, "traces")}`);
lines.push("");
log(lines.join("\n"));
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "summary.txt"), lines.join("\n"));
results.failures = failures;
save();

await shutdown();
process.exit(failures.length || results.abortedBecause ? 1 : 0);
