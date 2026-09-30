// Notices: known, environmental conditions a console can explain better than a line of stderr.
//
// The engine marks such a line (`StreamEvent.notice`); its `text` stays a complete plain-text
// message for any consumer that only reads streams. A console that knows the kind draws it as a
// card instead. No DOM here: the engine imports this too.

/** The conditions a stderr line can be marked with. */
export type NoticeKind = "needs-jspi";

export type BrowserId = "chrome" | "edge" | "opera" | "firefox" | "safari" | "other";

/**
 * The first stable version of each browser with WebAssembly JSPI (stack switching), which a
 * synchronous remote read needs. Used for ADVICE only: whether JSPI is present is detected in the
 * worker, never inferred from these.
 */
export const JSPI_MINIMUM: Readonly<Record<Exclude<BrowserId, "other">, number>> = {
  chrome: 137,
  edge: 137,
  opera: 121,
  firefox: 153,
  safari: 27,
};

export const BROWSER_NAMES: Readonly<Record<BrowserId, string>> = {
  chrome: "Chrome",
  edge: "Edge",
  opera: "Opera",
  firefox: "Firefox",
  safari: "Safari",
  other: "this browser",
};

/** Where each browser explains its own update. Vendor pages, so they stay current. */
export const UPDATE_HELP: Readonly<Partial<Record<BrowserId, string>>> = {
  chrome: "https://support.google.com/chrome/answer/95414",
  edge: "https://support.microsoft.com/en-us/topic/microsoft-edge-update-settings-af8aaca2-1b69-4870-94fe-18822dbb7ef1",
  firefox: "https://support.mozilla.org/kb/update-firefox-latest-release",
  safari: "https://support.apple.com/102665",
};

export const GET_CHROME = "https://www.google.com/chrome/";

/**
 * Every external address the no-JSPI card links to, and the only ones a framing portal will open
 * for a playground (`open-link` in the embed protocol). A fixed set, compared exactly: a frame
 * running a visitor's Python must not be able to make the portal open an address of its choosing.
 */
export const NOTICE_LINKS: ReadonlySet<string> = new Set([
  GET_CHROME,
  ...Object.values(UPDATE_HELP).filter((url): url is string => typeof url === "string"),
]);

export interface BrowserInfo {
  id: BrowserId;
  name: string;
  /** As the browser reports it, e.g. `"26.2"`; null when it cannot be read. */
  version: string | null;
  major: number | null;
  /** The first version with JSPI; null for a browser this table does not know. */
  minimum: number | null;
  /**
   * iPhone and iPad: every browser there runs on Safari's engine, so "use Chrome" would not help -
   * the fix is updating the system. Also true for an iPad that reports itself as a Mac.
   */
  apple: "ios" | "mac" | null;
}

interface NavLike {
  userAgent?: string;
  maxTouchPoints?: number;
}

/** Read the browser's name and version from its user agent. For advice, never for capability. */
export function describeBrowser(nav?: NavLike): BrowserInfo {
  const n: NavLike =
    nav ?? (typeof navigator !== "undefined" ? (navigator as unknown as NavLike) : {});
  const ua = n.userAgent ?? "";
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (n.maxTouchPoints ?? 0) > 1);
  const apple = ios ? "ios" : /Macintosh|Mac OS X/.test(ua) ? "mac" : null;

  // Order matters: Edge and Opera also say "Chrome", and Chrome also says "Safari".
  const patterns: Array<[Exclude<BrowserId, "other">, RegExp]> = [
    ["edge", /\bEdg(?:e|A|iOS)?\/(\d+(?:\.\d+)?)/],
    ["opera", /\bOPR\/(\d+(?:\.\d+)?)/],
    ["firefox", /\b(?:Firefox|FxiOS)\/(\d+(?:\.\d+)?)/],
    ["chrome", /\b(?:HeadlessChrome|Chrome|CriOS)\/(\d+(?:\.\d+)?)/],
    ["safari", /\bVersion\/(\d+(?:\.\d+)?).*\bSafari\//],
  ];
  for (const [id, pattern] of patterns) {
    const match = pattern.exec(ua);
    if (!match) continue;
    const version = match[1] ?? null;
    // On iOS the engine is Safari's whatever the app is called, so the version that matters is
    // the system's, which the app's own number says nothing about.
    const minimum = ios && id !== "safari" ? null : JSPI_MINIMUM[id];
    return {
      id,
      name: BROWSER_NAMES[id],
      version,
      major: version === null ? null : Number.parseInt(version, 10),
      minimum,
      apple,
    };
  }
  return {
    id: "other",
    name: BROWSER_NAMES.other,
    version: null,
    major: null,
    minimum: null,
    apple,
  };
}
