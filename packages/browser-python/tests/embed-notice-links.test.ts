// What the no-JSPI card needs from a portal that frames the console on another origin: the portal
// PAGE (origin and path on its own origin), so "Copy page link" names it rather than the frame;
// and a way to OPEN a link, since the frame is sandboxed without popups - only the card's fixed
// addresses, compared exactly.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserPython } from "../src/browser-python.js";
import { attachPlaygroundBridge } from "../src/embed/playground.js";
import { createPlaygroundHost } from "../src/embed/host.js";
import {
  EMBED_CHANNEL,
  EMBED_PROTOCOL_VERSION,
  OPEN_LINK_ALLOWLIST,
  portalPage,
} from "../src/embed/protocol.js";
import { GET_CHROME, NOTICE_LINKS, UPDATE_HELP } from "../src/notices.js";
import { healthyWorker } from "./fake-worker.js";
import { connectedWindows, settle, type FakeWindow } from "./embed-fixtures.js";

const PORTAL = "https://portal.test";
const PLAY = "https://play.test";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

async function setup(options: { pathname?: string } = {}) {
  const { portal, playground } = connectedWindows(PORTAL, PLAY);
  const opened: unknown[][] = [];
  Object.assign(portal, {
    location: { origin: PORTAL, pathname: options.pathname ?? "/docs/guide/" },
    open: (...args: unknown[]) => {
      opened.push(args);
      return null;
    },
  });
  const worker = healthyWorker();
  const engine = createBrowserPython({ workerFactory: () => worker as unknown as Worker });
  await engine.start();
  const pages: string[] = [];
  const bridge = attachPlaygroundBridge({
    engine,
    hostOrigin: PORTAL,
    scope: playground as unknown as Window,
    onPage: (url) => pages.push(url),
  });
  cleanups.push(() => bridge.stop());
  const frame = {
    contentWindow: playground as unknown as Window,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLIFrameElement;
  const host = createPlaygroundHost({
    frame,
    playgroundOrigin: PLAY,
    scope: portal as unknown as Window,
  });
  cleanups.push(() => host.stop());
  await settle(8);
  return { portal, playground, bridge, pages, opened };
}

describe("portalPage", () => {
  it("keeps origin and path on the portal's origin, and drops the query", () => {
    expect(portalPage(`${PORTAL}/docs/guide/?q=secret#top`, PORTAL)).toBe(`${PORTAL}/docs/guide/`);
  });

  it.each([
    ["another origin", "https://evil.test/docs/"],
    ["a script URL", "javascript:alert(1)"],
    ["not a URL", "docs/guide/"],
    ["a number", 7],
    ["an overlong string", `${PORTAL}/${"x".repeat(2100)}`],
  ])("refuses %s", (_, value) => {
    expect(portalPage(value, PORTAL)).toBeNull();
  });
});

describe("the portal page reaches the frame", () => {
  it("is named in the hail and handed to the frame's console", async () => {
    const { pages } = await setup({ pathname: "/datasets/" });
    expect(pages.at(-1)).toBe(`${PORTAL}/datasets/`);
  });

  it("is ignored when a hail names a page on another origin", async () => {
    const { playground, pages } = await setup();
    const before = pages.length;
    playground.inject(
      {
        channel: EMBED_CHANNEL,
        version: EMBED_PROTOCOL_VERSION,
        challenge: "forged",
        sessionId: "",
        kind: "hail",
        page: "https://evil.test/phish/",
      },
      { origin: PORTAL },
    );
    expect(pages.length).toBe(before);
  });
});

describe("the frame asks the portal to open a link", () => {
  it("opens the card's own addresses, from the portal, with no opener", async () => {
    const { bridge, opened } = await setup();
    expect(bridge.openLink(GET_CHROME)).toBe(true);
    await settle(4);
    expect(opened).toEqual([[GET_CHROME, "_blank", "noopener,noreferrer"]]);
  });

  it("refuses any other address in the frame, and sends nothing", async () => {
    const { bridge, portal, opened } = await setup();
    const sent = (portal as FakeWindow).received.length;
    expect(bridge.openLink("https://evil.test/")).toBe(false);
    await settle(4);
    expect((portal as FakeWindow).received.length).toBe(sent);
    expect(opened).toEqual([]);
  });

  it("refuses any other address in the portal too, even from an established session", async () => {
    const { playground, portal, opened } = await setup();
    // A frame running a visitor's Python could post anything; the portal checks for itself.
    const last = (portal as FakeWindow).received.at(-1)?.data as {
      challenge: string;
      sessionId: string;
    };
    const post = vi.spyOn(playground, "postMessage");
    (portal as FakeWindow).inject(
      {
        channel: EMBED_CHANNEL,
        version: EMBED_PROTOCOL_VERSION,
        challenge: last.challenge,
        sessionId: last.sessionId,
        kind: "open-link",
        url: "https://evil.test/",
      },
      { origin: PLAY, source: playground },
    );
    await settle(4);
    expect(opened).toEqual([]);
    // The control: the same forged envelope with one of the card's addresses IS opened, so the
    // refusal above is the allowlist and not the envelope failing some other check.
    (portal as FakeWindow).inject(
      {
        channel: EMBED_CHANNEL,
        version: EMBED_PROTOCOL_VERSION,
        challenge: last.challenge,
        sessionId: last.sessionId,
        kind: "open-link",
        url: GET_CHROME,
      },
      { origin: PLAY, source: playground },
    );
    await settle(4);
    expect(opened).toEqual([[GET_CHROME, "_blank", "noopener,noreferrer"]]);
    post.mockRestore();
  });

  it("knows exactly the card's addresses", () => {
    expect([...NOTICE_LINKS].sort()).toEqual([GET_CHROME, ...Object.values(UPDATE_HELP)].sort());
  });

  it("keeps the embed layer's copy of the list identical to the card's", () => {
    // Two copies so the embed layer imports nothing the console imports; see protocol.ts.
    expect([...OPEN_LINK_ALLOWLIST].sort()).toEqual([...NOTICE_LINKS].sort());
  });
});
