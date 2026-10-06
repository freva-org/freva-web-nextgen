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
  /\/extensions\/@jupyternaut\/persona\/static\/[0-9a-f.]+\.js$/.test(v.source);

const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: Boolean(pass), detail: pass ? "" : String(detail).slice(0, 600) });
};
const step = async (name, fn) => {
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
        .evaluate(() => document.getElementById("@jupyterlite/ai:chat-panel")?.outerHTML ?? "")
        .catch(() => "");
      console.log(`--- ${name}\n${dom.replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>").slice(0, 6000)}`);
    }
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
const chatPanel = () => page.locator('[id="@jupyterlite/ai:chat-panel"]');
async function openChatPanel() {
  const open = await page.evaluate(() => {
    const panel = document.getElementById("@jupyterlite/ai:chat-panel");
    return !!panel && !panel.classList.contains("lm-mod-hidden") && panel.offsetWidth > 0;
  });
  if (!open) await showLeft("Chat");
  await chatPanel()
    .locator(".jp-chat-input-container, .jp-chat-input")
    .first()
    .waitFor({ timeout: 30_000 });
}
/** A ClimateClaw toolbar command, in the toolbar or in its overflow popup. */
async function toolbarCommand(command) {
  const direct = page.locator(`[data-command="${command}"]:visible`).first();
  if (await direct.count()) return direct;
  const opener = chatPanel()
    .locator(
      ".jp-Toolbar-responsive-opener:visible, [data-jp-item-name='toolbar-popup-opener'] button:visible",
    )
    .first();
  if (await opener.count()) await opener.click();
  return page.locator(`[data-command="${command}"]:visible`).first();
}
async function chatInput() {
  return chatPanel().locator("textarea:not([aria-hidden='true'])").last();
}
async function sendChat(text) {
  // Away from the composer's buttons first: a hovered button's tooltip sits over the input.
  await page.mouse.move(1, 1);
  const input = await chatInput();
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}
const botMessages = () =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[id="@jupyterlite/ai:chat-panel"] .jp-chat-rendered-message, [id="@jupyterlite/ai:chat-panel"] .jp-chat-message',
      ),
    ].map((m) => ({ text: m.textContent ?? "", html: m.innerHTML })),
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
  const button = await toolbarCommand("climateclaw:account");
  return `${await button.textContent()} | ${(await button.getAttribute("title")) ?? ""}`;
};
/**
 * An item of the visible chat's header. A narrow side panel folds the header into its "More
 * commands" popup (jupyterlite-ai's responsive toolbar): open it when the item is not shown.
 */
async function headerItem(selector) {
  const shown = page.locator(`${selector}:visible`).last();
  if (await shown.count()) return shown;
  const opener = chatPanel()
    .locator(".jp-chat-sidepanel-widget-toolbar .jp-Toolbar-responsive-opener:visible")
    .last();
  if (await opener.count()) await opener.click();
  return shown;
}
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
  const want = [
    "Notebook: Freva Python",
    `${SITE_TITLE}: New ${SITE_TITLE} notebook`,
    `${SITE_TITLE}: Browse data`,
    `${SITE_TITLE}: Example notebooks`,
    `${SITE_TITLE}: Ask ClimateClaw`,
  ];
  check(
    "the trimmed launcher shows one kernel and only the site's cards",
    JSON.stringify(cards) === JSON.stringify(want),
    JSON.stringify(cards),
  );
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll(".jp-SideBar.jp-mod-left .lm-TabBar-tab")].map(
      (t) => (t.getAttribute("title") ?? "").split(" (")[0],
    ),
  );
  check(
    "left side: files, the data panel, running, contents, chat",
    [
      "File Browser",
      `${SITE_TITLE} data`,
      "Running Terminals and Kernels",
      "Table of Contents",
      "Chat with AI assistant",
    ].every((t) => tabs.includes(t)),
    JSON.stringify(tabs),
  );
  const consoleErrors = record.console.filter(
    (l) => /^error/.test(l) && !/Failed to load resource/.test(l),
  );
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
  await page
    .locator(".lm-DockPanel-tabBar .lm-TabBar-tab", { hasText: "Inspect sfcwind" })
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
  await (await toolbarCommand("climateclaw:account")).click();
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
  await page.waitForFunction(
    () => !!document.querySelector('[data-command="climateclaw:account"].jp-mod-signedIn'),
    null,
    { timeout: 30_000 },
  );
  check(
    "the login in a new tab signs this page in",
    /jdoe/.test(await accountLabel()),
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
  await (await toolbarCommand("climateclaw:account")).click();
  await page.locator(".lm-Menu-itemLabel", { hasText: "Sign out" }).click();
  await page.waitForFunction(
    () => !document.querySelector('[data-command="climateclaw:account"].jp-mod-signedIn'),
    null,
    { timeout: 15_000 },
  );
  check(
    "sign-out revokes the credential and signs the page out",
    mock.log.filter((r) => r.path === `${AUTH}/revoke`).length > revokes,
  );
});

// popup login

await step("popup login with a severed opener", async () => {
  const before = mock.log.filter((r) => r.path === `${AUTH}/callback`).length;
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    (await toolbarCommand("climateclaw:account")).click(),
  ]);
  await page.waitForFunction(
    () => !!document.querySelector('[data-command="climateclaw:account"].jp-mod-signedIn'),
    null,
    { timeout: 30_000 },
  );
  check(
    "the popup login completes over BroadcastChannel (the provider page severs the opener)",
    /jdoe/.test(await accountLabel()),
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
  check("still signed in as before", /jdoe/.test(await accountLabel()));
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
  // codeToNotebook (the default): the code is a new cell in the open notebook, with its output
  // and figure; the chat says where it went. The chat rendering is checked with it off, below.
  const ranCell = await waitForCell(
    (c) => c.source.includes("np.mean([1, 2, 3])"),
    (c) => c.html.includes("<img"),
  );
  check(
    "the code it ran is a new code cell in the open notebook",
    ranCell?.kind === "code" && ranCell.source.includes("import numpy as np"),
    `${reply.text.match(/DKRZ ?Cell[^\n]*/)?.[0]} | ${JSON.stringify((await nbCells()).map((c) => [c.source.slice(0, 40), c.text.slice(0, 80), c.html.slice(0, 200)]))}`,
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
  // The chips the reply shows in the code's place: rendered (sanitised, styled), not as text.
  const chips = await page.evaluate(() => {
    const replies = [
      ...document.querySelectorAll('[id="@jupyterlite/ai:chat-panel"] .jp-chat-rendered-message'),
    ].filter((m) => m.textContent.includes("the mean is 2.0"));
    const ran = replies.at(-1)?.querySelector(".jp-ClimateClaw-ran");
    const style = ran && getComputedStyle(ran);
    return {
      at: ran?.querySelector(".jp-ClimateClaw-ran-at")?.textContent ?? "",
      cell: ran?.querySelector(".jp-ClimateClaw-ran-cell")?.textContent ?? "",
      notebook: ran?.querySelector(".jp-ClimateClaw-ran-nb")?.textContent ?? "",
      title: ran?.getAttribute("title") ?? "",
      pill: style ? `${style.display} ${style.borderTopLeftRadius}` : "",
      outcomes: [...(replies.at(-1)?.querySelectorAll(".jp-ClimateClaw-outcome") ?? [])].map(
        (o) => `${o.className.replace("jp-ClimateClaw-outcome", "").trim()}:${o.textContent}`,
      ),
    };
  });
  check(
    "the chat shows a chip where the code ran instead of repeating it",
    chips.at === "DKRZ" &&
      /^Cell \d+$/.test(chips.cell) &&
      /\.ipynb$/.test(chips.notebook) &&
      /^Ran at DKRZ by ClimateClaw \(gpt-test\)/.test(chips.title) &&
      chips.pill.startsWith("inline-flex") &&
      !reply.html.includes("np.mean") &&
      !/data:image\/png/.test(reply.html),
    JSON.stringify(chips),
  );
  check(
    "…then how it ended, and its figure",
    JSON.stringify(chips.outcomes) ===
      JSON.stringify(["jp-mod-ok:✓ ran · output", "jp-mod-figure:◩ figure"]),
    JSON.stringify(chips.outcomes),
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
  // Sampled while the reply streams: the status line, the cell's code, any old persona name.
  const labels = new Set();
  const lengths = new Set();
  let bird = "";
  let sawJupyternaut = false;
  let fullLength = 0;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const sample = await page.evaluate((root) => {
      const busy = document.querySelector(".jp-ClimateClaw-busy");
      const cell = [...(document.querySelector(root)?.querySelectorAll(".jp-Cell") ?? [])]
        .map((c) => c.querySelector(".cm-content")?.textContent ?? "")
        .find((t) => t.startsWith("# typed by ClimateClaw"));
      const chat = document.getElementById("@jupyterlite/ai:chat-panel");
      return {
        label: busy?.getAttribute("title") ?? "",
        bird: busy?.querySelector("img")?.getAttribute("src")?.slice(0, 22) ?? "",
        code: cell ?? "",
        jupyternaut: /Jupyternaut/.test(chat?.textContent ?? ""),
        done: /All typed\./.test(chat?.textContent ?? ""),
      };
    }, NOTEBOOK);
    if (sample.label) labels.add(sample.label.split(" · ")[0]);
    if (sample.bird) bird = sample.bird;
    if (sample.code) lengths.add(sample.code.length);
    sawJupyternaut ||= sample.jupyternaut;
    if (sample.done && !sample.label) {
      fullLength = sample.code.length;
      break;
    }
    if (Date.now() > deadline) throw new Error(`no end: ${JSON.stringify([...labels])}`);
    await page.waitForTimeout(60);
  }
  check(
    "while it works, a status line beside Send shows the bird and what it is doing",
    bird === "data:image/webp;base64" &&
      labels.has("Thinking") &&
      labels.has("Writing code") &&
      labels.has("Running code at DKRZ"),
    `${bird} ${JSON.stringify([...labels])}`,
  );
  const partial = [...lengths].filter((n) => n > 0 && n < fullLength);
  check(
    "the code types into its cell as it streams",
    partial.length >= 3 && fullLength > 400,
    `${fullLength} ${JSON.stringify([...lengths])}`,
  );
  const reply = (await waitForChat((m) => m.length > count && /All typed/.test(m.at(-1).text))).at(
    -1,
  );
  const number = Number(/DKRZ ?Cell (\d+)/.exec(reply.text)?.[1] ?? 0);
  check("the chat names the cell, not the code", number > 0 && !reply.text.includes("x11 = 11"));
  const chip = composerButton("jp-ClimateClaw-cells");
  await chip.waitFor({ timeout: 10_000 });
  check(
    "when it is done, the status line becomes a jump to that cell",
    (await page.locator(".jp-ClimateClaw-busy").count()) === 0 &&
      (await chip.getAttribute("title"))?.includes(`cell ${number}`),
    await chip.getAttribute("title"),
  );
  await nbCell(0).click();
  await page.mouse.move(1, 1);
  await chip.click();
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
  const header = await page.evaluate(() => {
    const headers = [
      ...document.querySelectorAll('[id="@jupyterlite/ai:chat-panel"] .jp-chat-message-header'),
    ];
    const last = headers.at(-1);
    return {
      text: last?.textContent ?? "",
      avatar: last?.querySelector("img")?.getAttribute("alt") ?? "",
      src: last?.querySelector("img")?.getAttribute("src")?.slice(0, 22) ?? "",
    };
  });
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
  const outcome = await page.evaluate(() => {
    const replies = [
      ...document.querySelectorAll('[id="@jupyterlite/ai:chat-panel"] .jp-chat-rendered-message'),
    ];
    const chip = replies.at(-1)?.querySelector(".jp-ClimateClaw-outcome");
    return { text: chip?.textContent ?? "", cls: chip?.className ?? "", title: chip?.title ?? "" };
  });
  check(
    "the error's name is a red chip, the message its tooltip",
    outcome.text === "✗ ZeroDivisionError" &&
      outcome.cls.includes("jp-mod-error") &&
      outcome.title === "ZeroDivisionError: division by zero",
    JSON.stringify(outcome),
  );
});

await step("header: model chip and account menu", async () => {
  let chip = await headerItem(".jp-ClimateClaw-modelChip-button");
  check(
    "the header names the host and this chat's model (in full in its tooltip)",
    /127\.0\.0\.1, model gpt-test/.test((await chip.getAttribute("title")) ?? ""),
    await chip.getAttribute("title"),
  );
  const narrowTier = await chip.evaluate((b) => b.parentElement.dataset.tier);
  check(
    "in the default narrow panel the chip shrinks (or folds into the header's popup in full)",
    narrowTier === "logo" || narrowTier === "full",
    narrowTier,
  );
  await chip.click();
  await page
    .locator(".jp-ClimateClaw-modelMenu .lm-Menu-itemLabel", { hasText: "gpt-fast" })
    .click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".jp-ClimateClaw-modelChip-button")].some(
        (b) => b.offsetWidth > 0 && b.dataset.model === "gpt-fast",
      ),
    null,
    { timeout: 10_000 },
  );
  const count = (await botMessages()).length;
  await sendChat("Which model answers?");
  await waitForChat((m) => m.length > count && m.at(-1).text.includes("the mean is 2.0"));
  check(
    "switching the model in the header sends this chat's next question to it",
    api("streamresponse").at(-1)?.body?.chatbot === "gpt-fast",
    JSON.stringify(api("streamresponse").at(-1)?.body),
  );
  chip = await headerItem(".jp-ClimateClaw-modelChip-button");
  await chip.click();
  await page
    .locator(".jp-ClimateClaw-modelMenu .lm-Menu-itemLabel", { hasText: "gpt-test" })
    .click();

  // With room (a wider side panel), the header shows them in a row: model, conversations, avatar.
  await widenLeftPanel(560);
  const inline = await page.evaluate(() => {
    const header = [...document.querySelectorAll(".jp-chat-sidepanel-widget-toolbar")].find(
      (t) => t.offsetWidth > 0,
    );
    const shown = (selector) => {
      const node = header?.querySelector(selector);
      return !!node && node.getBoundingClientRect().width > 0;
    };
    return {
      model: shown(".jp-ClimateClaw-modelChip-button"),
      text: header?.querySelector(".jp-ClimateClaw-modelChip-text")?.textContent ?? "",
      history: shown('[data-command="climateclaw:history"]'),
      account: shown('[data-command="climateclaw:account"].jp-mod-signedIn'),
    };
  });
  check(
    "in a wider panel the header shows the model, conversations and avatar inline",
    inline.model && inline.history && inline.account && inline.text === "127.0.0.1 · gpt-test",
    JSON.stringify(inline),
  );

  await (await toolbarCommand("climateclaw:account")).click();
  const labels = await page
    .locator(".jp-ClimateClaw-accountMenu .lm-Menu-itemLabel")
    .allTextContents();
  check(
    "the account menu names the user and offers sign-out",
    labels.some((l) => /Signed in as jdoe/.test(l)) && labels.includes("Sign out"),
    JSON.stringify(labels),
  );
  await page.keyboard.press("Escape");
});

await step("composer: context from the notebook", async () => {
  const visible = async (className) => (await composerButton(className).count()) > 0;
  check(
    "the composer has Add context, Prompts and the code toggle",
    (await visible("jp-ClimateClaw-addContext")) &&
      (await visible("jp-ClimateClaw-prompts")) &&
      (await visible("jp-ClimateClaw-codeToggle")),
  );
  check(
    "…and no second attach button beside Add context",
    (await chatPanel().locator(".jp-chat-attach-button:visible").count()) === 0,
  );
  // The draft notebook's first cell becomes the active cell.
  await nbCell(0).locator(".cm-content").click();
  await page.keyboard.press("Escape");
  await openChatPanel();
  // The input's chips (sent messages show theirs too).
  const chips = chatPanel().locator(".jp-chat-input-container .jp-chat-attachment:visible");
  await composerButton("jp-ClimateClaw-addContext").click();
  await page.locator(".lm-Menu-itemLabel", { hasText: /^Active cell of / }).click();
  await chips.first().waitFor({ timeout: 10_000 });
  check(
    "Add context → Active cell shows a removable chip",
    /\.ipynb: code cell/.test(await chips.first().textContent()) &&
      (await chatPanel()
        .locator(".jp-chat-input-container .jp-chat-attachment-remove:visible")
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
  await chatPanel()
    .locator(".jp-chat-input-container .jp-chat-attachment-remove:visible")
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
  await composerButton("jp-ClimateClaw-prompts").click();
  await page.locator(".lm-Menu-itemLabel", { hasText: EXAMPLES[1].title }).first().click();
  check(
    "an example fills the input",
    (await (await chatInput()).inputValue()) === EXAMPLES[1].prompt,
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
  // A round icon: its tooltip and pressed state say what it does.
  check(
    "the code toggle is an icon, off, and says so",
    !(await toggle.textContent()).trim() &&
      /^Hide code is off/.test((await toggle.getAttribute("title")) ?? "") &&
      (await toggle.getAttribute("aria-pressed")) === "false",
  );
  await toggle.click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".jp-ClimateClaw-codeToggle button")].some(
        (b) => b.offsetWidth > 0 && b.getAttribute("aria-pressed") === "true",
      ),
    null,
    { timeout: 10_000 },
  );
  check(
    "…and, toggled, that code is hidden",
    /^Hide code is on/.test((await toggle.getAttribute("title")) ?? "") &&
      (await toggle.getAttribute("aria-pressed")) === "true",
  );
  const count = (await botMessages()).length;
  await sendChat("Again please");
  const messages = await waitForChat(
    (m) => m.length > count && m.at(-1).text.includes("the mean is 2.0"),
  );
  const reply = messages.at(-1);
  check(
    "with Hide code the reply has no code block",
    !reply.html.includes("np.mean"),
    reply.html.slice(0, 300),
  );
  const again = await waitForCell(
    (c, all) => c === all.at(-1) && c.source.includes("np.mean"),
    (c) => c.text.includes("2.0"),
  );
  check("with Hide code the code still runs into the notebook, with its output", !!again);
  await composerButton("jp-ClimateClaw-codeToggle").click();
});

await step("stop", async () => {
  await sendChat("SLOW: a long analysis");
  await waitForChat((m) => m.some((x) => x.text.includes("Working on it")));
  // jupyterlite-ai's panel here, with its own Stop.
  const stop = page.locator("button[title='Stop streaming']:visible").first();
  await stop.waitFor({ timeout: 10_000 }).catch(async () => {
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll("button[title]")]
        .map((b) => `${b.title}:${b.offsetWidth}`)
        .join(", "),
    );
    const thread = [...mock.threads.entries()].find(([, t]) =>
      t.variants.some((v) => v.content === "SLOW: a long analysis"),
    );
    throw new Error(
      `no stop button; slow=${JSON.stringify(thread?.[1].slowEnded)} stops=${JSON.stringify(mock.stops)}; log=${JSON.stringify(mock.log.slice(-8).map((r) => `${r.method} ${r.path}`))}; ${buttons}; streaming=${thread?.[1].streaming} thread=${thread?.[0]} first=${firstThread}; ` +
        `chat: ${JSON.stringify((await botMessages()).map((m) => m.text.slice(-80)).slice(-4))}`,
    );
  });
  await stop.click();
  const deadline = Date.now() + 15_000;
  while (mock.stops.length === 0 && Date.now() < deadline) await page.waitForTimeout(200);
  check(
    "stop sends POST /stop with the thread",
    mock.stops.at(-1) === firstThread,
    JSON.stringify(mock.stops),
  );
});

await step("conversations drawer", async () => {
  // An older conversation, and enough of them that the list has a second page.
  const variants = (topic) => [
    { variant: "User", content: topic },
    { variant: "Assistant", content: `About ${topic}.` },
  ];
  mock.seedThread("seed-enso", "jdoe", "ENSO analysis", variants("ENSO analysis"));
  for (let i = 0; i < 21; i += 1) {
    mock.seedThread(`seed-${i}`, "jdoe", `Old question ${i}`, variants(`Old question ${i}`));
  }
  await (await toolbarCommand("climateclaw:history")).click();
  const drawer = page.locator("#climateclaw-conversations");
  await drawer.waitFor({ state: "visible", timeout: 10_000 });
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
    "the drawer groups conversations by day, today's first",
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
    () => {
      const panel = document.getElementById("@jupyterlite/ai:chat-panel");
      return !!panel && panel.offsetWidth > 0 && panel.textContent.includes("And the maximum?");
    },
    null,
    { timeout: 20_000 },
  );
  // Messages render one by one: the replies may follow the questions.
  await page
    .waitForFunction(
      () =>
        document
          .getElementById("@jupyterlite/ai:chat-panel")
          ?.textContent?.includes("the global mean"),
      null,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  const opened = await page.evaluate(
    () => document.getElementById("@jupyterlite/ai:chat-panel").textContent,
  );
  check(
    "a conversation opens in the chat panel with its messages",
    opened.includes("the global mean"),
    opened.slice(0, 600),
  );
  check(
    "…and is marked as the current one",
    (await drawer
      .locator(".jp-ClimateClaw-conversation.jp-mod-current .jp-ClimateClaw-conversation-open")
      .getAttribute("data-thread-id")) === firstThread,
  );
});

await step("history: open beside the notebook and continue", async () => {
  const drawer = page.locator("#climateclaw-conversations");
  const row = drawer.locator(".jp-ClimateClaw-conversation", {
    has: page.locator(`[data-thread-id="${firstThread}"]`),
  });
  await row.locator(".jp-ClimateClaw-conversation-more").click();
  await page.locator(".lm-Menu-itemLabel", { hasText: "Open beside the notebook" }).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".lm-DockPanel .jp-MainAreaWidget")].some(
        (w) => w.offsetWidth > 0 && w.textContent.includes("And the maximum?"),
      ),
    null,
    { timeout: 20_000 },
  );
  const text = await page.evaluate(
    () =>
      [...document.querySelectorAll(".lm-DockPanel .jp-MainAreaWidget")].find(
        (w) => w.offsetWidth > 0 && w.textContent.includes("And the maximum?"),
      )?.textContent ?? "",
  );
  check(
    "the thread opens in a new chat with its messages",
    text.includes("the global mean") && text.includes("And the maximum?"),
    text.slice(0, 300),
  );
  await drawer.locator(".jp-ClimateClaw-conversations-close").click();
  await page.waitForTimeout(300);
  check("the drawer closes from its own button", !(await drawer.isVisible()));
  const before = api("newthread").length;
  const input = page
    .locator(".lm-DockPanel .jp-MainAreaWidget:visible")
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

await step("clear starts a new thread", async () => {
  await openChatPanel();
  const before = api("newthread").length;
  await sendChat("/clear");
  await page.waitForTimeout(500);
  await sendChat("Fresh start");
  await waitForChat((m) => m.some((x) => x.text.includes("the mean is 2.0")));
  check("after /clear a new thread is started", api("newthread").length === before + 1);
});

// Run & fix

await step("Run & fix", async () => {
  await page
    .locator(".lm-DockPanel-tabBar .lm-TabBar-tab", { hasText: "Untitled" })
    .first()
    .click();
  await setCell(page, 2, "y = 1/0\nprint(y)");
  const threadsBefore = api("newthread").length;
  await page
    .locator('.jp-NotebookPanel-toolbar [data-command="climateclaw:run-and-fix"]:visible')
    .first()
    .click();
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
  await page
    .locator('.jp-NotebookPanel-toolbar [data-command="climateclaw:run-and-fix"]:visible')
    .first()
    .click();
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
  const runButton = page
    .locator('.jp-NotebookPanel-toolbar [data-command="climateclaw:run-and-fix"]:visible')
    .first();
  // Both presses in one task, before the first can await anything (the button acts on mousedown).
  await runButton.evaluate((button) => {
    for (let i = 0; i < 2; i += 1) {
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
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
  await page
    .locator('.jp-NotebookPanel-toolbar [data-command="climateclaw:run-and-fix"]:visible')
    .first()
    .click();
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

  // "New DKRZ thread" (the notebook's context menu) forgets it.
  await page.locator(`${NOTEBOOK} .jp-Cell`).nth(2).click({ button: "right" });
  await page.locator(".lm-Menu-itemLabel", { hasText: "New DKRZ thread" }).click();
  await page
    .locator('.jp-NotebookPanel-toolbar [data-command="climateclaw:run-and-fix"]:visible')
    .first()
    .click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".jp-Notebook .jp-Cell")[2]?.textContent?.includes("ran at dkrz"),
    null,
    { timeout: 30_000 },
  );
  check("New DKRZ thread starts a new thread", api("newthread").length === threadsBefore + 2);

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
  await page
    .locator('.jp-NotebookPanel-toolbar [data-command="climateclaw:run-and-fix"]:visible')
    .first()
    .click();
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
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })),
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

  // "New DKRZ thread" while the thread is still being made: the old session's thread is not kept.
  await page.locator(`${NOTEBOOK} .jp-Cell`).nth(2).click({ button: "right" });
  await page.locator(".lm-Menu-itemLabel", { hasText: "New DKRZ thread" }).click();
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
  await page.locator(`${NOTEBOOK} .jp-Cell`).nth(2).click({ button: "right" });
  await page.locator(".lm-Menu-itemLabel", { hasText: "New DKRZ thread" }).click();
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
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".lm-DockPanel-tabBar .lm-TabBar-tab")].some((t) =>
        t.textContent.includes("sfcwind"),
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
  const tab = page.locator(".jp-FrevaData-inspector data-inspector");
  await tab.waitFor({ state: "attached", timeout: 20_000 });
  await page.waitForFunction(
    () =>
      document
        .querySelector(".jp-FrevaData-inspector data-inspector")
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
  await page.locator(".jp-FrevaData-example", { hasText: "ERA5 walkthrough" }).click();
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
    const inspector = page.locator(".jp-FrevaData-inspector data-inspector");
    await page.waitForFunction(
      () =>
        document
          .querySelector(".jp-FrevaData-inspector data-inspector")
          ?.textContent?.includes("sfcWind"),
      null,
      { timeout: 30_000 },
    );
    check(
      "…and Inspect's 3D viewer is off, even for a store anyone may read",
      (await inspector.getAttribute("viewer-disabled")) ===
        "The 3D viewer is not enabled on this site." &&
        (await inspector.locator("#nc-tab-gridlook").isDisabled()),
      await inspector.getAttribute("viewer-disabled"),
    );
    await openChatPanel();
    await Promise.all([
      other.waitForEvent("page"),
      (await toolbarCommand("climateclaw:account")).click(),
    ]);
    await page.waitForFunction(
      () => !!document.querySelector('[data-command="climateclaw:account"].jp-mod-signedIn'),
      null,
      { timeout: 30_000 },
    );
    const notebooksBefore = await page.locator(".jp-NotebookPanel").count();
    await sendChat(EXAMPLES[0].prompt);
    const messages = await waitForChat((m) => m.some((x) => /the mean is 2\.0/.test(x.text)));
    const reply = messages.find((x) => /the mean is 2\.0/.test(x.text));
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
    check(
      "with Hide code the reply has no code block",
      !last.html.includes("np.mean"),
      last.html.slice(0, 300),
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
