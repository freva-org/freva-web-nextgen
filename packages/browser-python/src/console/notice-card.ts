// The card a console draws for a marked stderr line (`StreamEvent.notice`), built with
// `createElement` and `textContent` only. One kind: a remote read in a browser without WebAssembly
// JSPI, explained as the visitor's own browser, how far it is from one that works, and the quickest
// way out - for most people a browser they already have.

import {
  BROWSER_NAMES,
  GET_CHROME,
  JSPI_MINIMUM,
  UPDATE_HELP,
  describeBrowser,
  type BrowserInfo,
} from "../notices.js";
import type { ConsoleNoticeOutput } from "./console-types.js";

export interface NoticeCardOptions {
  document: Document;
  /** The browser to advise about. Defaults to reading the user agent. */
  browser?: BrowserInfo;
  /**
   * The page a visitor should reopen elsewhere, read when a control is used. Defaults to this
   * document's own address, which is wrong when the console is framed on another origin: a host
   * that frames it supplies the page the visitor is actually on.
   */
  pageUrl?: () => string | null;
  /**
   * How to open an external link, when this document cannot: a sandboxed frame without
   * `allow-popups` loses a `target=_blank` click silently. Read when a link is used.
   */
  openExternal?: () => ((url: string) => void) | null;
}

/** How far along the track a version sits: the last ten versions before the minimum. */
export function trackPosition(major: number, minimum: number): number {
  const start = minimum - 10;
  return Math.max(0.06, Math.min(0.94, (major - start) / (minimum - start)));
}

/** The note a visitor can paste to whoever manages their machine. */
export function supportNote(browser: BrowserInfo, pageUrl: string): string {
  const current = browser.version ? `${browser.name} ${browser.version}` : "this browser";
  const target =
    browser.apple === "ios"
      ? "iOS/iPadOS 27 (Safari 27) or later"
      : browser.minimum !== null
        ? `${browser.name} ${browser.minimum} or later`
        : "a current Chrome, Edge, Firefox or Safari";
  return (
    `The Python examples on ${pageUrl} need WebAssembly JSPI (stack switching) to read remote ` +
    `datasets, which ${current} does not provide. Please update to ${target}` +
    (browser.apple === "ios" ? "." : `, or install Chrome ${JSPI_MINIMUM.chrome} or later.`)
  );
}

export function renderNeedsJspi(
  output: ConsoleNoticeOutput,
  options: NoticeCardOptions,
): HTMLElement {
  const doc = options.document;
  const browser = options.browser ?? describeBrowser();
  const hint = output.origin === "hint";
  const pageUrl = (): string => options.pageUrl?.() || doc.defaultView?.location.href || "";
  /** A framed console may be sandboxed without popups, where a `_blank` link does nothing. */
  const framed = ((): boolean => {
    try {
      return doc.defaultView !== null && doc.defaultView !== doc.defaultView.top;
    } catch {
      return true;
    }
  })();

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  /**
   * Show `text` as a selected, read-only field at the end of `route`: what a visitor copies by hand
   * when the clipboard refused, or opens by hand when a link could not open. One per route,
   * replaced rather than stacked.
   */
  const reveal = (route: HTMLElement, label: string, text: string): void => {
    route.querySelector(".bp-notice-reveal")?.remove();
    const box = el("div", "bp-notice-reveal");
    const caption = el("span", "bp-notice-reveal-label", label);
    const field = text.includes("\n") || text.length > 120 ? el("textarea") : el("input");
    field.className = "bp-notice-reveal-field";
    field.readOnly = true;
    field.value = text;
    field.setAttribute("aria-label", label);
    if (field instanceof HTMLTextAreaElement) field.rows = 3;
    field.addEventListener("focus", () => field.select());
    box.append(caption, field);
    route.append(box);
    field.focus();
    field.select();
  };
  const link = (
    route: HTMLElement,
    href: string,
    text: string,
    className = "bp-notice-link",
  ): HTMLAnchorElement => {
    const a = el("a", className, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.addEventListener("click", (event) => {
      const open = options.openExternal?.();
      if (open) {
        // The host opens it from its own document. Whether a popup blocker let it is not
        // something this frame can see, so the address is offered too.
        event.preventDefault();
        open(href);
        reveal(route, "If nothing opened, copy this address:", href);
        return;
      }
      if (!framed) return; // an ordinary page: the link does what links do
      event.preventDefault();
      const opened = doc.defaultView?.open(href, "_blank");
      if (opened) {
        try {
          opened.opener = null;
        } catch {
          // cross-origin already; nothing to sever
        }
      } else {
        reveal(route, "This frame cannot open new tabs. Copy the address:", href);
      }
    });
    return a;
  };
  const copyButton = (
    route: HTMLElement,
    label: string,
    text: () => string,
    primary = false,
  ): HTMLButtonElement => {
    const button = el(
      "button",
      primary ? "bp-notice-btn bp-notice-primary" : "bp-notice-btn",
      label,
    );
    button.type = "button";
    button.addEventListener("click", () => {
      const value = text();
      const done = (ok: boolean) => {
        button.textContent = ok ? "Copied ✓" : "Copy failed - select it below";
        if (ok) route.querySelector(".bp-notice-reveal")?.remove();
        else reveal(route, "Select and copy:", value);
        doc.defaultView?.setTimeout(() => (button.textContent = label), 1800);
      };
      const clipboard = doc.defaultView?.navigator.clipboard;
      if (!clipboard) return done(false);
      clipboard.writeText(value).then(
        () => done(true),
        () => done(false),
      );
    });
    return button;
  };

  const ios = browser.apple === "ios";
  const known = browser.major !== null && browser.minimum !== null;
  const behind = known && browser.major! < browser.minimum!;
  const current = browser.version ? `${browser.name} ${browser.version}` : BROWSER_NAMES.other;
  const chromium = browser.id === "chrome" || browser.id === "edge" || browser.id === "opera";

  const card = el("section", "bp-notice");
  card.dataset.notice = output.notice;
  card.dataset.origin = output.origin;
  card.setAttribute("role", hint ? "note" : "alert");

  // head
  const head = el("div", "bp-notice-head");
  const icon = el("span", "bp-notice-icon", "↻");
  icon.setAttribute("aria-hidden", "true");
  const titles = el("div", "bp-notice-titles");
  const title = hint
    ? "Heads-up: opening datasets from a URL needs a newer browser"
    : behind || ios
      ? "One browser update away from remote data"
      : "This browser can't open remote datasets";
  titles.append(el("h4", "bp-notice-title", title));
  titles.append(
    el(
      "p",
      "bp-notice-sub",
      hint
        ? "Everything else works right now. Remote reads (S3, Zarr, HTTP) will need an update."
        : `Your code is fine. ${current} can't fetch datasets from the internet for Python yet.`,
    ),
  );
  head.append(icon, titles);
  const body = el("div", "bp-notice-body");
  let toggle: HTMLButtonElement | null = null;
  if (hint) {
    toggle = el("button", "bp-notice-btn bp-notice-toggle", "Show how");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    head.append(toggle);
  }
  card.append(head);

  // where you are: the track, or the plain advice when there is nothing to measure
  const where = el("div", "bp-notice-where");
  where.append(el("div", "bp-notice-label", "Your browser"));
  if (behind && !ios) {
    const track = el("div", "bp-notice-track");
    const position = trackPosition(browser.major!, browser.minimum!);
    track.style.setProperty("--bp-notice-at", `${(position * 100).toFixed(1)}%`);
    track.setAttribute("role", "img");
    track.setAttribute(
      "aria-label",
      `${current} installed; ${browser.name} ${browser.minimum} or later needed`,
    );
    track.append(
      el("span", "bp-notice-fill"),
      el("span", "bp-notice-pin"),
      el("span", "bp-notice-goal"),
      el("span", "bp-notice-you", `you: ${current}`),
      el("span", "bp-notice-need", `${browser.name} ${browser.minimum} ✓`),
    );
    where.append(track);
    where.append(
      el(
        "p",
        "bp-notice-hint",
        chromium
          ? `${browser.name} updates itself: open its menu, then About ${browser.name}, and relaunch. Then reload this page.`
          : `Update ${browser.name} to ${browser.minimum} or later, then reload this page.`,
      ),
    );
  } else if (ios) {
    where.append(
      el(
        "p",
        "bp-notice-hint",
        `On iPhone and iPad every browser uses Safari's engine, so the fix is the system: update to iOS/iPadOS 27 or later (Settings, General, Software Update), then reload this page.`,
      ),
    );
  } else if (known) {
    // New enough on paper and still without JSPI: a policy, a flag, or an unusual build.
    where.append(
      el(
        "p",
        "bp-notice-hint",
        `${current} should support it, so it may be turned off by a setting or by your organisation. Opening this page in Chrome is the quickest way round it.`,
      ),
    );
  } else {
    where.append(
      el(
        "p",
        "bp-notice-hint",
        "Use a current browser: Safari 27, Chrome or Edge 137, Firefox 153, Opera 121, or later.",
      ),
    );
  }

  // what still works, right now
  const works = el("div", "bp-notice-works");
  works.append(el("div", "bp-notice-label", "In this browser, right now"));
  const list = el("ul", "bp-notice-checks");
  for (const [ok, text] of [
    [true, "Python, NumPy, pandas"],
    [true, "xarray on data you create or upload"],
    [true, "Files in /workspace, plots"],
    [false, "Opening datasets from a URL (S3, Zarr, HTTP)"],
  ] as const) {
    const item = el("li", ok ? "bp-notice-ok" : "bp-notice-no");
    const mark = el("span", "bp-notice-mark", ok ? "✓" : "✕");
    mark.setAttribute("aria-label", ok ? "works" : "does not work");
    item.append(mark, doc.createTextNode(text));
    list.append(item);
  }
  works.append(list);
  body.append(el("div", "bp-notice-grid"));
  body.firstElementChild!.append(where, works);

  // the ways out. Chrome first where it helps: most people already have it, and switching is a
  // copy and a paste, not an update and a relaunch.
  const routes = el("div", "bp-notice-routes");
  if (!ios && browser.id !== "chrome") {
    const fast = el("div", "bp-notice-route bp-notice-route-fast");
    fast.append(el("div", "bp-notice-badge", "Fastest"));
    fast.append(el("div", "bp-notice-route-title", "Have Chrome? Skip the update"));
    fast.append(
      el(
        "p",
        "bp-notice-route-text",
        "Open this page in Chrome and run it there. Nothing to install if you already have it.",
      ),
    );
    const row = el("div", "bp-notice-row");
    row.append(copyButton(fast, "Copy page link", pageUrl, true));
    row.append(link(fast, GET_CHROME, "Get Chrome ↗"));
    fast.append(row);
    routes.append(fast);
  }
  const help = ios ? UPDATE_HELP.safari : UPDATE_HELP[browser.id];
  const keep = el("div", "bp-notice-route");
  keep.append(
    el(
      "div",
      "bp-notice-route-title",
      ios
        ? "Update iOS/iPadOS"
        : browser.minimum !== null
          ? routes.childElementCount > 0
            ? `Keep ${browser.name}: update to ${browser.minimum}+`
            : `Update ${browser.name} to ${browser.minimum}+`
          : "Update this browser",
    ),
  );
  keep.append(
    el(
      "p",
      "bp-notice-route-text",
      "Your code stays where it is: reload this page after updating and run it again.",
    ),
  );
  const keepRow = el("div", "bp-notice-row");
  if (help)
    keepRow.append(
      link(
        keep,
        help,
        `How to update ${ios ? "iPhone and iPad" : browser.name} ↗`,
        "bp-notice-btn",
      ),
    );
  keepRow.append(
    copyButton(keep, "Copy note for IT support", () => supportNote(browser, pageUrl())),
  );
  keep.append(keepRow);
  routes.append(keep);
  body.append(routes);

  // for the curious: what it is, and the plain message a script would have seen
  const details = el("details", "bp-notice-details");
  details.append(el("summary", undefined, "Technical details"));
  details.append(
    el(
      "p",
      undefined,
      "A synchronous read of remote data (xarray opening a Zarr store, fsspec reading HTTP or S3) " +
        "has to pause Python while the browser fetches. That pause is WebAssembly JSPI " +
        "(stack switching), which this browser does not provide.",
    ),
  );
  if (output.text) details.append(el("pre", "bp-notice-plain", output.text.trimEnd()));
  body.append(details);

  card.append(body);
  // The card's keys are its own. The terminal's handlers read every key that bubbles out (Tab
  // completes, Enter submits, letters go to the prompt), so events from these controls stop here -
  // propagation only, never the default: Tab still moves focus, Enter and Space still press. Paste
  // and input too: a paste into a read-only copy field still fires and would become a command.
  for (const type of ["keydown", "keypress", "keyup", "paste", "input"] as const) {
    card.addEventListener(type, (event) => event.stopPropagation());
  }
  if (toggle) {
    body.hidden = true;
    toggle.addEventListener("click", () => {
      body.hidden = !body.hidden;
      toggle.textContent = body.hidden ? "Show how" : "Hide";
      toggle.setAttribute("aria-expanded", String(!body.hidden));
    });
  }
  return card;
}
