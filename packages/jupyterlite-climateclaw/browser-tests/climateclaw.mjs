// ClimateClaw and the data panel in the trimmed JupyterLite Lab interface, against the mock
// Freva host: popup login (success, blocked popup, severed opener, a foreign message ignored,
// logout) without the page ever navigating, chat (code, outputs, images, scope note, threads,
// examples, slash commands, Hide code, stop, history), code typed into its cell, the status line
// and the jump back, ClimateClaw's name and face, Run & fix, the data panel's actions (GridLook's
// globe, against a stub), the trimmed launcher, the Content-Security-Policy and the origins.
//
//   node browser-tests/climateclaw.mjs      # BROWSER_ENGINE=firefox|webkit for the others
import {
  ENGINE,
  EXIT_NOT_RUN,
  STRICT,
  cells,
  instrumentedPage,
  kernelIdle,
  launch,
  report,
  serveSite,
  setCell,
  violations,
} from "../../jupyterlite-freva-kernel/browser-tests/lite-harness.mjs";
import {
  EXAMPLES,
  GRIDLOOK,
  MOCK,
  SCOPE_NOTE,
  SITE_TITLE,
  STORE_URL,
  labSite,
  replacements,
} from "./lab-site.mjs";
import { AUTH } from "./mock-freva.mjs";

/**
 * jupyterlite-ai's persona bundle carries zod, whose `allowsEval` feature probe runs
 * `Function("")` inside try/catch once at start-up. The policy refuses it (and zod falls back to
 * its interpreter); the browser still reports the refusal. It is the only violation tolerated,
 * and only from that file: see the README.
 */
const KNOWN_PROBE = (v) =>
  v.directive.startsWith("script-src") &&
  v.blocked === "eval" &&
  // A chunk of that one bundle, `<id>.<hash>.js`, with the `?v=<the same hash>` JupyterLab adds.
  /\/extensions\/@jupyternaut\/persona\/static\/\d+\.([0-9a-f]+)\.js(\?v=\1)?$/.test(v.source);

const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: Boolean(pass), detail: pass ? "" : String(detail).slice(0, 600) });
};
const started = Date.now();
const step = async (name, fn) => {
  const from = checks.length;
  const at = Date.now();
  try {
    await fn();
  } catch (error) {
    check(name, false, error?.stack ?? error);
    if (process.env.DEBUG_SHOTS) {
      await page
        .screenshot({ path: `${process.env.DEBUG_SHOTS}/${name.replace(/\W+/g, "-")}.png` })
        .catch(() => undefined);
    }
    if (process.env.DEBUG_DOM) {
      const dom = await page
        .evaluate(() => document.getElementById("climateclaw-chat-panel")?.outerHTML ?? "")
        .catch(() => "");
      console.log(`--- ${name}\n${dom.replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>").slice(0, 6000)}`);
    }
  } finally {
    // Progress per step on stderr; the full report follows at the end.
    const mine = checks.slice(from);
    const passed = mine.filter((c) => c.pass).length;
    const secs = (ms) => `${Math.round(ms / 1000)}s`;
    process.stderr.write(
      `[${secs(Date.now() - started).padStart(5)}] ${passed === mine.length ? "ok  " : "FAIL"} ${name} (${passed}/${mine.length}, ${secs(Date.now() - at)})\n`,
    );
  }
};

let built;
try {
  built = await labSite();
} catch (error) {
  console.error(`The Lab site could not be prepared: ${error.message}`);
  process.exit(STRICT ? 1 : EXIT_NOT_RUN);
}
const { site, mock } = built;
const served = await serveSite(site, {
  replacements,
  connectSources: [MOCK],
  frameSources: [GRIDLOOK],
});
const NB = served.notebook.url;
const CALLBACK = `${NB}/freva-login-callback.html`;
mock.allowRedirect(CALLBACK);

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
// GridLook is a stub here: what it is given (its URL) is checked, not its rendering.
const gridlookRequests = [];
await context.route(`${GRIDLOOK}/**`, async (route) => {
  gridlookRequests.push({ url: route.request().url(), headers: route.request().headers() });
  await route.fulfill({
    status: 200,
    contentType: "text/html",
    body: '<!doctype html><title>GridLook stub</title><p id="stub">GridLook stub</p>',
  });
});
const instrumented = await instrumentedPage(context);
const { record } = instrumented;
/** The tab the helpers drive: the main one, except in the step that opens a second. */
let page = instrumented.page;
await page.addInitScript(() => {
  window.__copied = [];
  window.addEventListener("copy", (event) => {
    // Read during dispatch (after the copier's own listener on <body> has set the data).
    window.__copied.push(event.clipboardData?.getData("text") ?? "");
  });
  window.__cspDetail = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__cspDetail.push({
      directive: e.violatedDirective,
      blocked: e.blockedURI,
      source: e.sourceFile,
    });
  });
});
const mainNavigations = [];
page.on("framenavigated", (frame) => {
  if (frame === page.mainFrame()) mainNavigations.push(frame.url());
});

// helpers

const api = (endpoint) =>
  mock.log.filter((r) => r.path === `/api/chatbot/${endpoint}` && r.method !== "OPTIONS");
const leftTab = (title) =>
  page.locator(`.jp-SideBar.jp-mod-left .lm-TabBar-tab[title^="${title}"]`);
/** Show a left panel (clicking its tab when it is already shown would collapse it). */
async function showLeft(title) {
  const tab = leftTab(title);
  if ((await tab.getAttribute("class"))?.includes("lm-mod-current")) {
    const shown = await page.evaluate(() => {
      const stack = document.getElementById("jp-left-stack");
      return !!stack && !stack.classList.contains("lm-mod-hidden") && stack.offsetWidth > 0;
    });
    if (shown) return;
  }
  await tab.click();
}
/** ClimateClaw's own chat panel (jupyterlite-ai's chat panel plugin is disabled on the site). */
const PANEL = "#climateclaw-chat-panel";
const chatPanel = () => page.locator(PANEL);
/** The chat the panel shows now (its other chats stay in the DOM, hidden). */
const SHOWN_CHAT = `${PANEL} .jp-ClimateClaw-sideChat:not(.lm-mod-hidden)`;
/** Shows the panel, and a chat in it (the first page's New chat, when it shows that page). */
async function openChatPanel() {
  const open = await page.evaluate((id) => {
    const panel = document.querySelector(id);
    return !!panel && !panel.classList.contains("lm-mod-hidden") && panel.offsetWidth > 0;
  }, PANEL);
  if (!open) await showLeft("ClimateClaw");
  const view = await chatPanel().getAttribute("data-view");
  if (view === "history")
    await chatPanel().locator(".jp-ClimateClaw-headerButton.jp-mod-back").click();
  if ((await chatPanel().getAttribute("data-view")) === "welcome") {
    await chatPanel().locator(".jp-ClimateClaw-welcomeNew").click();
  }
  await page.locator(`${SHOWN_CHAT} .jp-chat-input-container`).first().waitFor({ timeout: 30_000 });
}
/** The panel's account button: "Sign in", or the signed-in user's initials. */
const accountButton = () => chatPanel().locator(".jp-ClimateClaw-account");
const signedIn = () =>
  page.waitForFunction(
    () => !!document.querySelector(".jp-ClimateClaw-account.jp-mod-signedIn"),
    null,
    { timeout: 30_000 },
  );
async function chatInput() {
  return page.locator(`${SHOWN_CHAT} textarea:not([aria-hidden='true'])`).last();
}
async function sendChat(text) {
  // One question at a time: a question sent while a reply streams is queued by jupyterlite-ai,
  // which is not what these steps are about. Stop shows exactly while a reply streams.
  await page.waitForFunction(
    (shown) => !document.querySelector(`${shown} .jp-ClimateClaw-stop`),
    SHOWN_CHAT,
    { timeout: 60_000 },
  );
  // Away from the composer's buttons first: a hovered button's tooltip sits over the input (and
  // may stay a moment, so the input is focused rather than clicked).
  await page.mouse.move(1, 1);
  const input = await chatInput();
  await input.focus();
  await input.fill(text);
  await input.press("Enter");
}
/** The shown chat's messages, each once. */
const botMessages = () =>
  page.evaluate(
    (shown) =>
      [...document.querySelectorAll(`${shown} .jp-chat-message`)].map((m) => ({
        text: m.textContent ?? "",
        html: m.innerHTML,
      })),
    SHOWN_CHAT,
  );
/** What the last reply matching `match` shows of its runs: one card per run of code at DKRZ. */
const runCards = (match) =>
  page.evaluate(
    ({ shown, source }) => {
      const reply = [...document.querySelectorAll(`${shown} .jp-chat-rendered-message`)]
        .filter((m) => new RegExp(source).test(m.textContent ?? ""))
        .at(-1);
      return [...(reply?.querySelectorAll(".jp-ClimateClaw-run") ?? [])].map((card) => {
        const ran = card.querySelector(".jp-ClimateClaw-ran");
        const style = ran && getComputedStyle(ran);
        const code = card.querySelector("details.jp-ClimateClaw-runCode");
        const parts = Object.fromEntries(
          [...card.querySelectorAll("details.jp-ClimateClaw-runPart")].map((p) => [
            p.querySelector("summary")?.textContent ?? "",
            { open: p.open, text: p.textContent ?? "", html: p.innerHTML },
          ]),
        );
        return {
          // Rendered, not as text: a chip laid out by its own style.
          at: ran?.querySelector(".jp-ClimateClaw-ran-at")?.textContent ?? "",
          cell: ran?.querySelector(".jp-ClimateClaw-ran-cell")?.textContent ?? "",
          title: ran?.getAttribute("title") ?? "",
          pill: style ? `${style.display} ${style.borderTopLeftRadius}` : "",
          outcomes: [...card.querySelectorAll(".jp-ClimateClaw-outcome")].map(
            (o) => `${o.className.replace("jp-ClimateClaw-outcome", "").trim()}:${o.textContent}`,
          ),
          code: code
            ? { open: code.open, text: code.querySelector("pre")?.textContent ?? "" }
            : null,
          parts,
        };
      });
    },
    { shown: SHOWN_CHAT, source: match.source },
  );
async function waitForChat(predicate, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const messages = await botMessages();
    if (predicate(messages)) return messages;
    if (Date.now() > deadline)
      throw new Error(
        `chat: timed out; last: ${JSON.stringify(messages.map((m) => m.text.slice(-200)))}`,
      );
    await page.waitForTimeout(250);
  }
}
/** Brings a notebook tab whose label matches `name` to the front. */
async function showNotebook(name) {
  const tab = page.locator(".lm-DockPanel-tabBar .lm-TabBar-tab", { hasText: name }).first();
  await tab.click();
  await page.waitForFunction(
    (el) => el.classList.contains("lm-mod-current"),
    await tab.elementHandle(),
    {
      timeout: 10_000,
    },
  );
}
/** The visible notebook's cells (others stay in the DOM, hidden). */
const NOTEBOOK = ".lm-DockPanel .jp-NotebookPanel:not(.lm-mod-hidden) .jp-Notebook";
const nbCells = () =>
  page.evaluate(
    (root) =>
      [...(document.querySelector(root)?.querySelectorAll(".jp-Cell") ?? [])].map((cell) => ({
        kind: cell.classList.contains("jp-CodeCell") ? "code" : "markdown",
        source: cell.querySelector(".cm-content")?.textContent ?? "",
        text: cell.querySelector(".jp-OutputArea")?.textContent ?? cell.textContent ?? "",
        html: cell.querySelector(".jp-OutputArea")?.innerHTML ?? "",
      })),
    NOTEBOOK,
  );
const nbCell = (index) => page.locator(`${NOTEBOOK} .jp-Cell`).nth(index);
/** The visible notebook's cell that `which` names, once `ready` holds for it (or null). */
async function waitForCell(which, ready = () => true, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const all = await nbCells();
    const cell = all.find((c) => which(c, all));
    if (cell && ready(cell)) return cell;
    if (Date.now() > deadline) return null;
    await page.waitForTimeout(250);
  }
}
/** The account button's text (initials, or "Sign in") and its tooltip. */
const accountLabel = async () => {
  const button = accountButton();
  return `${await button.textContent()} | ${(await button.getAttribute("title")) ?? ""}`;
};
/** Drag the left side panel's edge to `width` pixels (what a user does to make room). */
async function widenLeftPanel(width) {
  const box = await page.evaluate(() => {
    const stack = document.getElementById("jp-left-stack").getBoundingClientRect();
    const handle = [...document.querySelectorAll(".lm-SplitPanel-handle")]
      .map((h) => h.getBoundingClientRect())
      .find((r) => Math.abs(r.left - stack.right) < 8 && r.height > 200);
    return handle
      ? { x: handle.left + handle.width / 2, y: handle.top + 200, left: stack.left }
      : null;
  });
  if (!box) throw new Error("no side panel handle");
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.left + width, box.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
}
/** A composer control of the visible chat (an item of its input toolbar). */
const composerButton = (className) =>
  page.locator(`.${className}:visible button, button.${className}:visible`).last();

// the interface

await page.goto(`${NB}/lab/index.html`);
await page.waitForSelector(".jp-LauncherCard", { timeout: 120_000 });
await page.waitForTimeout(1500);

await step("launcher", async () => {
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll(".jp-LauncherCard")].map(
      (c) =>
        `${c.closest(".jp-Launcher-section")?.querySelector(".jp-Launcher-sectionTitle")?.textContent}: ${c.querySelector(".jp-LauncherCard-label")?.textContent}`,
    ),
  );
  // Notebook and Console on the one kernel (the console stays on purpose: see portal-builder's
  // LAB_DISABLED_EXTENSIONS), then the site's own cards.
  const want = [
    "Notebook: Freva Python",
    "Console: Freva Python",
    `${SITE_TITLE}: New ${SITE_TITLE} notebook`,
    `${SITE_TITLE}: Browse data`,
    `${SITE_TITLE}: Example notebooks`,
    `${SITE_TITLE}: Ask ClimateClaw`,
  ];
  check(
    "the trimmed launcher shows one kernel (notebook and console) and only the site's cards",
    JSON.stringify(cards) === JSON.stringify(want),
    JSON.stringify(cards),
  );
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll(".jp-SideBar.jp-mod-left .lm-TabBar-tab")].map(
      (t) => (t.getAttribute("title") ?? "").split(" (")[0],
    ),
  );
  // ClimateClaw's own panel first (jupyterlite-ai's chat panel is disabled on the site).
  check(
    "left side: ClimateClaw, the data panel, files, running, contents",
    JSON.stringify(tabs) ===
      JSON.stringify([
        "ClimateClaw",
        `${SITE_TITLE} data`,
        "File Browser",
        "Running Terminals and Kernels",
        "Table of Contents",
      ]),
    JSON.stringify(tabs),
  );
  // Firefox also logs the tolerated probe as a console error: excused once per probe the page
  // reported (KNOWN_PROBE), and never when the line names another file.
  let probes = (await page.evaluate(() => window.__cspDetail)).filter(KNOWN_PROBE).length;
  const consoleErrors = record.console.filter((l) => {
    if (!/^error/.test(l) || /Failed to load resource/.test(l)) return false;
    const probe =
      /blocked a JavaScript eval \(script-src\)/.test(l) &&
      !/\{file: "(?![^"]*\/extensions\/@jupyternaut\/persona\/static\/)[^"]*"/.test(l);
    if (probe && probes > 0) {
      probes -= 1;
      return false;
    }
    return true;
  });
  check(
    "no plugin fails to activate",
    consoleErrors.length === 0 && record.errors.length === 0,
    [...consoleErrors, ...record.errors].join("\n"),
  );
});

// A draft cell and live kernel state that every sign-in flow below must leave alone.
let draftPanel;
await step("a notebook with a draft and kernel state", async () => {
  await page.locator(".jp-LauncherCard", { hasText: "Freva Python" }).first().click();
  await page.waitForSelector(".jp-NotebookPanel .jp-Cell", { timeout: 60_000 });
  await kernelIdle(page, 180_000);
  await setCell(page, 0, "x = 41");
  await page.keyboard.press("Shift+Enter");
  // Its count, not the idle indicator alone: right after Shift+Enter the request may not have
  // reached the kernel yet, and the indicator still says idle (seen in Firefox on CI).
  await page.waitForFunction(
    () =>
      /\[\d+\]/.test(
        document.querySelector(".jp-NotebookPanel:not(.lm-mod-hidden) .jp-InputPrompt")
          ?.textContent ?? "",
      ),
    null,
    { timeout: 180_000, polling: 250 },
  );
  await kernelIdle(page, 180_000);
  await setCell(page, 1, "draft: do not lose me");
  await page.keyboard.press("Escape");
  await page.keyboard.press("b");
  draftPanel = await page.evaluate(() => document.querySelector(".jp-NotebookPanel")?.id);
  check(
    "kernel ran a cell",
    (await cells(page))[0]?.prompt.includes("1"),
    JSON.stringify(await cells(page)),
  );
});

// GridLook

await step("data panel: View on globe shows a public store on GridLook", async () => {
  await showLeft(`${SITE_TITLE} data`);
  const panel = page.locator(".jp-FrevaData");
  await panel.locator("text=Test archive").first().waitFor({ timeout: 30_000 });
  const search = panel.locator("input[type='search'], .dataset-tree input").first();
  await search.fill("sfcwind");
  const row = panel.locator('[data-dt-row="s3://data/sfcwind.zarr/"]').first();
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await panel.locator('[data-command="freva-data:view-on-globe"]').click();
  // Signed out: the store is read without a token, so GridLook may show it.
  const frame = page.locator(".jp-FrevaData-inspector iframe#nc-gridlook-iframe");
  await frame.waitFor({ state: "visible", timeout: 30_000 });
  const src = await frame.evaluate((f) => f.src);
  check(
    "View on globe opens the store on GridLook's globe, the store URL in the fragment",
    src === `${GRIDLOOK}/#${STORE_URL}`,
    src,
  );
  check(
    "…in a sandboxed frame without a referrer",
    (await frame.getAttribute("sandbox"))?.includes("allow-scripts") &&
      (await frame.getAttribute("referrerpolicy")) === "no-referrer",
  );
  const deadline = Date.now() + 15_000;
  let loaded = "";
  while (!loaded && Date.now() < deadline) {
    const gl = page.frames().find((f) => f.url().startsWith(`${GRIDLOOK}/`));
    loaded =
      (await gl
        ?.locator("#stub")
        .textContent()
        .catch(() => "")) ?? "";
    if (!loaded) await page.waitForTimeout(250);
  }
  check("…which the notebook's policy lets load", loaded === "GridLook stub", loaded);
  check(
    "GridLook gets neither a token nor the notebook's address",
    gridlookRequests.length > 0 &&
      gridlookRequests.every(
        (r) => !("authorization" in r.headers) && !String(r.headers.referer ?? "").startsWith(NB),
      ),
    JSON.stringify(gridlookRequests),
  );
  // View on globe opens the inspector on its 3D viewer, in a tab of its own.
  await page
    .locator(".lm-DockPanel-tabBar .lm-TabBar-tab", { hasText: "Globe: sfcwind.zarr" })
    .locator(".lm-TabBar-tabCloseIcon")
    .click();
  await search.fill("");
});

// signed out

await step("signed out", async () => {
  await openChatPanel();
  check(
    "the account button offers the Freva sign-in",
    /Sign in with Freva/.test(await accountLabel()),
    await accountLabel(),
  );
  await sendChat("hello before signing in");
  const messages = await waitForChat((m) =>
    m.some((x) => /Sign in with Freva/.test(x.text) && /ClimateClaw/.test(x.text)),
  );
  check("sending while signed out says how to sign in", messages.length > 0);
  check(
    "nothing reached ClimateClaw while signed out",
    api("streamresponse").length === 0 && api("newthread").length === 0,
  );
});

// popup blocked

await step("popup blocked", async () => {
  await page.evaluate(() => {
    window.__open = window.open;
    window.open = () => null;
  });
  await accountButton().click();
  const dialog = page.locator(".jp-Dialog", {
    hasText: "Allow pop-ups or open the login in a new tab",
  });
  await dialog.waitFor({ timeout: 10_000 });
  const link = dialog.locator("a.jp-ClimateClaw-blocked-link");
  check("a blocked popup offers the login in a new tab", (await link.count()) === 1);
  // The link opens the sign-in window from its own click, which a popup blocker allows.
  await page.evaluate(() => {
    window.open = window.__open;
  });
  const [tab] = await Promise.all([context.waitForEvent("page"), link.click()]);
  await signedIn();
  check(
    "the login in a new tab signs this page in",
    /^JD \| Signed in as Jane Doe$/.test(await accountLabel()),
    await accountLabel(),
  );
  await tab.close().catch(() => undefined);
  await page
    .locator(".jp-Dialog button", { hasText: "Close" })
    .click()
    .catch(() => undefined);
  await page.evaluate(() => {
    window.open = window.__open;
  });
});

await step("logout", async () => {
  const revokes = mock.log.filter((r) => r.path === `${AUTH}/revoke`).length;
  await accountButton().click();
  // The account card names the user and offers sign-out (which also ends the provider's
  // session, in a popup of its own).
  const card = page.locator(".jp-ClimateClaw-accountPopover");
  await card.waitFor({ timeout: 10_000 });
  check(
    "the account card names the user and offers sign-out",
    /jdoe/.test(await card.textContent()) &&
      (await card.locator(".jp-ClimateClaw-signOut").count()) === 1,
    await card.textContent(),
  );
  const [end] = await Promise.all([
    context.waitForEvent("page"),
    card.locator(".jp-ClimateClaw-signOut").click(),
  ]);
  await page.waitForFunction(
    () => !document.querySelector(".jp-ClimateClaw-account.jp-mod-signedIn"),
    null,
    { timeout: 15_000 },
  );
  check(
    "sign-out revokes the credential and signs the page out",
    mock.log.filter((r) => r.path === `${AUTH}/revoke`).length > revokes,
  );
  await end.waitForEvent("close", { timeout: 10_000 }).catch(() => undefined);
  check("the end-session window closes by itself", end.isClosed());
});

// popup login

await step("popup login with a severed opener", async () => {
  const before = mock.log.filter((r) => r.path === `${AUTH}/callback`).length;
  const [popup] = await Promise.all([context.waitForEvent("page"), accountButton().click()]);
  await signedIn();
  check(
    "the popup login completes over BroadcastChannel (the provider page severs the opener)",
    /Signed in as Jane Doe/.test(await accountLabel()),
  );
  check(
    "signed in, the account button is an avatar with the initials",
    (await accountLabel()).startsWith("JD |"),
    await accountLabel(),
  );
  check(
    "the code was exchanged once",
    mock.log.filter((r) => r.path === `${AUTH}/callback`).length === before + 1,
  );
  await popup.waitForEvent("close", { timeout: 10_000 }).catch(() => undefined);
  check("the popup closed", popup.isClosed());
});

await step("a foreign or wrong-origin message is ignored", async () => {
  const before = mock.log.filter((r) => r.path === `${AUTH}/callback`).length;
  await page.evaluate((cb) => {
    // The old protocol's channel, and the shared callback's under made-up attempts.
    const channel = new BroadcastChannel("freva-login-callback");
    channel.postMessage({
      type: "freva-login-callback",
      url: "https://evil.example/freva-login-callback.html?code=evil&state=s",
    });
    channel.postMessage({ type: "freva-login-callback", url: `${cb}?code=evil&state=s` });
    channel.close();
    for (const attempt of ["0".repeat(32), "f".repeat(32)]) {
      const relay = new BroadcastChannel(`freva-auth-callback.${attempt}`);
      relay.postMessage({
        type: "freva-auth-callback",
        v: 1,
        attempt,
        purpose: "login",
        outcome: "response",
        url: `${cb}?code=evil&state=s`,
      });
      relay.close();
    }
    window.postMessage({ type: "freva-auth-callback", url: `${cb}?code=evil&state=s` }, "*");
  }, CALLBACK);
  await page.waitForTimeout(1000);
  check(
    "no foreign callback message reaches the auth server",
    mock.log.filter((r) => r.path === `${AUTH}/callback`).length === before,
  );
  check("still signed in as before", /Signed in as Jane Doe/.test(await accountLabel()));
});

await step("the page never navigated and the draft and kernel survived", async () => {
  check("the main tab never navigated", mainNavigations.length === 1, mainNavigations.join(" | "));
  await page.evaluate(
    (id) => document.getElementById(id) && window.dispatchEvent(new Event("resize")),
    draftPanel,
  );
  await page.locator(`[id="${draftPanel}"]`).waitFor({ state: "attached" });
  await page
    .locator(".lm-DockPanel-tabBar .lm-TabBar-tab", { hasText: "Untitled" })
    .first()
    .click();
  const before = await cells(page);
  await setCell(page, 2, "x + 1");
  await page.keyboard.press("Shift+Enter");
  await kernelIdle(page, 60_000);
  const after = await cells(page);
  check(
    "the draft cell is unchanged",
    before.length >= 2 &&
      (await page.locator(".jp-Notebook .jp-Cell").nth(1).textContent()).includes(
        "draft: do not lose me",
      ),
  );
  check(
    "the kernel kept its state",
    after[2]?.text.includes("42"),
    JSON.stringify(after.map((c) => c.text)),
  );
});

// chat

let firstThread = "";
await step("chat: code, output, image, scope note", async () => {
  await openChatPanel();
  await sendChat(EXAMPLES[0].prompt);
  const messages = await waitForChat((m) => m.some((x) => /the mean is 2\.0/.test(x.text)));
  const reply = messages.find((x) => /the mean is 2\.0/.test(x.text));
  const posts = api("streamresponse");
  const newThreads = api("newthread");
  check("a new thread was requested", newThreads.length === 1);
  const body = mock.threads && [...mock.threads.entries()].at(-1);
  firstThread = body?.[0] ?? "";
  const input = body?.[1].variants.find((v) => v.variant === "User")?.content ?? "";
  check(
    "the scope note leads the thread's first message",
    input === `${SCOPE_NOTE}\n\n${EXAMPLES[0].prompt}`,
    input,
  );
  check(
    "the reply shows the scope note",
    reply.text.includes("Scope note") && reply.text.includes(SCOPE_NOTE),
  );
  check(
    "assistant text streams in",
    reply.text.includes("Here is") && reply.text.includes("the global mean."),
  );
  // codeToNotebook (the default): the code is a new cell in the chat's own notebook (named after
  // the chat, bound to its thread), with its output and figure; the reply says where it went.
  // The chat rendering is checked with it off, below.
  const ranCell = await waitForCell(
    (c) => c.source.includes("np.mean([1, 2, 3])"),
    (c) => c.html.includes("<img"),
  );
  check(
    "the code it ran is a new code cell in the chat's notebook",
    ranCell?.kind === "code" && ranCell.source.includes("import numpy as np"),
    JSON.stringify((await nbCells()).map((c) => [c.source.slice(0, 40), c.text.slice(0, 80)])),
  );
  check("…with its output", ranCell?.text.includes("2.0"), ranCell?.text);
  check(
    "…and its image, whole from its fragments (96 px wide, by the kernel's PNG renderer)",
    (await page.evaluate((root) => {
      const cell = [...(document.querySelector(root)?.querySelectorAll(".jp-Cell") ?? [])].find(
        (c) => c.querySelector(".cm-content")?.textContent?.includes("np.mean([1, 2, 3])"),
      );
      const img = cell?.querySelector(".jp-OutputArea img");
      return img
        ? img.decode().then(
            () => img.naturalWidth,
            () => -1,
          )
        : 0;
    }, NOTEBOOK)) === 96,
  );
  // The run, in the reply: one card whose line says where it ran and which cell (rendered,
  // sanitised and styled, not as text), how it ended and that it drew a figure; then its code -
  // folded: with codeToNotebook, Hide code starts on, the code being in its cell - its output and
  // its figure.
  const [card] = await runCards(/the mean is 2\.0/);
  check(
    "the reply shows the run as a card: where it ran and the cell its code went to",
    card?.at === "DKRZ" &&
      /^Cell \d+$/.test(card.cell) &&
      /^Ran at DKRZ by ClimateClaw \(gpt-test\).*Click to go there\.$/.test(card.title) &&
      /^(inline-)?flex /.test(card.pill),
    JSON.stringify(card),
  );
  check(
    "…then how it ended, and its figure",
    JSON.stringify(card?.outcomes) ===
      JSON.stringify(["jp-mod-ok:✓ ran · output", "jp-mod-figure:◩ figure"]),
    JSON.stringify(card?.outcomes),
  );
  check(
    "…its code (folded under the line), its output and its figure",
    card?.code?.open === false &&
      card.code.text.includes("np.mean([1, 2, 3])") &&
      card.parts.Output?.text.includes("2.0") &&
      /<img[^>]+src="data:image\/png;base64,iVBOR/.test(card.parts.Figures?.html ?? ""),
    JSON.stringify(card).slice(0, 600),
  );
  check("a busy hint is a status line", reply.text.includes("Executing previous code blocks"));
  check("a tool call is a short status line", reply.text.includes("Using web search"));
  check("the thread marker is not visible", !reply.text.includes("climateclaw:thread"));
  check(
    "every request carried the Freva bearer",
    posts.every((r) => /^Bearer /.test(r.authorization ?? "")),
  );
  check(
    "the browser never sent x-freva-rest-url",
    mock.log.every((r) => !("x-freva-rest-url" in r.headers)),
  );
});

await step("chat: the thread continues", async () => {
  const threadsBefore = api("newthread").length;
  await sendChat("And the maximum?");
  await waitForChat((m) => m.filter((x) => /the mean is 2\.0/.test(x.text)).length >= 2);
  const thread = mock.threads.get(firstThread);
  const users = thread.variants.filter((v) => v.variant === "User").map((v) => v.content);
  check(
    "the second message continues the same thread",
    api("newthread").length === threadsBefore && users.at(-1) === "And the maximum?",
    JSON.stringify(users),
  );
});

await step("chat: code types into its cell; ClimateClaw at work; the jump back", async () => {
  await openChatPanel();
  const count = (await botMessages()).length;
  await sendChat("TYPEOUT: write it out");
  // Sampled while the reply streams: the reply's status line, the cell's code, any old persona.
  const labels = new Set();
  const phases = new Set();
  const lengths = new Set();
  let sawJupyternaut = false;
  let fullLength = 0;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const sample = await page.evaluate(
      ({ root, shown }) => {
        const lines = [...document.querySelectorAll(`${shown} .jp-ClimateClaw-busy`)];
        const cell = [...(document.querySelector(root)?.querySelectorAll(".jp-Cell") ?? [])]
          .map((c) => c.querySelector(".cm-content")?.textContent ?? "")
          .find((t) => t.startsWith("# typed by ClimateClaw"));
        const chat = document.querySelector(shown);
        return {
          labels: lines.map(
            (b) =>
              `${(b.getAttribute("title") ?? "").split(" · ")[0]}${b.closest(".jp-chat-message") ? "" : " (not in the reply)"}`,
          ),
          phases: lines.map(
            (b) => `${b.dataset.phase}:${b.firstElementChild?.getAttribute("class") ?? ""}`,
          ),
          code: cell ?? "",
          jupyternaut: /Jupyternaut/.test(chat?.textContent ?? ""),
          done: /All typed\./.test(chat?.textContent ?? ""),
        };
      },
      { root: NOTEBOOK, shown: SHOWN_CHAT },
    );
    sample.labels.forEach((l) => labels.add(l));
    sample.phases.forEach((p) => phases.add(p));
    if (sample.code) lengths.add(sample.code.length);
    sawJupyternaut ||= sample.jupyternaut;
    if (sample.done && sample.labels.length === 0) {
      fullLength = sample.code.length;
      break;
    }
    if (Date.now() > deadline) throw new Error(`no end: ${JSON.stringify([...labels])}`);
    await page.waitForTimeout(60);
  }
  // In ClimateClaw's panel the line is under the reply being written, with a mark per phase.
  check(
    "while it works, a status line under the reply shows what it is doing, with a mark for each",
    labels.has("Thinking") &&
      labels.has("Writing code") &&
      labels.has("Running code at DKRZ") &&
      [...labels].every((l) => !l.endsWith("(not in the reply)")) &&
      phases.has("thinking:jp-ClimateClaw-busy-wave") &&
      phases.has("coding:jp-ClimateClaw-busy-code") &&
      phases.has("running:jp-ClimateClaw-busy-dkrz"),
    `${JSON.stringify([...labels])} ${JSON.stringify([...phases])}`,
  );
  const partial = [...lengths].filter((n) => n > 0 && n < fullLength);
  check(
    "the code types into its cell as it streams",
    partial.length >= 3 && fullLength > 400,
    `${fullLength} ${JSON.stringify([...lengths])}`,
  );
  await waitForChat((m) => m.length > count && /All typed/.test(m.at(-1).text));
  const [card] = await runCards(/All typed/);
  const number = Number(/^Cell (\d+)$/.exec(card?.cell ?? "")?.[1] ?? 0);
  check(
    "the reply's card names the cell the code went to",
    number > 0 && card.at === "DKRZ",
    JSON.stringify(card),
  );
  check(
    "when it is done, the status line is gone",
    (await page.locator(`${SHOWN_CHAT} .jp-ClimateClaw-busy`).count()) === 0,
  );
  // The card's chip is the jump back: it selects the cell the reply wrote.
  await nbCell(0).click();
  await page.mouse.move(1, 1);
  await page
    .locator(`${SHOWN_CHAT} .jp-chat-rendered-message`, { hasText: "All typed" })
    .last()
    .locator(".jp-ClimateClaw-ran")
    .click();
  await page.waitForTimeout(400);
  const active = await page.evaluate((root) => {
    const cells = [...(document.querySelector(root)?.querySelectorAll(".jp-Cell") ?? [])];
    const index = cells.findIndex((c) => c.classList.contains("jp-mod-active"));
    return { index, code: cells[index]?.querySelector(".cm-content")?.textContent ?? "" };
  }, NOTEBOOK);
  check(
    "the jump selects the cell the reply wrote",
    active.index === number - 1 && active.code.startsWith("# typed by ClimateClaw"),
    JSON.stringify(active),
  );
  const header = await page.evaluate((shown) => {
    const headers = [...document.querySelectorAll(`${shown} .jp-chat-message-header`)];
    const last = headers.at(-1);
    return {
      text: last?.textContent ?? "",
      avatar: last?.querySelector("img")?.getAttribute("alt") ?? "",
      src: last?.querySelector("img")?.getAttribute("src")?.slice(0, 22) ?? "",
    };
  }, SHOWN_CHAT);
  check(
    "replies are ClimateClaw's, with its logo; Jupyternaut is never shown",
    header.text.includes("ClimateClaw") &&
      header.avatar === "ClimateClaw" &&
      header.src === "data:image/webp;base64" &&
      !sawJupyternaut,
    `${JSON.stringify(header)} jupyternaut seen: ${sawJupyternaut}`,
  );
});

await step("chat: a run that failed at DKRZ says so", async () => {
  const count = (await botMessages()).length;
  await sendChat("BROKEN: divide");
  await waitForChat((m) => m.length > count && /divided by zero/.test(m.at(-1).text));
  const outcome = await page.evaluate((shown) => {
    const replies = [...document.querySelectorAll(`${shown} .jp-chat-rendered-message`)];
    const chip = replies.at(-1)?.querySelector(".jp-ClimateClaw-outcome");
    return { text: chip?.textContent ?? "", cls: chip?.className ?? "", title: chip?.title ?? "" };
  }, SHOWN_CHAT);
  check(
    "the error's name is a red chip, the message its tooltip",
    outcome.text === "✗ ZeroDivisionError" &&
      outcome.cls.includes("jp-mod-error") &&
      outcome.title === "ZeroDivisionError: division by zero",
    JSON.stringify(outcome),
  );
});

await step("the model beside Send, and the panel's header", async () => {
  // ClimateClaw's panel names the chat's model beside Send (a brain, then its name).
  const models = () => page.locator(`${SHOWN_CHAT} .jp-ClimateClaw-models button`).last();
  const model = await models().evaluate((b) => ({
    text: b.textContent,
    title: b.title,
    icon: !!b.querySelector(".jp-ClimateClaw-composerIcon svg"),
  }));
  check(
    "beside Send, the composer names this chat's model (in full in its tooltip)",
    model.text === "gpt-test" && /^Model: gpt-test\./.test(model.title) && model.icon,
    JSON.stringify(model),
  );
  const choose = async (name) => {
    await models().click();
    await page
      .locator(".jp-ClimateClaw-modelPopover .jp-ClimateClaw-modelOption", { hasText: name })
      .click();
    await page.waitForFunction(
      ({ shown, name }) =>
        [...document.querySelectorAll(`${shown} .jp-ClimateClaw-models button`)].some(
          (b) => b.offsetWidth > 0 && b.textContent === name,
        ),
      { shown: SHOWN_CHAT, name },
      { timeout: 10_000 },
    );
  };
  await choose("gpt-fast");
  const count = (await botMessages()).length;
  await sendChat("Which model answers?");
  await waitForChat((m) => m.length > count && m.at(-1).text.includes("the mean is 2.0"));
  check(
    "switching the model sends this chat's next question to it",
    api("streamresponse").at(-1)?.body?.chatbot === "gpt-fast",
    JSON.stringify(api("streamresponse").at(-1)?.body),
  );
  await choose("gpt-test");

  // With room (a wider side panel), the header shows its actions in a row, labelled: New chat,
  // History, and the signed-in avatar.
  await widenLeftPanel(560);
  const header = await page.evaluate((id) => {
    const panel = document.querySelector(id);
    const shown = (selector) => {
      const node = panel?.querySelector(selector);
      return !!node && !node.hidden && node.getBoundingClientRect().width > 0;
    };
    return {
      newChat: shown(".jp-ClimateClaw-headerButton.jp-mod-new"),
      history: shown(".jp-ClimateClaw-headerButton.jp-mod-history"),
      account: shown(".jp-ClimateClaw-account.jp-mod-signedIn"),
      labels: [...(panel?.querySelectorAll(".jp-ClimateClaw-headerLabel") ?? [])]
        .filter((l) => l.getBoundingClientRect().width > 0)
        .map((l) => l.textContent),
    };
  }, PANEL);
  check(
    "in a wider panel the header shows New chat, History and the avatar inline",
    header.newChat &&
      header.history &&
      header.account &&
      header.labels.includes("New chat") &&
      header.labels.includes("History"),
    JSON.stringify(header),
  );
});

await step("composer: context from the notebook", async () => {
  const visible = async (className) => (await composerButton(className).count()) > 0;
  // In ClimateClaw's panel the examples are a new chat's cards, not a Prompts menu.
  check(
    "the composer has Add context and the code toggle (the examples are a new chat's cards)",
    (await visible("jp-ClimateClaw-addContext")) &&
      (await visible("jp-ClimateClaw-codeToggle")) &&
      !(await visible("jp-ClimateClaw-prompts")),
  );
  check(
    "…and no second attach button beside Add context",
    (await chatPanel().locator(".jp-chat-attach-button:visible").count()) === 0,
  );
  // The draft notebook's first cell becomes the active cell.
  await showNotebook("Untitled");
  await nbCell(0).locator(".cm-content").click();
  await page.keyboard.press("Escape");
  await openChatPanel();
  // The input's chips (sent messages show theirs too).
  const chips = page.locator(`${SHOWN_CHAT} .jp-chat-input-container .jp-chat-attachment:visible`);
  await composerButton("jp-ClimateClaw-addContext").click();
  await page.locator(".lm-Menu-itemLabel", { hasText: /^Active cell of / }).click();
  await chips.first().waitFor({ timeout: 10_000 });
  check(
    "Add context → Active cell shows a removable chip",
    /\.ipynb: code cell/.test(await chips.first().textContent()) &&
      (await page
        .locator(`${SHOWN_CHAT} .jp-chat-input-container .jp-chat-attachment-remove:visible`)
        .count()) === 1,
    await chips.first().textContent(),
  );
  let count = (await botMessages()).length;
  await sendChat("What does this cell do?");
  await waitForChat((m) => m.length > count && m.at(-1).text.includes("the mean is 2.0"));
  const sent = api("streamresponse").at(-1)?.body?.input ?? "";
  check(
    "the cell's source goes to ClimateClaw with the question",
    sent.includes("What does this cell do?") &&
      sent.includes("Attached Files") &&
      sent.includes("x = 41"),
    sent.slice(0, 400),
  );
  check("a one-off chip is gone after sending", (await chips.count()) === 0);

  // Following: the chip comes back after each message, until the user removes it.
  await composerButton("jp-ClimateClaw-addContext").click();
  await page.locator(".lm-Menu-itemLabel", { hasText: "Follow the active cell" }).click();
  await chips.first().waitFor({ timeout: 10_000 });
  count = (await botMessages()).length;
  await sendChat("And now?");
  await waitForChat((m) => m.length > count && m.at(-1).text.includes("the mean is 2.0"));
  await chips.first().waitFor({ timeout: 10_000 });
  check(
    "following keeps the active cell attached after sending",
    (await chips.count()) === 1 &&
      (api("streamresponse").at(-1)?.body?.input ?? "").includes("x = 41"),
  );
  await page
    .locator(`${SHOWN_CHAT} .jp-chat-input-container .jp-chat-attachment-remove:visible`)
    .first()
    .click();
  await page.waitForTimeout(300);
  await composerButton("jp-ClimateClaw-addContext").click();
  const follow = page.locator(".lm-Menu-item", { hasText: "Follow the active cell" });
  check(
    "removing the chip stops following",
    (await chips.count()) === 0 &&
      !(await follow.getAttribute("class"))?.includes("lm-mod-toggled"),
  );
  await page.keyboard.press("Escape");
});

await step("examples and slash commands", async () => {
  // A new chat shows the examples as cards: a card asks its question.
  await chatPanel().locator(".jp-ClimateClaw-headerButton.jp-mod-new").click();
  const card = page.locator(`${SHOWN_CHAT} .jp-ClimateClaw-promptCard`, {
    hasText: EXAMPLES[1].title,
  });
  await card.waitFor({ timeout: 10_000 });
  const before = api("streamresponse").length;
  await card.click();
  await waitForChat((m) => m.some((x) => x.text.includes("the mean is 2.0")));
  check(
    "an example card asks its question",
    api("streamresponse").length === before + 1 &&
      (api("streamresponse").at(-1)?.body?.input ?? "").endsWith(EXAMPLES[1].prompt),
    api("streamresponse").at(-1)?.body?.input,
  );
  const input = await chatInput();
  await input.fill("");
  await input.type("/plot");
  const item = page
    .locator(".jp-chat-command-name, .jp-chat-command-menu li, [role='listbox'] [role='option']", {
      hasText: "/plot-map",
    })
    .first();
  await item.waitFor({ timeout: 10_000 });
  await item.click();
  await page.waitForTimeout(300);
  check(
    "a slash command becomes its example",
    (await input.inputValue()).includes(EXAMPLES[1].prompt),
    await input.inputValue(),
  );
  await input.fill("");
});

await step("hide code", async () => {
  const toggle = composerButton("jp-ClimateClaw-codeToggle");
  // A round icon: its tooltip and pressed state say what it does. With codeToNotebook (this
  // site's default) it starts on: the code is in its notebook cell, not repeated in the chat.
  check(
    "the code toggle is an icon, on, and says so",
    !(await toggle.textContent()).trim() &&
      /^Hide code is on/.test((await toggle.getAttribute("title")) ?? "") &&
      (await toggle.getAttribute("aria-pressed")) === "true",
    `${await toggle.getAttribute("title")} ${await toggle.getAttribute("aria-pressed")}`,
  );
  await toggle.click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".jp-ClimateClaw-codeToggle button")].some(
        (b) => b.offsetWidth > 0 && b.getAttribute("aria-pressed") === "false",
      ),
    null,
    { timeout: 10_000 },
  );
  check(
    "…and, toggled, that code is shown",
    /^Hide code is off/.test((await toggle.getAttribute("title")) ?? "") &&
      (await toggle.getAttribute("aria-pressed")) === "false",
  );
  const count = (await botMessages()).length;
  await sendChat("Again please");
  await waitForChat((m) => m.length > count && m.at(-1).text.includes("the mean is 2.0"));
  let [card] = await runCards(/the mean is 2\.0/);
  check(
    "with Hide code off the card shows the run's code",
    card?.code?.open === true && card.code.text.includes("np.mean"),
    JSON.stringify(card).slice(0, 400),
  );
  const again = await waitForCell(
    (c, all) => c === all.at(-1) && c.source.includes("np.mean"),
    (c) => c.text.includes("2.0"),
  );
  check("the code also runs into the notebook, with its output", !!again);
  // On again: every card's code folds - the one shown included; outputs and figures stay.
  await composerButton("jp-ClimateClaw-codeToggle").click();
  await page.waitForFunction(
    (shown) =>
      [...document.querySelectorAll(`${shown} details.jp-ClimateClaw-runCode`)].every(
        (d) => !d.open,
      ),
    SHOWN_CHAT,
    { timeout: 10_000 },
  );
  [card] = await runCards(/the mean is 2\.0/);
  check(
    "with Hide code the card's code is folded; its output and figure still show",
    card?.code?.open === false && !!card.parts.Output?.open && !!card.parts.Figures?.open,
    JSON.stringify(card).slice(0, 400),
  );
});

await step("stop", async () => {
  await sendChat("SLOW: a long analysis");
  await waitForChat((m) => m.some((x) => x.text.includes("Working on it")));
  const thread = [...mock.threads.entries()].find(([, t]) =>
    t.variants.some((v) => v.content === "SLOW: a long analysis"),
  )?.[0];
  // ClimateClaw's own Stop: in Send's place while the box is empty, beside Send while typing.
  const inPlace = page.locator(`${SHOWN_CHAT} .jp-ClimateClaw-stop[data-place="send"] button`);
  const sendShown = () => page.locator(`${SHOWN_CHAT} .jp-chat-send-button:visible`).count();
  await inPlace.waitFor({ timeout: 10_000 });
  check("while a reply streams, Stop takes Send's place", (await sendShown()) === 0);
  check(
    "jupyterlite-ai's own Stop is not shown",
    (await page.locator("button[title='Stop streaming']:visible").count()) === 0,
  );
  const input = await chatInput();
  await input.fill("Next question");
  await page
    .locator(`${SHOWN_CHAT} .jp-ClimateClaw-stop[data-place="beside"] button`)
    .waitFor({ timeout: 5_000 });
  check("typing brings Send back, with Stop beside it", (await sendShown()) === 1);
  await input.fill("");
  await inPlace.waitFor({ timeout: 5_000 });
  await inPlace.click();
  const deadline = Date.now() + 15_000;
  while (!mock.stops.includes(thread) && Date.now() < deadline) await page.waitForTimeout(200);
  check(
    "stop sends POST /stop with the chat's thread",
    !!thread && mock.stops.at(-1) === thread,
    `${thread} ${JSON.stringify(mock.stops)}`,
  );
  await page.waitForFunction(
    (shown) => !document.querySelector(`${shown} .jp-ClimateClaw-stop`),
    SHOWN_CHAT,
    { timeout: 15_000 },
  );
  check("once stopped, Send is back alone", (await sendShown()) === 1);
});

/** Shows History in ClimateClaw's panel (its list of the account's conversations). */
async function showHistory() {
  await openChatPanel();
  if ((await chatPanel().getAttribute("data-view")) !== "history") {
    await chatPanel().locator(".jp-ClimateClaw-headerButton.jp-mod-history").click();
  }
  const list = page.locator("#climateclaw-conversations");
  await list.waitFor({ state: "visible", timeout: 10_000 });
  return list;
}

await step("conversations: History", async () => {
  // An older conversation, and enough of them that the list has a second page.
  const variants = (topic) => [
    { variant: "User", content: topic },
    { variant: "Assistant", content: `About ${topic}.` },
  ];
  mock.seedThread("seed-enso", "jdoe", "ENSO analysis", variants("ENSO analysis"));
  for (let i = 0; i < 21; i += 1) {
    mock.seedThread(`seed-${i}`, "jdoe", `Old question ${i}`, variants(`Old question ${i}`));
  }
  const drawer = await showHistory();
  const opens = drawer.locator(".jp-ClimateClaw-conversation-open");
  await opens.first().waitFor({ timeout: 10_000 });
  check(
    "it loads a page and offers more",
    (await opens.count()) === 20 &&
      (await drawer.locator(".jp-ClimateClaw-conversations-more").isVisible()),
    String(await opens.count()),
  );
  await drawer.locator(".jp-ClimateClaw-conversations-more").click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#climateclaw-conversations .jp-ClimateClaw-conversation-open")
        .length > 20,
    null,
    { timeout: 10_000 },
  );
  check("Show more loads the next page", (await opens.count()) > 20, String(await opens.count()));
  const groups = await drawer.locator(".jp-ClimateClaw-conversations-groupTitle").allTextContents();
  check(
    "History groups conversations by day, today's first",
    groups[0] === "Today" && groups.at(-1) === "Earlier",
    JSON.stringify(groups),
  );
  await drawer.locator(".jp-ClimateClaw-conversations-search").fill("enso");
  check(
    "search narrows the list to matching topics",
    (await opens.count()) === 1 && /ENSO analysis/.test(await opens.first().textContent()),
    String(await opens.count()),
  );
  await drawer.locator(".jp-ClimateClaw-conversations-search").fill("");

  // A click opens the conversation in the chat panel, with its messages.
  await drawer
    .locator(`.jp-ClimateClaw-conversation-open[data-thread-id="${firstThread}"]`)
    .click();
  await page.waitForFunction(
    (shown) => {
      const chat = document.querySelector(shown);
      return !!chat && chat.offsetWidth > 0 && chat.textContent.includes("And the maximum?");
    },
    SHOWN_CHAT,
    { timeout: 20_000 },
  );
  // Messages render one by one: the replies may follow the questions.
  await page
    .waitForFunction(
      (shown) => document.querySelector(shown)?.textContent?.includes("the global mean"),
      SHOWN_CHAT,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  const opened = await page.evaluate(
    (shown) => document.querySelector(shown)?.textContent ?? "",
    SHOWN_CHAT,
  );
  check(
    "a conversation opens in the chat panel with its messages",
    opened.includes("the global mean"),
    opened.slice(0, 600),
  );
  await showHistory();
  check(
    "…and is marked as the current one",
    (await drawer
      .locator(".jp-ClimateClaw-conversation.jp-mod-current .jp-ClimateClaw-conversation-open")
      .getAttribute("data-thread-id")) === firstThread,
  );
});

await step("history: open in a tab and continue", async () => {
  const drawer = await showHistory();
  const row = drawer.locator(".jp-ClimateClaw-conversation", {
    has: page.locator(`[data-thread-id="${firstThread}"]`),
  });
  await row.locator(".jp-ClimateClaw-conversation-more").click();
  await page.locator(".lm-Menu-itemLabel", { hasText: "Open in a tab" }).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".lm-DockPanel .jp-ClimateClaw-mainChat")].some(
        (w) => w.offsetWidth > 0 && w.textContent.includes("And the maximum?"),
      ),
    null,
    { timeout: 20_000 },
  );
  const text = await page.evaluate(
    () =>
      [...document.querySelectorAll(".lm-DockPanel .jp-ClimateClaw-mainChat")].find(
        (w) => w.offsetWidth > 0 && w.textContent.includes("And the maximum?"),
      )?.textContent ?? "",
  );
  check(
    "the thread opens in a tab with its messages",
    text.includes("the global mean") && text.includes("And the maximum?"),
    text.slice(0, 300),
  );
  // History closes from the panel header's ×, back to the chat.
  await showHistory();
  await chatPanel().locator(".jp-ClimateClaw-headerButton.jp-mod-close").click();
  await page.waitForTimeout(300);
  check(
    "History closes from its own button",
    !(await drawer.isVisible()) && (await chatPanel().getAttribute("data-view")) !== "history",
  );
  const before = api("newthread").length;
  const input = page
    .locator(".lm-DockPanel .jp-ClimateClaw-mainChat:visible")
    .last()
    .locator("textarea:not([aria-hidden='true'])")
    .last();
  await input.fill("Continue from here");
  await input.press("Enter");
  const deadline = Date.now() + 20_000;
  while (
    !mock.threads.get(firstThread).variants.some((v) => v.content === "Continue from here") &&
    Date.now() < deadline
  ) {
    await page.waitForTimeout(200);
  }
  check(
    "continuing reuses the thread id",
    api("newthread").length === before &&
      mock.threads.get(firstThread).variants.some((v) => v.content === "Continue from here"),
  );
});

await step("a new chat starts a new thread", async () => {
  // ClimateClaw's panel has no /clear: a conversation is ended by starting a new one.
  await openChatPanel();
  const before = api("newthread").length;
  await chatPanel().locator(".jp-ClimateClaw-headerButton.jp-mod-new").click();
  await page
    .locator(`${SHOWN_CHAT} .jp-ClimateClaw-promptCard`)
    .first()
    .waitFor({ timeout: 10_000 });
  await sendChat("Fresh start");
  await waitForChat((m) => m.some((x) => x.text.includes("the mean is 2.0")));
  check("after New chat a new thread is started", api("newthread").length === before + 1);
});

// Run & fix

/** The visible notebook's "Run at DKRZ" (the face of its split button). */
const runAtDkrz = () =>
  page
    .locator(
      ".jp-NotebookPanel:not(.lm-mod-hidden) .jp-NotebookPanel-toolbar .jp-ClimateClaw-runAt-main",
    )
    .first();
/** Run at DKRZ's menu → Reset DKRZ session (offered once the active cell is not running). */
async function resetDkrzSession() {
  await page
    .locator(
      ".jp-NotebookPanel:not(.lm-mod-hidden) .jp-NotebookPanel-toolbar .jp-ClimateClaw-runAt-caret",
    )
    .first()
    .click();
  await page
    .locator(".jp-ClimateClaw-runAtMenu .lm-Menu-itemLabel", { hasText: "Reset DKRZ session" })
    .click();
}

await step("Run & fix", async () => {
  await page
    .locator(".lm-DockPanel-tabBar .lm-TabBar-tab", { hasText: "Untitled" })
    .first()
    .click();
  await setCell(page, 2, "y = 1/0\nprint(y)");
  const threadsBefore = api("newthread").length;
  await runAtDkrz().click();
  await page.waitForFunction(
    () =>
      document
        .querySelectorAll(".jp-Notebook .jp-Cell")[2]
        ?.textContent?.includes("ClimateClaw changed the code"),
    null,
    { timeout: 30_000 },
  );
  const cell = (await cells(page))[2];
  check("outputs say where they ran", cell.text.includes("Ran at DKRZ"));
  check(
    "the error is an error output",
    /ZeroDivisionError/.test(cell.text) && cell.html.includes("jp-OutputArea-output"),
  );
  check(
    "the cell keeps its own run; the fix's attempt is one line, its output kept for the fix",
    cell.text.includes("Run 2 ran without an error") && !cell.text.includes("fixed run"),
  );
  check(
    "a diff is shown",
    /-y = 1\/0/.test(cell.text) && /\+y = 1\/1/.test(cell.text),
    cell.text.slice(0, 500),
  );
  const post = [...mock.threads.values()].at(-1).variants.find((v) => v.variant === "User").content;
  check(
    "the request is the fixed template with the cell in a fenced block",
    post.startsWith(
      "Execute the following Python code with your code interpreter EXACTLY as given.",
    ) && post.includes("```python\ny = 1/0\nprint(y)\n```"),
  );
  check(
    "Run & fix uses the configured fast model",
    api("streamresponse").at(-1)?.body?.chatbot === "gpt-fast",
    JSON.stringify(api("streamresponse").at(-1)?.body),
  );
  const cellsBefore = await page.locator(".jp-Notebook .jp-Cell").count();
  await page
    .locator(".jp-toast-button, .jp-Notification-Toast button", { hasText: "Add fix below" })
    .first()
    .click();
  await page.waitForTimeout(300);
  check(
    "Add fix below adds the fix, with its output from DKRZ, under the cell; the cell stays",
    (await page.locator(".jp-Notebook .jp-Cell").count()) === cellsBefore + 1 &&
      (
        await page.locator(".jp-Notebook .jp-Cell").nth(2).locator(".cm-content").textContent()
      ).includes("y = 1/0") &&
      (
        await page.locator(".jp-Notebook .jp-Cell").nth(3).locator(".cm-content").textContent()
      ).includes("y = 1/1") &&
      ((await page.locator(".jp-Notebook .jp-Cell").nth(3).textContent()) ?? "").includes(
        "fixed run",
      ),
  );
  // The added cell goes; the next run offers the fix again, this time in the cell's place.
  await page.locator(".jp-Notebook .jp-Cell").nth(3).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("d");
  await page.keyboard.press("d");
  await page.locator(".jp-Notebook .jp-Cell").nth(2).click();
  await runAtDkrz().click();
  await page.waitForFunction(
    () =>
      document
        .querySelectorAll(".jp-Notebook .jp-Cell")[2]
        ?.textContent?.includes("ClimateClaw changed the code"),
    null,
    { timeout: 30_000 },
  );
  await page
    .locator(".jp-toast-button, .jp-Notification-Toast button", { hasText: "Replace cell" })
    .first()
    .click();
  await page.waitForTimeout(300);
  check(
    "Replace cell puts the fix in the cell's place",
    (
      await page.locator(".jp-Notebook .jp-Cell").nth(2).locator(".cm-content").textContent()
    ).includes("y = 1/1"),
  );

  // Two quick clicks are one job; an edit made after the request is never overwritten.
  await setCell(page, 2, "y = 1/0\nprint(y)");
  const streamsBefore = api("streamresponse").length;
  const runButton = runAtDkrz();
  // Both presses in one task, before the first can await anything.
  await runButton.evaluate((button) => {
    for (let i = 0; i < 2; i += 1) {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    }
  });
  await page.waitForFunction(
    () =>
      document
        .querySelectorAll(".jp-Notebook .jp-Cell")[2]
        ?.textContent?.includes("ClimateClaw changed the code"),
    null,
    { timeout: 30_000 },
  );
  check(
    "two quick clicks start one Run & fix",
    api("streamresponse").length === streamsBefore + 1,
    `${api("streamresponse").length - streamsBefore} requests`,
  );
  await setCell(page, 2, "z = 2  # edited meanwhile");
  await page
    .locator(".jp-toast-button, .jp-Notification-Toast button", { hasText: "Replace cell" })
    .first()
    .click();
  await page.waitForTimeout(300);
  check(
    "a fix is not applied over edits made after the request",
    (
      await page.locator(".jp-Notebook .jp-Cell").nth(2).locator(".cm-content").textContent()
    ).includes("z = 2  # edited meanwhile") &&
      (await page.getByText(/edited after Run & fix started/).count()) > 0,
  );

  await setCell(page, 2, "print('hi')");
  await runAtDkrz().click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".jp-Notebook .jp-Cell")[2]?.textContent?.includes("ran at dkrz"),
    null,
    { timeout: 30_000 },
  );
  const ok = (await cells(page))[2];
  check(
    "a cell without a fix gets stream output and an image",
    ok.html.includes("<img") && !ok.text.includes("changed the code"),
  );
  check(
    "one thread per notebook",
    api("newthread").length === threadsBefore + 1,
    `${api("newthread").length} vs ${threadsBefore}`,
  );

  // "Reset DKRZ session" (in Run at DKRZ's menu) forgets it.
  await resetDkrzSession();
  await runAtDkrz().click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".jp-Notebook .jp-Cell")[2]?.textContent?.includes("ran at dkrz"),
    null,
    { timeout: 30_000 },
  );
  check("Reset DKRZ session starts a new thread", api("newthread").length === threadsBefore + 2);

  // A kernel restart is a new session, and so is the thread.
  await page.locator(".lm-MenuBar-itemLabel", { hasText: "Kernel" }).click();
  await page
    .locator(".lm-Menu-itemLabel", { hasText: /^Restart Kernel…$|^Restart Kernel\.\.\.$/ })
    .first()
    .click();
  await page
    .locator(".jp-Dialog button.jp-mod-accept, .jp-Dialog button.jp-mod-warn")
    .first()
    .click();
  await kernelIdle(page, 180_000);
  await runAtDkrz().click();
  await page.waitForTimeout(500);
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".jp-Notebook .jp-Cell")[2]?.textContent?.includes("ran at dkrz"),
    null,
    { timeout: 30_000 },
  );
  check("a kernel restart starts a new thread", api("newthread").length === threadsBefore + 3);

  // Two cells of one notebook share its DKRZ thread: the second waits for the first.
  const press = () =>
    runButton.evaluate((button) =>
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })),
    );
  const conflictsBefore = mock.conflicts.length;
  await setCell(page, 2, "slow = 1  # SLOWFIX");
  await page.keyboard.press("Escape");
  await press();
  await setCell(page, 1, "quick = 2");
  await page.keyboard.press("Escape");
  await press();
  await page.waitForFunction(
    () => document.querySelectorAll(".jp-Notebook .jp-Cell")[1]?.textContent?.includes("Queued"),
    null,
    { timeout: 10_000 },
  );
  check("a second cell's Run & fix waits, and says so, while the first runs", true);
  await page.waitForFunction(
    () =>
      [1, 2].every((i) =>
        document.querySelectorAll(".jp-Notebook .jp-Cell")[i]?.textContent?.includes("ran at dkrz"),
      ),
    null,
    { timeout: 30_000 },
  );
  const texts = (await cells(page)).slice(1, 3).map((c) => c.text);
  check(
    "…then runs on the same thread: both cells get their results, neither a conflict",
    texts.every((t) => !/409|ClimateClawError|Queued/.test(t)) &&
      mock.conflicts.length === conflictsBefore,
    JSON.stringify(texts),
  );

  // Stop: the thread stays the stopped run's until DKRZ ends it (the mock's run goes on for
  // 2.5 s after the stop), then the queued cell runs on it, without a conflict.
  const cellText = (i) =>
    page.evaluate((n) => document.querySelectorAll(".jp-Notebook .jp-Cell")[n]?.textContent, i);
  await setCell(page, 2, "slow = 3  # SLOWFIX");
  await page.keyboard.press("Escape");
  await press();
  await setCell(page, 1, "after = 4");
  await page.keyboard.press("Escape");
  await press();
  await page.waitForFunction(
    () => document.querySelectorAll(".jp-Notebook .jp-Cell")[1]?.textContent?.includes("Queued"),
    null,
    { timeout: 10_000 },
  );
  await nbCell(2).locator(".jp-InputPrompt").click();
  const stopButton = page
    .locator('.jp-cell-toolbar [data-command="climateclaw:stop-run-and-fix"]:visible')
    .first();
  await stopButton.waitFor({ timeout: 10_000 });
  check(
    "the running cell's toolbar offers Stop",
    /^Stop/.test((await stopButton.getAttribute("aria-label")) ?? ""),
    await stopButton.evaluate((b) => b.outerHTML.slice(0, 300)),
  );
  await stopButton.click();
  await page.waitForFunction(
    () => document.querySelectorAll(".jp-Notebook .jp-Cell")[2]?.textContent?.includes("Stopping"),
    null,
    { timeout: 10_000 },
  );
  check(
    "stopping holds the thread: the queued cell has not started",
    (await cellText(1)).includes("Queued") && !(await cellText(1)).includes("ran at dkrz"),
    await cellText(1),
  );
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".jp-Notebook .jp-Cell")[2]?.textContent?.includes("Stopped.") &&
      document.querySelectorAll(".jp-Notebook .jp-Cell")[1]?.textContent?.includes("ran at dkrz"),
    null,
    { timeout: 30_000 },
  );
  check(
    "once DKRZ ended the stopped run, the queued cell ran on the thread, without a conflict",
    mock.conflicts.length === conflictsBefore && !/409|ClimateClawError/.test(await cellText(1)),
    `${mock.conflicts.length - conflictsBefore} conflicts: ${await cellText(1)}`,
  );

  // A reset while the thread is still being made: the old session's thread is not kept. While a
  // cell runs, Run at DKRZ shows Stop instead of its menu; a kernel restart resets the session
  // the same way (and is what a user can do then).
  await resetDkrzSession();
  let releaseThread;
  const threadGate = new Promise((resolve) => (releaseThread = resolve));
  const newThreadUrl = `${MOCK}/api/chatbot/newthread**`;
  await page.route(newThreadUrl, async (route) => {
    await threadGate;
    await route.continue();
  });
  const threadsAtReset = api("newthread").length;
  await setCell(page, 2, "print('fence')");
  await page.keyboard.press("Escape");
  await press();
  await page.waitForTimeout(500);
  await page.locator(".lm-MenuBar-itemLabel", { hasText: "Kernel" }).click();
  await page
    .locator(".lm-Menu-itemLabel", { hasText: /^Restart Kernel…$|^Restart Kernel\.\.\.$/ })
    .first()
    .click();
  await page
    .locator(".jp-Dialog button.jp-mod-accept, .jp-Dialog button.jp-mod-warn")
    .first()
    .click();
  releaseThread();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".jp-Notebook .jp-Cell")[2]?.textContent?.includes("ran at dkrz"),
    null,
    { timeout: 30_000 },
  );
  await page.unroute(newThreadUrl);
  await press();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".jp-Notebook .jp-Cell")[2]?.textContent?.includes("ran at dkrz"),
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(300);
  check(
    "a thread made for a session reset meanwhile is not reused: the next run makes its own",
    api("newthread").length === threadsAtReset + 2,
    `${api("newthread").length - threadsAtReset} new threads`,
  );
});

// the data panel

await step("data panel: browse, search, open in a notebook that runs", async () => {
  await showLeft(`${SITE_TITLE} data`);
  const panel = page.locator(".jp-FrevaData");
  await panel.locator("text=Test archive").first().waitFor({ timeout: 30_000 });
  check("the tree shows the archive's root", true);
  const search = panel.locator("input[type='search'], .dataset-tree input").first();
  await search.fill("sfcwind");
  const result = panel.locator('[data-dt-row="s3://data/sfcwind.zarr/"]').first();
  await result.waitFor({ timeout: 15_000 });
  check("search finds an unopened store through the index", await result.isVisible());
  const tabs = () =>
    page.evaluate(() => document.querySelectorAll(".lm-DockPanel-tabBar .lm-TabBar-tab").length);
  const before = await tabs();
  await result.dblclick();
  await result.click();
  await page.waitForTimeout(300);
  await result.click();
  await page.waitForTimeout(1500);
  check("clicks on a row only select it: no notebook opens", (await tabs()) === before);
  check(
    "the card names the selected store",
    /sfcwind\.zarr/.test(await panel.locator(".jp-FrevaData-selectedName").innerText()),
  );
  await panel.locator(".jp-FrevaData-action.jp-mod-primary").click();
  // Its own notebook, in front (named after the store).
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".lm-DockPanel-tabBar .lm-TabBar-tab.lm-mod-current")].some(
        (t) => /^sfcwind.*\.ipynb$/.test(t.textContent.trim()),
      ),
    null,
    { timeout: 30_000 },
  );
  await kernelIdle(page, 240_000);
  const opened = await nbCells();
  check(
    "the primary action opens a notebook with a header naming the dataset",
    opened[0]?.kind === "markdown" && /sfcwind\.zarr/.test(opened[0].text),
    JSON.stringify(opened).slice(0, 400),
  );
  check(
    "it is pre-filled with the registered recipe only",
    opened.length === 2 && opened[1].kind === "code",
  );
  await nbCell(1).click();
  await page.keyboard.press("Shift+Enter");
  await kernelIdle(page, 240_000);
  const ran = await nbCells();
  check(
    "the recipe runs on Freva Python",
    /sfcWind|Dimensions/.test(ran[1]?.text ?? ""),
    ran[1]?.text.slice(0, 300),
  );
});

await step("data panel: insert and drag", async () => {
  const panel = page.locator(".jp-FrevaData");
  const row = panel.locator('[data-dt-row="s3://data/sfcwind.zarr/"]').first();
  await row.click();
  const before = (await nbCells()).length;
  await panel.locator('[data-command="freva-data:insert"]').click();
  await page.waitForTimeout(500);
  check("Insert adds the snippet below the active cell", (await nbCells()).length === before + 1);
  const box = await row.boundingBox();
  const target = await nbCell(0).boundingBox();
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 30, { steps: 5 });
  await page.mouse.move(target.x + 100, target.y + target.height / 2, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  check(
    "dragging a dataset onto the notebook inserts its snippet",
    (await nbCells()).length === before + 2,
  );
});

await step("data panel: inspect, ask, copy, globe", async () => {
  const panel = page.locator(".jp-FrevaData");
  await panel.locator('[data-dt-row="s3://data/sfcwind.zarr/"]').first().click();
  await panel.locator('[data-command="freva-data:inspect"]').click();
  // The inspector in front (a globe opened earlier is a tab of its own, closed by then).
  const tab = page.locator(".jp-FrevaData-inspector:not(.lm-mod-hidden) data-inspector");
  await tab.waitFor({ state: "attached", timeout: 20_000 });
  await page.waitForFunction(
    () =>
      document
        .querySelector(".jp-FrevaData-inspector:not(.lm-mod-hidden) data-inspector")
        ?.textContent?.includes("sfcWind"),
    null,
    { timeout: 30_000 },
  );
  check("Inspect opens the store's metadata in a tab", true);
  // Signed in, the store is read with the bearer: GridLook could not read it, and says so.
  const blocked = (await tab.getAttribute("viewer-disabled")) ?? "";
  check(
    "a store read with the bearer keeps the 3D viewer off, saying why",
    /share link/.test(blocked) && (await tab.locator("#nc-tab-gridlook").isDisabled()),
    blocked,
  );

  await showLeft(`${SITE_TITLE} data`);
  await panel.locator('[data-command="freva-data:ask-climateclaw"]').click();
  await page.waitForTimeout(800);
  const askText = await page.evaluate(
    () =>
      [...document.querySelectorAll("textarea")]
        .map((t) => t.value)
        .find((v) => v.includes("Help me open")) ?? "",
  );
  check(
    "Ask ClimateClaw pre-fills the chat with the URL and metadata",
    askText.includes(STORE_URL) && askText.includes("sfcwind.zarr"),
    askText,
  );

  await showLeft(`${SITE_TITLE} data`);
  await panel.locator('[data-dt-row="s3://data/sfcwind.zarr/"]').first().click();
  await panel.locator('[data-command="freva-data:copy-url"]').click();
  await page.waitForTimeout(200);
  check(
    "Copy URL says it copied",
    /Copied/.test(await panel.locator('[data-command="freva-data:copy-url"]').innerText()),
  );
  // Copy code is in the row's context menu (not on the card).
  await panel.locator('[data-dt-row="s3://data/sfcwind.zarr/"]').first().click({ button: "right" });
  await page.locator('.lm-Menu-item[data-command="freva-data:copy-code"]').click();
  await page.waitForTimeout(500);
  const copied = await page.evaluate(() => window.__copied);
  check("Copy URL copies the store's URL", copied.includes(STORE_URL), JSON.stringify(copied));
  check(
    "Copy code copies the recipe",
    copied.some((c) => c.includes("xr.open_dataset") && c.includes(STORE_URL)),
  );
  check(
    "View on globe is offered where the site has GridLook",
    await panel.locator('[data-command="freva-data:view-on-globe"]').isEnabled(),
  );
});

await step("example notebooks are copied, not edited", async () => {
  await page
    .locator(".lm-DockPanel-tabBar .lm-TabBar-tab", { hasText: "Launcher" })
    .first()
    .click()
    .catch(async () => {
      await page.keyboard.press("Control+Shift+L");
    });
  await page.locator(".jp-LauncherCard", { hasText: "Example notebooks" }).click();
  await page.locator(".jp-FrevaData-galleryCard", { hasText: "ERA5 walkthrough" }).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".lm-DockPanel-tabBar .lm-TabBar-tab")].some((t) =>
        /^era5(-\d+)?\.ipynb$/.test(t.textContent.trim()),
      ),
    null,
    { timeout: 30_000 },
  );
  check("opening an example opens a copy in the visitor's files", true);
});

// codeToNotebook: false

await step("chat with codeToNotebook off: code, output and image in the chat", async () => {
  const main = page;
  // A fresh context (its own storage, so a clean workspace) on the same site, with the
  // operator's codeToNotebook switched off.
  const other = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  other.on("request", (r) => record.origins.add(new URL(r.url()).origin));
  const second = await other.newPage();
  await second.route("**/jupyter-lite.json", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const plugin =
      json["jupyter-config-data"]?.settingsOverrides?.["@freva-org/jupyterlite-climateclaw:plugin"];
    if (plugin) plugin.codeToNotebook = false;
    const data =
      json["jupyter-config-data"]?.settingsOverrides?.["@freva-org/jupyterlite-freva-data:plugin"];
    if (data) data.gridlook = false;
    await route.fulfill({ response, json });
  });
  page = second;
  try {
    await page.goto(`${NB}/lab/index.html`);
    await page.waitForSelector(".jp-LauncherCard", { timeout: 120_000 });
    await page.waitForTimeout(1500);
    // Without GridLook: no globe, and Inspect's 3D viewer stays off.
    await showLeft(`${SITE_TITLE} data`);
    const dataPanel = page.locator(".jp-FrevaData");
    await dataPanel.locator("text=Test archive").first().waitFor({ timeout: 30_000 });
    await dataPanel.locator("input[type='search'], .dataset-tree input").first().fill("sfcwind");
    await dataPanel.locator('[data-dt-row="s3://data/sfcwind.zarr/"]').first().click();
    check(
      "without GridLook, View on globe stays disabled",
      await dataPanel.locator('[data-command="freva-data:view-on-globe"]').isDisabled(),
    );
    await dataPanel.locator('[data-command="freva-data:inspect"]').click();
    const inspector = page.locator(".jp-FrevaData-inspector:not(.lm-mod-hidden) data-inspector");
    await page.waitForFunction(
      () =>
        document
          .querySelector(".jp-FrevaData-inspector:not(.lm-mod-hidden) data-inspector")
          ?.textContent?.includes("sfcWind"),
      null,
      { timeout: 30_000 },
    );
    // The site's policy (`viewer-off`), which no read changes - not a store's (`viewer-disabled`).
    check(
      "…and Inspect's 3D viewer is off, even for a store anyone may read",
      (await inspector.getAttribute("viewer-off")) ===
        "The 3D viewer is not enabled on this site." &&
        (await inspector.locator("#nc-tab-gridlook").isDisabled()),
      await inspector.getAttribute("viewer-off"),
    );
    await showLeft("ClimateClaw");
    await Promise.all([other.waitForEvent("page"), accountButton().click()]);
    await signedIn();
    // Signed in from its first page, the panel opens a new chat by itself.
    await page.waitForFunction((id) => document.querySelector(id)?.dataset.view === "chat", PANEL, {
      timeout: 30_000,
    });
    await openChatPanel();
    const notebooksBefore = await page.locator(".jp-NotebookPanel").count();
    await sendChat(EXAMPLES[0].prompt);
    const messages = await waitForChat((m) => m.some((x) => /the mean is 2\.0/.test(x.text)));
    const reply = messages.find((x) => /the mean is 2\.0/.test(x.text));
    // Without a notebook for it, the run's card holds its code (a python block), output and image.
    check(
      "code is a python block",
      /<pre[\s>]/.test(reply.html) &&
        reply.text.includes("import numpy as np") &&
        reply.text.includes("np.mean([1, 2, 3])"),
      reply.html.slice(0, 600),
    );
    check("the output is shown", reply.text.includes("2.0") && reply.text.includes("Output"));
    check(
      "the image is shown from its fragments",
      /<img[^>]+src="data:image\/png;base64,iVBOR/.test(reply.html),
    );
    check(
      "no notebook was opened for it",
      (await page.locator(".jp-NotebookPanel").count()) === notebooksBefore,
    );
    await composerButton("jp-ClimateClaw-codeToggle").click();
    const count = (await botMessages()).length;
    await sendChat("Again please");
    const hidden = await waitForChat(
      (m) => m.length > count && m.at(-1).text.includes("the mean is 2.0"),
    );
    const last = hidden.at(-1);
    const [card] = await runCards(/the mean is 2\.0/);
    check(
      "with Hide code the run's code is folded under its line",
      card?.code?.open === false && card.code.text.includes("np.mean"),
      JSON.stringify(card).slice(0, 300),
    );
    check("with Hide code the output is still shown", last.text.includes("Output"));
  } finally {
    page = main;
    await other.close();
  }
});

// the page as a whole

await step("policy and origins", async () => {
  // Every violation the page reported, with where it came from (the console repeats them).
  const detail = await page.evaluate(() => window.__cspDetail);
  const unexpected = detail.filter((v) => !KNOWN_PROBE(v));
  const consoleOnly = (await violations(page, record)).filter(
    (v) => !/script-src eval|Refused to evaluate a string/.test(v),
  );
  check(
    "zero CSP violations (besides zod's documented eval probe)",
    unexpected.length === 0 && consoleOnly.length === 0,
    JSON.stringify([...unexpected, ...consoleOnly]),
  );
  check(
    "the tolerated probe is at most one per document",
    detail.length - unexpected.length <= 1,
    JSON.stringify(detail),
  );
  // GridLook's origin is answered by the stub above: no request leaves the machine.
  const allowed = new Set([NB, served.runtime.url, served.data.url, MOCK, GRIDLOOK]);
  const foreign = [...record.origins].filter(
    (o) => !allowed.has(o) && !o.startsWith("data:") && !o.startsWith("blob:") && o !== "null",
  );
  check("no foreign requests", foreign.length === 0, foreign.join(", "));
  check("the main tab never navigated", mainNavigations.length === 1, mainNavigations.join(" | "));
});

await browser.close();
await served.close();
await mock.close();
process.exit(report(`ClimateClaw and the data panel in JupyterLite Lab (${ENGINE})`, checks));
