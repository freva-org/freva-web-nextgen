/// <reference lib="dom" />
/**
 * The shared sign-in callback (`client/auth-relay.ts`): which flow a response belongs to, read
 * from what the starting window recorded; each record taken once; validated return paths; and
 * the callback URL from the origin and the deployment's base path.
 */
import { describe, expect, it } from "vitest";

import {
  RELAY_ACK,
  RELAY_CHANNEL_PREFIX,
  RELAY_KEY,
  RELAY_MESSAGE,
  RELAY_TTL_MS,
  RETURN_KEY,
  callbackUrl,
  deploymentPath,
  recordLogoutReturn,
  runCallback,
  type CallbackEnv,
  type CallbackOptions,
  type CallbackState,
} from "../../client/auth-relay.js";

const ATTEMPT = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;

interface Run {
  env: CallbackEnv;
  store: Map<string, string>;
  posts: Array<{ name: string; data: unknown }>;
  /** What went to the opener, and to which origin. */
  openerPosts: Array<{ data: unknown; origin: string }>;
  said: Array<{ state: CallbackState; message: string; link?: { href: string } }>;
  went: string[];
  scrubbed: string[];
  closed: number;
}

interface PageOptions {
  /** A BroadcastChannel exists (default), and the tab answers on it (default). */
  channels?: boolean;
  channelAnswers?: boolean;
  /** The opener: answers, stays silent, or is gone (default). */
  opener?: "answers" | "silent" | null;
}

function page(href: string, records: Record<string, unknown> = {}, options: PageOptions = {}): Run {
  const { channels = true, channelAnswers = true, opener = null } = options;
  const url = new URL(href);
  const ack = (data: unknown) => ({
    type: RELAY_ACK,
    v: 1,
    attempt: (data as { attempt?: string }).attempt,
  });
  const fromOpener: Array<(data: unknown) => void> = [];
  const store = new Map(Object.entries(records).map(([k, v]) => [k, JSON.stringify(v)]));
  const run: Run = {
    store,
    posts: [],
    openerPosts: [],
    said: [],
    went: [],
    scrubbed: [],
    closed: 0,
    env: undefined as unknown as CallbackEnv,
  };
  run.env = {
    href,
    origin: url.origin,
    sessionStorage: {
      getItem: (k) => store.get(k) ?? null,
      removeItem: (k) => void store.delete(k),
    },
    scrub: (path) => void run.scrubbed.push(path),
    channel: (name) => {
      if (!channels) return null;
      const listeners: Array<(event: { data: unknown }) => void> = [];
      return {
        postMessage: (data) => {
          run.posts.push({ name, data });
          // The tab listening on this attempt answers (it never answers a sign-out).
          if (channelAnswers && (data as { purpose?: string }).purpose === "login") {
            for (const listener of listeners) listener({ data: ack(data) });
          }
        },
        addEventListener: (_type, listener) => void listeners.push(listener),
        close: () => {},
      };
    },
    opener: () =>
      opener
        ? {
            postMessage: (data, origin) => {
              run.openerPosts.push({ data, origin });
              if (opener === "answers") for (const listener of fromOpener) listener(ack(data));
            },
          }
        : null,
    onOpenerMessage: (listener) => {
      fromOpener.push(listener);
      return () => void fromOpener.splice(fromOpener.indexOf(listener), 1);
    },
    wait: () => new Promise((resolve) => setTimeout(resolve, 0)),
    go: (path) => void run.went.push(path),
    close: () => void (run.closed += 1),
    say: (state, message, link) =>
      void run.said.push({ state, message, ...(link ? { link } : {}) }),
    now: () => NOW,
  };
  return run;
}

const relay = (purpose: "login" | "logout", expires = NOW + RELAY_TTL_MS) => ({
  [RELAY_KEY]: { v: 1, attempt: ATTEMPT, purpose, expires },
});
const portal = (sameTab?: CallbackOptions["sameTab"], basePath = "/"): CallbackOptions => ({
  basePath,
  home: { href: basePath, label: "Back to the portal" },
  ...(sameTab ? { sameTab } : {}),
});
const last = (run: Run) => run.said.at(-1)!;

describe("callbackUrl: the origin, the deployment's base path, the callback path", () => {
  it.each([
    ["http://localhost:4321", "/", "/auth/callback/", "http://localhost:4321/auth/callback/"],
    ["https://example.org", "/", "/auth/callback/", "https://example.org/auth/callback/"],
    [
      "https://example.org",
      "/showroom/",
      "/auth/callback/",
      "https://example.org/showroom/auth/callback/",
    ],
    [
      "http://127.0.0.1:8080",
      "/showroom/",
      "auth/callback/",
      "http://127.0.0.1:8080/showroom/auth/callback/",
    ],
    ["http://localhost:4322", "/", "/sso/return/", "http://localhost:4322/sso/return/"],
  ])("%s + %s + %s", (origin, base, path, expected) => {
    expect(callbackUrl(origin, base, path)).toBe(expected);
  });
});

describe("a popup's response goes to the tab that opened it", () => {
  it("sign-in: scrubbed first, posted on the attempt's channel, the record taken, closed", async () => {
    const href = "http://localhost:4322/auth/callback/?code=c&state=s&iss=x";
    const run = page(href, relay("login"));
    await runCallback(run.env, portal());
    expect(run.scrubbed).toEqual(["/auth/callback/"]);
    expect(run.posts).toEqual([
      {
        name: `${RELAY_CHANNEL_PREFIX}${ATTEMPT}`,
        data: {
          type: RELAY_MESSAGE,
          v: 1,
          attempt: ATTEMPT,
          purpose: "login",
          outcome: "response",
          url: href,
        },
      },
    ]);
    expect(run.store.has(RELAY_KEY)).toBe(false);
    expect(last(run)).toEqual({ state: "done", message: "Signed in." });
    expect(run.closed).toBe(1);
    expect(run.went).toEqual([]);
  });

  it("never exchanges the code itself, even where a same-tab handler exists", async () => {
    let exchanged = 0;
    const run = page("https://example.org/auth/callback/?code=c&state=s", relay("login"));
    await runCallback(
      run.env,
      portal(async () => {
        exchanged += 1;
        return "/";
      }),
    );
    expect(exchanged).toBe(0);
    expect(run.posts).toHaveLength(1);
  });

  it("sign-out: a response without a code is a sign-out, with no URL handed on", async () => {
    const run = page("https://example.org/auth/callback/", relay("logout"));
    await runCallback(run.env, portal());
    expect(run.posts[0]!.data).toEqual({
      type: RELAY_MESSAGE,
      v: 1,
      attempt: ATTEMPT,
      purpose: "logout",
      outcome: "response",
    });
    expect(last(run).message).toBe("Signed out of Freva. You can close this window.");
    expect(run.closed).toBe(1);
  });

  it("cancelled and refused sign-ins are handed on (the tab ends its transaction) and said", async () => {
    for (const [query, message] of [
      ["error=access_denied&state=s", "The sign-in was cancelled."],
      ["error=login_required&state=s", "Freva needs you to sign in again."],
      [
        "error=invalid_scope&error_description=%3Cb%3Ex%3C%2Fb%3E&state=s",
        "Freva did not accept the sign-in (invalid_scope).",
      ],
    ] as const) {
      const run = page(`https://example.org/auth/callback/?${query}`, relay("login"));
      await runCallback(run.env, portal());
      expect(run.posts).toHaveLength(1);
      expect(last(run)).toEqual({ state: "error", message });
    }
  });

  it("an expired record: no URL handed on, the tab told to let go of the attempt, closed", async () => {
    const run = page("https://example.org/auth/callback/?code=c&state=s", relay("login", NOW - 1), {
      opener: "silent",
    });
    await runCallback(run.env, portal());
    const told = {
      type: RELAY_MESSAGE,
      v: 1,
      attempt: ATTEMPT,
      purpose: "login",
      outcome: "expired",
    };
    expect(run.posts).toEqual([{ name: `${RELAY_CHANNEL_PREFIX}${ATTEMPT}`, data: told }]);
    expect(run.openerPosts).toEqual([{ data: told, origin: "https://example.org" }]);
    expect(last(run).state).toBe("error");
    expect(last(run).message).toMatch(/expired/);
    expect(last(run).link?.href).toBe("/");
    expect(run.closed).toBe(1);
    expect(run.store.has(RELAY_KEY)).toBe(false);
  });

  it("a sign-in popup that came back without a response tells its tab it is over", async () => {
    const run = page("https://example.org/auth/callback/", relay("login"));
    await runCallback(run.env, portal());
    expect(run.posts[0]!.data).toMatchObject({ outcome: "expired" });
    expect(run.posts[0]!.data).not.toHaveProperty("url");
  });

  it("taken once: a reload of the popup finds no record and hands nothing on", async () => {
    const href = "https://example.org/auth/callback/?code=c&state=s";
    const run = page(href, relay("login"));
    await runCallback(run.env, portal());
    run.posts.length = 0;
    await runCallback(run.env, portal());
    expect(run.posts).toEqual([]);
    expect(last(run).message).toMatch(
      /^This sign-in was not started here, or it already finished\./,
    );
  });

  it("a malformed record is no record", async () => {
    for (const bad of [
      { v: 1, attempt: "nope", purpose: "login", expires: NOW + 1 },
      { v: 2, attempt: ATTEMPT, purpose: "login", expires: NOW + 1 },
      { v: 1, attempt: ATTEMPT, purpose: "admin", expires: NOW + 1 },
      { v: 1, attempt: ATTEMPT, purpose: "login" },
    ]) {
      const run = page("https://example.org/auth/callback/?code=c&state=s", { [RELAY_KEY]: bad });
      await runCallback(run.env, portal());
      expect(run.posts).toEqual([]);
    }
  });

  it("no channel in this browser and no opener: says so, stays open", async () => {
    const run = page("https://example.org/auth/callback/?code=c&state=s", relay("login"), {
      channels: false,
    });
    await runCallback(run.env, portal());
    expect(last(run).state).toBe("error");
    expect(last(run).message).toMatch(/could not be handed back/);
    expect(run.closed).toBe(0);
  });

  it("a response nobody acknowledges is not reported as a sign-in: the popup says so and stays", async () => {
    const run = page("https://example.org/auth/callback/?code=c&state=s", relay("login"), {
      channelAnswers: false,
      opener: "silent",
    });
    await runCallback(run.env, portal());
    expect(run.posts).toHaveLength(1);
    expect(last(run)).toMatchObject({ state: "error", link: { href: "/" } });
    expect(last(run).message).toMatch(/open it in its own tab/);
    expect(run.closed).toBe(0);
  });

  it("the opener's acknowledgement is enough (the channel partitioned away)", async () => {
    const href = "https://example.org/auth/callback/?code=c&state=s";
    const run = page(href, relay("login"), { channelAnswers: false, opener: "answers" });
    await runCallback(run.env, portal());
    expect(run.openerPosts[0]).toEqual({
      data: {
        type: RELAY_MESSAGE,
        v: 1,
        attempt: ATTEMPT,
        purpose: "login",
        outcome: "response",
        url: href,
      },
      origin: "https://example.org",
    });
    expect(last(run)).toEqual({ state: "done", message: "Signed in." });
    expect(run.closed).toBe(1);
  });

  it("a framed notebook on another site: no record reaches the popup, its opener takes the response", async () => {
    const href = "https://play.example.org/auth/callback/?code=c&state=s";
    const run = page(href, {}, { opener: "answers" });
    await runCallback(run.env, portal());
    // To the opener only, on this origin, without an attempt (the opener checks it is its popup).
    expect(run.posts).toEqual([]);
    expect(run.openerPosts).toEqual([
      {
        data: { type: RELAY_MESSAGE, v: 1, purpose: "login", outcome: "response", url: href },
        origin: "https://play.example.org",
      },
    ]);
    expect(last(run)).toEqual({ state: "done", message: "Signed in." });
    expect(run.closed).toBe(1);
    // An opener that does not answer: the page says so and stays.
    const silent = page(href, {}, { opener: "silent" });
    await runCallback(silent.env, portal());
    expect(last(silent).message).toMatch(/open it in its own tab/);
    expect(silent.closed).toBe(0);
  });
});

describe("the portal's same-tab sign-in", () => {
  it("exchanges here and returns to the validated page it started on", async () => {
    const seen: string[] = [];
    const href = "https://example.org/showroom/auth/callback/?code=c&state=s";
    const run = page(href);
    await runCallback(
      run.env,
      portal(async (h) => {
        seen.push(h);
        return "/showroom/data/?q=tas#top";
      }, "/showroom/"),
    );
    expect(seen).toEqual([href]);
    expect(run.scrubbed).toEqual(["/showroom/auth/callback/"]);
    expect(run.went).toEqual(["/showroom/data/?q=tas#top"]);
  });

  it("falls back to the deployment's home for no or an invalid return path", async () => {
    for (const next of [
      null,
      "https://evil.example.org/",
      "//evil.example.org/",
      "/elsewhere/",
      "/showroom\\..\\x",
      "javascript:alert(1)",
    ]) {
      const run = page("https://example.org/showroom/auth/callback/?code=c&state=s");
      await runCallback(
        run.env,
        portal(async () => next, "/showroom/"),
      );
      expect(run.went).toEqual(["/showroom/"]);
    }
  });

  it("a transaction this tab does not hold (expired, finished, another tab's) is said, not exchanged", async () => {
    const run = page("https://example.org/auth/callback/?code=c&state=s");
    await runCallback(
      run.env,
      portal(async () => {
        const error = new Error("no login transaction");
        error.name = "LoginTransactionError";
        throw error;
      }),
    );
    expect(run.went).toEqual([]);
    expect(last(run)).toEqual({
      state: "error",
      message:
        "This sign-in expired, finished already, or was started in another tab. Start it again.",
      link: { href: "/", label: "Back to the portal" },
    });
  });

  it("a cancelled same-tab sign-in says it was cancelled", async () => {
    const run = page("https://example.org/auth/callback/?error=access_denied&state=s");
    await runCallback(
      run.env,
      portal(async () => {
        throw new Error("provider-error");
      }),
    );
    expect(last(run).message).toBe("The sign-in was cancelled.");
  });

  it("without a same-tab sign-in (the notebook origin), a response nobody recorded is refused", async () => {
    const run = page("http://localhost:4322/auth/callback/?code=c&state=s");
    await runCallback(run.env, portal());
    expect(run.posts).toEqual([]);
    expect(run.went).toEqual([]);
    expect(last(run).message).toMatch(
      /^This sign-in was not started here, or it already finished\./,
    );
  });
});

describe("sign-out in the same tab, and direct visits", () => {
  it("returns to where the sign-out started, validated", async () => {
    const store = new Map<string, string>();
    recordLogoutReturn({ setItem: (k, v) => void store.set(k, v) }, "/showroom/data/", NOW);
    const run = page("https://example.org/showroom/auth/callback/", {
      [RETURN_KEY]: JSON.parse(store.get(RETURN_KEY)!),
    });
    await runCallback(run.env, portal(undefined, "/showroom/"));
    expect(run.went).toEqual(["/showroom/data/"]);
    expect(run.store.has(RETURN_KEY)).toBe(false);
  });

  it("a return outside the deployment goes home instead", async () => {
    const run = page("https://example.org/showroom/auth/callback/", {
      [RETURN_KEY]: { v: 1, returnTo: "/other/", expires: NOW + 1 },
    });
    await runCallback(run.env, portal(undefined, "/showroom/"));
    expect(run.went).toEqual(["/showroom/"]);
  });

  it("a direct visit: a neutral message and a link home, nothing posted, nothing closed", async () => {
    const run = page("https://example.org/auth/callback/");
    await runCallback(run.env, portal());
    expect(last(run)).toEqual({
      state: "idle",
      message: "There is no sign-in in progress here.",
      link: { href: "/", label: "Back to the portal" },
    });
    expect(run.posts).toEqual([]);
    expect(run.went).toEqual([]);
    expect(run.closed).toBe(0);
  });
});

describe("deploymentPath", () => {
  it("keeps same-origin paths under the base path, with their query and fragment", () => {
    expect(deploymentPath("/", "/", "https://example.org")).toBe("/");
    expect(deploymentPath("/showroom", "/showroom/", "https://example.org")).toBe("/showroom");
    expect(deploymentPath("/showroom/a/?b=1#c", "/showroom/", "https://example.org")).toBe(
      "/showroom/a/?b=1#c",
    );
    expect(deploymentPath("/showroomx/", "/showroom/", "https://example.org")).toBeNull();
    expect(deploymentPath("/a\u0000b", "/", "https://example.org")).toBeNull();
    expect(deploymentPath(42, "/", "https://example.org")).toBeNull();
  });
});
