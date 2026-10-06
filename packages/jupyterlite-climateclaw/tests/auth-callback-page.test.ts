// @vitest-environment jsdom
// The callback pages that answer this package's popups: the one it ships
// (`callback/freva-login-callback.js`) and the portal's shared `/auth/callback/`
// (`@freva-org/portal-builder`, `client/auth-relay.ts`). Both must speak the relay protocol this
// package's tab half (`src/auth-relay.ts`) accepts and acknowledges; the shipped page also
// answers sign-ins an older ClimateClaw started.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RELAY_ACK,
  RELAY_CHANNEL_PREFIX,
  RELAY_KEY,
  RELAY_MESSAGE,
  RELAY_TTL_MS,
  acceptRelayMessage,
  relayAck,
} from "../src/auth-relay.js";

// Tests run from the package's directory.
const SCRIPT = readFileSync(resolve("callback/freva-login-callback.js"), "utf8");
const PAGE = "/notebook/freva-login-callback.html";
const ATTEMPT = "a".repeat(32);

let posts: Array<{ name: string; data: unknown }> = [];
let openerPosts: Array<{ data: unknown; origin: string }> = [];
let closed = 0;
/** Whether the tab answers a sign-in on its channel (it does unless partitioned away). */
let channelAnswers = true;

beforeEach(() => {
  posts = [];
  openerPosts = [];
  closed = 0;
  channelAnswers = true;
  window.sessionStorage.clear();
  document.body.innerHTML =
    '<p id="status">Finishing the Freva sign-in…</p><p><a id="home" href="./" hidden>Back</a></p>';
  vi.useFakeTimers();
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      listeners: Array<(event: { data: unknown }) => void> = [];
      constructor(readonly name: string) {}
      addEventListener(_: string, listener: (event: { data: unknown }) => void) {
        this.listeners.push(listener);
      }
      postMessage(data: unknown) {
        posts.push({ name: this.name, data });
        const message = data as { purpose?: string; attempt?: string; outcome?: string };
        if (channelAnswers && message.purpose === "login" && message.outcome === "response") {
          // The tab, another BroadcastChannel object on this name, acknowledges.
          for (const listener of this.listeners) listener({ data: relayAck(message.attempt) });
        }
      }
      close() {}
    },
  );
  vi.spyOn(window, "close").mockImplementation(() => void (closed += 1));
});
afterEach(() => {
  Object.defineProperty(window, "opener", { value: null, configurable: true, writable: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An opener that answers (the tab, framed on another site), or stays silent. */
function withOpener(answers: boolean) {
  const opener = {
    closed: false,
    postMessage: (data: unknown, origin: string) => {
      openerPosts.push({ data, origin });
      if (answers) {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: relayAck((data as { attempt?: string }).attempt),
            origin: window.location.origin,
            source: opener as unknown as Window,
          }),
        );
      }
    },
  };
  Object.defineProperty(window, "opener", { value: opener, configurable: true, writable: true });
}

function visit(path: string, wait = 500): { status: string; home: boolean; address: string } {
  window.history.replaceState(null, "", path);
  new Function(SCRIPT)();
  vi.advanceTimersByTime(wait);
  return {
    status: document.getElementById("status")!.textContent ?? "",
    home: !(document.getElementById("home") as HTMLAnchorElement).hidden,
    address: window.location.pathname + window.location.search + window.location.hash,
  };
}

function relay(purpose: "login" | "logout", expires = Date.now() + RELAY_TTL_MS) {
  window.sessionStorage.setItem(
    RELAY_KEY,
    JSON.stringify({ v: 1, attempt: ATTEMPT, purpose, expires }),
  );
}

describe("the shipped callback page", () => {
  it("hands a sign-in response to its attempt's channel, scrubbed, and closes once acknowledged", () => {
    relay("login");
    const url = `${window.location.origin}${PAGE}?code=c&state=s`;
    const page = visit(`${PAGE}?code=c&state=s`);
    expect(page.address).toBe(PAGE);
    expect(window.sessionStorage.getItem(RELAY_KEY)).toBeNull();
    expect(posts).toEqual([
      {
        name: `${RELAY_CHANNEL_PREFIX}${ATTEMPT}`,
        data: {
          type: RELAY_MESSAGE,
          v: 1,
          attempt: ATTEMPT,
          purpose: "login",
          outcome: "response",
          url,
        },
      },
    ]);
    // What the tab accepts.
    expect(acceptRelayMessage(posts[0]!.data, ATTEMPT, "login", url)?.url).toBe(url);
    expect(page.status).toBe("Signed in. You can close this window.");
    expect(closed).toBe(1);
  });

  it("unacknowledged, it says the sign-in did not arrive, and stays", () => {
    channelAnswers = false;
    relay("login");
    const page = visit(`${PAGE}?code=c&state=s`, 5000);
    expect(page.status).toMatch(/could not be handed back/);
    expect(page.home).toBe(true);
    expect(closed).toBe(0);
  });

  it("also to its opener, on this origin only; the opener's acknowledgement is enough", () => {
    channelAnswers = false;
    withOpener(true);
    relay("login");
    const page = visit(`${PAGE}?code=c&state=s`);
    expect(openerPosts).toHaveLength(1);
    expect(openerPosts[0]!.origin).toBe(window.location.origin);
    expect(page.status).toBe("Signed in. You can close this window.");
    expect(closed).toBe(1);
  });

  it("no record (a frame on another site): to the opener only, without an attempt", () => {
    withOpener(true);
    const url = `${window.location.origin}${PAGE}?code=c&state=s`;
    const page = visit(`${PAGE}?code=c&state=s`);
    expect(posts).toEqual([]);
    expect(openerPosts).toEqual([
      {
        data: { type: RELAY_MESSAGE, v: 1, purpose: "login", outcome: "response", url },
        origin: window.location.origin,
      },
    ]);
    // The tab accepts it only from the popup it opened.
    expect(acceptRelayMessage(openerPosts[0]!.data, ATTEMPT, "login", url)).toBeNull();
    expect(acceptRelayMessage(openerPosts[0]!.data, ATTEMPT, "login", url, true)?.url).toBe(url);
    expect(page.status).toBe("Signed in. You can close this window.");
  });

  it("says a cancelled sign-in plainly, and still hands it on (the tab ends its transaction)", () => {
    relay("login");
    const page = visit(`${PAGE}?error=access_denied&state=s`);
    expect(posts).toHaveLength(1);
    expect(page.status).toBe("The sign-in was cancelled.");
  });

  it("answers a sign-out without a code as a sign-out, never as a sign-in", () => {
    relay("logout");
    const page = visit(PAGE);
    expect(posts).toEqual([
      {
        name: `${RELAY_CHANNEL_PREFIX}${ATTEMPT}`,
        data: {
          type: RELAY_MESSAGE,
          v: 1,
          attempt: ATTEMPT,
          purpose: "logout",
          outcome: "response",
        },
      },
    ]);
    expect(acceptRelayMessage(posts[0]!.data, ATTEMPT, "login", PAGE)).toBeNull();
    expect(page.status).toBe("Signed out of Freva. You can close this window.");
  });

  it("an expired record: no URL handed on, the tab told to let go, the popup closed", () => {
    relay("login", Date.now() - 1);
    const page = visit(`${PAGE}?code=c&state=s`);
    expect(posts).toEqual([
      {
        name: `${RELAY_CHANNEL_PREFIX}${ATTEMPT}`,
        data: { type: RELAY_MESSAGE, v: 1, attempt: ATTEMPT, purpose: "login", outcome: "expired" },
      },
    ]);
    expect(acceptRelayMessage(posts[0]!.data, ATTEMPT, "login", PAGE)?.outcome).toBe("expired");
    expect(page.status).toMatch(/expired/);
    expect(page.address).toBe(PAGE);
    expect(closed).toBe(1);
  });

  it("a response with no record and no opener, or a reload after one, is not handed to anyone", () => {
    relay("login");
    visit(`${PAGE}?code=c&state=s`);
    posts = [];
    const again = visit(`${PAGE}?code=c&state=s`);
    expect(posts).toEqual([]);
    expect(again.status).toMatch(/^This sign-in was not started here, or it already finished\./);
    expect(again.home).toBe(true);
  });

  it("a direct visit shows a neutral message and a link, and stays open", () => {
    const page = visit(PAGE);
    expect(posts).toEqual([]);
    expect(page.status).toBe("There is no sign-in in progress here.");
    expect(page.home).toBe(true);
    expect(closed).toBe(0);
  });

  it("still answers a sign-in an older ClimateClaw started, on its channel, unchanged", () => {
    window.sessionStorage.setItem("freva-login-attempt", ATTEMPT);
    const url = `${window.location.origin}${PAGE}?code=c&state=s`;
    visit(`${PAGE}?code=c&state=s`);
    expect(posts).toEqual([
      {
        name: "freva-login-callback",
        data: { type: "freva-login-callback", url, attempt: ATTEMPT },
      },
    ]);
    expect(window.sessionStorage.getItem("freva-login-attempt")).toBeNull();
  });
});

/** The portal's shared callback, as its module exports it. */
interface PortalRelay {
  RELAY_KEY: string;
  RELAY_CHANNEL_PREFIX: string;
  RELAY_MESSAGE: string;
  RELAY_ACK: string;
  RELAY_TTL_MS: number;
  runCallback(env: unknown, options: unknown): Promise<void>;
}

const withPortalRelay = describe.skipIf(
  !existsSync(resolve("../portal-builder/client/auth-relay.ts")),
);

withPortalRelay("the portal's shared callback speaks the same protocol", () => {
  async function portal(): Promise<PortalRelay> {
    const path = resolve("../portal-builder/client/auth-relay.ts");
    return (await import(/* @vite-ignore */ path)) as PortalRelay;
  }

  it("the same keys, channel and message names", async () => {
    const shared = await portal();
    expect([
      shared.RELAY_KEY,
      shared.RELAY_CHANNEL_PREFIX,
      shared.RELAY_MESSAGE,
      shared.RELAY_ACK,
      shared.RELAY_TTL_MS,
    ]).toEqual([RELAY_KEY, RELAY_CHANNEL_PREFIX, RELAY_MESSAGE, RELAY_ACK, RELAY_TTL_MS]);
  });

  it("what it posts is what the tab accepts, and the tab's acknowledgement closes it", async () => {
    vi.useRealTimers();
    const shared = await portal();
    const callback = "http://localhost:4322/auth/callback/";
    for (const purpose of ["login", "logout"] as const) {
      const store = new Map([
        [
          RELAY_KEY,
          JSON.stringify({ v: 1, attempt: ATTEMPT, purpose, expires: Date.now() + 1000 }),
        ],
      ]);
      const sent: Array<{ name: string; data: unknown }> = [];
      let closes = 0;
      const href = purpose === "login" ? `${callback}?code=c&state=s` : callback;
      await shared.runCallback(
        {
          href,
          origin: "http://localhost:4322",
          sessionStorage: {
            getItem: (k: string) => store.get(k) ?? null,
            removeItem: (k: string) => void store.delete(k),
          },
          scrub: () => undefined,
          channel: (name: string) => {
            const listeners: Array<(event: { data: unknown }) => void> = [];
            return {
              postMessage: (data: unknown) => {
                sent.push({ name, data });
                // This package's tab: accepts, then acknowledges as it does.
                const accepted = acceptRelayMessage(data, ATTEMPT, purpose, callback);
                if (accepted && purpose === "login") {
                  for (const listener of listeners) listener({ data: relayAck(ATTEMPT) });
                }
              },
              addEventListener: (_: string, listener: (event: { data: unknown }) => void) =>
                void listeners.push(listener),
              close: () => undefined,
            };
          },
          opener: () => null,
          onOpenerMessage: () => () => undefined,
          wait: (ms: number) => new Promise((done) => setTimeout(done, Math.min(ms, 50))),
          go: () => undefined,
          close: () => void (closes += 1),
          say: () => undefined,
          now: () => Date.now(),
        },
        { basePath: "/", home: { href: "/notebook/lab/", label: "Back" } },
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]!.name).toBe(`${RELAY_CHANNEL_PREFIX}${ATTEMPT}`);
      const accepted = acceptRelayMessage(sent[0]!.data, ATTEMPT, purpose, callback);
      expect(accepted?.outcome).toBe("response");
      if (purpose === "login") expect(accepted?.url).toBe(href);
      expect(closes).toBe(1);
    }
  });
});
