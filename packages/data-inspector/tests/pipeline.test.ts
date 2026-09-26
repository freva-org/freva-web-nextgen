import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { attachInspector, convertOptions, looksLikeStore } from "../src/pipeline";
import { scopedBearerAuth } from "../src/internal/http";
import { DataInspectorElement } from "../src/elements/data-inspector";
import { AggregationConfigElement } from "../src/elements/aggregation-config";

beforeAll(() => {
  if (!customElements.get("data-inspector")) {
    customElements.define("data-inspector", DataInspectorElement);
  }
  if (!customElements.get("aggregation-config")) {
    customElements.define("aggregation-config", AggregationConfigElement);
  }
});

const HERE = location.origin;
const PORTAL = "/api/freva-nextgen/data-portal";
const STORE = `${HERE}/api/freva-nextgen/data-portal/zarr/tok123.zarr`;
const SHARE = `${HERE}/api/freva-nextgen/data-portal/share/sig/tok123.zarr`;
const FOREIGN = "https://object-store.example.org/bucket/a.zarr";

/** A minimal consolidated v2 store. */
const ZMETA = {
  metadata: {
    ".zgroup": { zarr_format: 2 },
    "tas/.zarray": { shape: [2], chunks: [2], dtype: "<f4" },
    "tas/.zattrs": { _ARRAY_DIMENSIONS: ["time"] },
  },
};

interface Call {
  url: string;
  method: string;
  auth?: string;
  body?: unknown;
}

/**
 * A scripted freva-rest: convert / share / status / store reads. `stores` are the URLs that answer
 * as zarr (their `.zmetadata`); `statuses` is the status sequence (the last one repeats).
 */
function backend(
  opts: {
    stores?: string[];
    statuses?: Array<{ status: number; reason?: string }>;
    refuse?: number; // HTTP status store reads answer with (e.g. 401), instead of zarr
    refuseFor?: string[]; // ...only for these stores (default: every store)
    share?: number; // HTTP status of /share-zarr (default 201)
    convert?: number; // HTTP status of /zarr/convert (default 200)
    convertDetail?: string;
  } = {},
) {
  const calls: Call[] = [];
  const statuses = [...(opts.statuses ?? [{ status: 0 }])];
  const stores = opts.stores ?? [STORE, SHARE];
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), HERE).href;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      auth: headers.Authorization ?? headers.authorization,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith("/zarr/convert"))
      return opts.convert && opts.convert !== 200
        ? json(opts.convert, { detail: opts.convertDetail ?? "nope" })
        : json(200, { urls: [STORE] });
    if (url.endsWith("/share-zarr"))
      return opts.share && opts.share !== 201
        ? json(opts.share, { detail: "down" })
        : json(201, { url: SHARE });
    if (url.includes("/zarr-utils/status"))
      return json(200, statuses.length > 1 ? statuses.shift() : statuses[0]);
    const storeRead = url.endsWith("/.zmetadata") || url.endsWith("/zarr.json");
    const refused = !opts.refuseFor || opts.refuseFor.some((b) => url.startsWith(`${b}/`));
    if (opts.refuse && storeRead && refused) return new Response("", { status: opts.refuse });
    if (url.endsWith("/.zmetadata")) {
      const base = url.slice(0, -"/.zmetadata".length);
      return stores.includes(base) ? json(200, ZMETA) : new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  });
  return calls;
}

function dialog(): HTMLElement & { output?: string | null; error?: string | null } {
  const el = document.createElement("div") as HTMLElement & {
    output?: string | null;
    error?: string | null;
  };
  document.body.append(el);
  return el;
}

/** The real element, open, as a host would show it. */
function realDialog(): DataInspectorElement {
  const el = document.createElement("data-inspector") as DataInspectorElement;
  document.body.append(el);
  return el;
}

const signedIn = scopedBearerAuth({ getToken: () => "tok" });
const signedOut = scopedBearerAuth({ getToken: () => null });

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("helpers", () => {
  it("looksLikeStore: http(s) links and .zarr paths only", () => {
    expect(looksLikeStore("https://x/a.zarr")).toBe(true);
    expect(looksLikeStore("/d/a.zarr/")).toBe(true);
    expect(looksLikeStore("/arch/x.nc")).toBe(false);
  });

  it("convertOptions drops empty values and takes the timeout client-side", () => {
    expect(
      convertOptions({ aggregate: "concat", dim: "", join: null, reload: false, timeout: 60 }),
    ).toEqual({ options: { aggregate: "concat" }, timeoutS: 60 });
  });
});

describe("route 1: a store read directly", () => {
  it("a public store needs no sign-in, no server and no share link", async () => {
    const calls = backend({ stores: [FOREIGN] });
    const el = dialog();
    await attachInspector(el, { getAuthHeaders: signedIn }).load(FOREIGN);
    expect(el.getAttribute("status")).toBe("ready");
    expect(el.output).toMatch(/xarray\.Dataset/);
    expect(el.getAttribute("zarr-url")).toBe(FOREIGN);
    expect(el.getAttribute("file")).toBe(FOREIGN); // the path bar shows what was read
    expect(calls.every((c) => !c.auth)).toBe(true); // never the token to another host
    expect(calls.some((c) => c.url.endsWith("/share-zarr"))).toBe(false);
  });

  it("a protected store gets a share link before the viewer", async () => {
    const calls = backend();
    const el = dialog();
    await attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: signedIn }).load(STORE);
    expect(el.getAttribute("status")).toBe("ready");
    expect(el.getAttribute("zarr-url")).toBe(SHARE);
    expect(el.getAttribute("viewer-disabled")).toBeNull();
    expect(calls.find((c) => c.url.endsWith("/.zmetadata"))?.auth).toBe("Bearer tok");
    expect(calls.find((c) => c.url.endsWith("/share-zarr"))?.body).toEqual({
      path: STORE,
      ttl_seconds: 3600,
    });
  });

  it("no share link: the metadata stays, the viewer is disabled with the reason", async () => {
    backend({ share: 503 });
    const el = dialog();
    await attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: signedIn }).load(STORE);
    expect(el.getAttribute("status")).toBe("ready");
    expect(el.output).toMatch(/xarray\.Dataset/);
    expect(el.getAttribute("viewer-disabled")).toMatch(/share link.*503/);
  });
});

describe("route 2: the data-loader", () => {
  it("converts, shares, polls and reads - every request with the token", async () => {
    const calls = backend({ statuses: [{ status: 4 }, { status: 0 }] });
    const el = dialog();
    await attachInspector(el, {
      dataPortalBase: PORTAL,
      getAuthHeaders: signedIn,
      pollMs: 1,
    }).load("/arch/b.nc");
    expect(el.getAttribute("status")).toBe("ready");
    expect(el.output).toMatch(/xarray\.Dataset/);
    expect(el.getAttribute("zarr-url")).toBe(SHARE);
    expect(calls.find((c) => c.url.endsWith("/zarr/convert"))?.body).toEqual({
      path: "/arch/b.nc",
    });
    const portalCalls = calls.filter((c) => c.url.includes("/data-portal/"));
    expect(portalCalls.every((c) => c.auth === "Bearer tok")).toBe(true);
    expect(calls.filter((c) => c.url.includes("/zarr-utils/status"))).toHaveLength(2);
    expect(calls.some((c) => c.url.endsWith(`/.zmetadata`) && c.url.startsWith(STORE))).toBe(true);
  });

  it("aggregates several files with the dialog's options", async () => {
    const calls = backend();
    const el = dialog();
    await attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: signedIn }).load(
      ["/a.nc", "/b.nc"],
      { dim: "time", join: null, timeout: 60 },
    );
    expect(el.getAttribute("status")).toBe("ready");
    expect(el.getAttribute("file")).toBe(JSON.stringify(["/a.nc", "/b.nc"]));
    expect(calls.find((c) => c.url.endsWith("/zarr/convert"))?.body).toEqual({
      dim: "time",
      path: ["/a.nc", "/b.nc"],
      aggregate: "auto",
    });
  });

  it("an early 'unknown' (5) means queued; later, or once picked up, it is terminal", async () => {
    backend({ statuses: [{ status: 5 }, { status: 5 }, { status: 3 }, { status: 0 }] });
    const el = dialog();
    const opts = { dataPortalBase: PORTAL, getAuthHeaders: signedIn, pollMs: 1 };
    await attachInspector(el, opts).load("/arch/b.nc");
    expect(el.getAttribute("status")).toBe("ready");

    vi.restoreAllMocks();
    backend({ statuses: [{ status: 4 }, { status: 5, reason: "Unknown" }] });
    const el2 = dialog();
    await attachInspector(el2, opts).load("/arch/b.nc");
    expect(el2.getAttribute("status")).toBe("error");
    expect(el2.error).toMatch(/gone/);

    vi.restoreAllMocks();
    backend({ statuses: [{ status: 5 }] });
    const el3 = dialog();
    await attachInspector(el3, { ...opts, startupGraceMs: 5 }).load("/arch/b.nc");
    expect(el3.getAttribute("status")).toBe("error");
  });

  it("a failed conversion shows the server's reason", async () => {
    backend({ statuses: [{ status: 1, reason: "unsupported format" }] });
    const el = dialog();
    await attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: signedIn }).load("/b.nc");
    expect(el.error).toMatch(/could not convert.*unsupported format/i);
  });

  it("a refused convert keeps the server's words", async () => {
    backend({ convert: 403, convertDetail: "User not allowed to read paths." });
    const el = dialog();
    await attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: signedIn }).load("/b.nc");
    expect(el.error).toBe("Access denied. User not allowed to read paths.");
  });

  it("signed out: nothing is converted, and the host's sign-in is offered", async () => {
    const calls = backend();
    const el = dialog();
    const signIn = vi.fn();
    attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: signedOut, signIn });
    el.dispatchEvent(
      new CustomEvent("inspector-submit", { detail: { file: "/b.nc", aggregationConfig: null } }),
    );
    await vi.waitFor(() => expect(el.getAttribute("status")).toBe("error"));
    expect(el.error).toMatch(/needs sign-in/);
    expect(el.getAttribute("error-action")).toBe("Sign in");
    expect(calls.some((c) => c.url.includes("/data-portal/"))).toBe(false);
    el.dispatchEvent(new CustomEvent("inspector-error-action"));
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("a session that ends mid-conversion offers sign-in again", async () => {
    backend({ convert: 401 });
    const el = dialog();
    await attachInspector(el, {
      dataPortalBase: PORTAL,
      getAuthHeaders: signedIn,
      signIn: () => {},
    }).load("/b.nc");
    expect(el.error).toMatch(/session has ended/);
    expect(el.getAttribute("error-action")).toBe("Sign in");
  });

  it("without a data-portal there is no second route - and it says so", async () => {
    const calls = backend({ stores: [] });
    const el = dialog();
    await attachInspector(el).load("/arch/b.nc");
    expect(el.getAttribute("status")).toBe("error");
    expect(el.error).toMatch(/no data-portal/i);
    expect(calls).toHaveLength(0); // a plain file path is not even probed
  });
});

describe("auth headers", () => {
  // HTTP header names are case-insensitive: a hook returning `authorization` is signed in.
  const lowercase = (): Record<string, string> => ({ authorization: "Bearer tok" });

  it("a lowercase Authorization header counts as signed in for a conversion", async () => {
    const calls = backend();
    const el = dialog();
    await attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: lowercase }).load(
      "/arch/b.nc",
    );
    expect(el.getAttribute("status")).toBe("ready");
    expect(calls.find((c) => c.url.endsWith("/zarr/convert"))?.auth).toBe("Bearer tok");
  });

  it("a store read with a lowercase Authorization header is protected: it gets a share link", async () => {
    const calls = backend();
    const el = dialog();
    await attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: lowercase }).load(STORE);
    expect(el.getAttribute("zarr-url")).toBe(SHARE);
    expect(calls.some((c) => c.url.endsWith("/share-zarr"))).toBe(true);
  });
});

describe("a protected store is what the hook sent a credential to", () => {
  // A hook scoped to the store's CONTENTS (`store/`): it authenticates `.zmetadata`, but has
  // nothing for the bare store URL. The read used a token, so GridLook must not get that URL.
  const underStore = (url: string): Record<string, string> =>
    url.startsWith(`${STORE}/`) ? { Authorization: "Bearer tok" } : {};

  it("gets a share link", async () => {
    const calls = backend();
    const el = dialog();
    await attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: underStore }).load(STORE);
    expect(calls.find((c) => c.url === `${STORE}/.zmetadata`)?.auth).toBe("Bearer tok");
    expect(calls.some((c) => c.url.endsWith("/share-zarr"))).toBe(true);
    expect(el.getAttribute("zarr-url")).toBe(SHARE);
  });

  it("without a data-portal to share it, the viewer is disabled", async () => {
    backend();
    const el = dialog();
    await attachInspector(el, { getAuthHeaders: underStore }).load(STORE);
    expect(el.getAttribute("status")).toBe("ready");
    expect(el.getAttribute("viewer-disabled")).toMatch(/share link/);
  });

  it("a refusal after a credential was sent says the sign-in was not accepted", async () => {
    backend({ refuse: 401 });
    const el = dialog();
    await attachInspector(el, { getAuthHeaders: underStore, signIn: () => {} }).load(STORE);
    expect(el.error).toMatch(/did not accept your sign-in/);
  });
});

describe("a store that refuses the read", () => {
  it("standalone (no data-portal), signed out: says sign-in, and offers it", async () => {
    backend({ refuse: 401 });
    const el = dialog();
    const signIn = vi.fn();
    await attachInspector(el, { getAuthHeaders: signedOut, signIn }).load(FOREIGN);
    expect(el.getAttribute("status")).toBe("error");
    expect(el.error).toMatch(/needs sign-in.*401/);
    expect(el.getAttribute("error-action")).toBe("Sign in");
    expect(el.getAttribute("zarr-url")).toBeNull();
  });

  it("standalone, signed in but the token is refused: sign in again", async () => {
    backend({ refuse: 401 });
    const el = dialog();
    await attachInspector(el, {
      getAuthHeaders: scopedBearerAuth({ getToken: () => "tok", origins: [FOREIGN] }),
      signIn: () => {},
    }).load(FOREIGN);
    expect(el.error).toMatch(/did not accept your sign-in/);
    expect(el.getAttribute("error-action")).toBe("Sign in");
  });

  it("standalone, signed in and forbidden (403): no sign-in to offer", async () => {
    backend({ refuse: 403 });
    const el = dialog();
    await attachInspector(el, {
      getAuthHeaders: scopedBearerAuth({ getToken: () => "tok", origins: [FOREIGN] }),
      signIn: () => {},
    }).load(FOREIGN);
    expect(el.error).toMatch(/not allowed.*403/);
    expect(el.getAttribute("error-action")).toBeNull();
  });

  it("a foreign store's refusal does not block a signed-in conversion", async () => {
    // The token is scoped to the portal's origin, so the foreign probe went out anonymously.
    const calls = backend({ refuse: 403, refuseFor: [FOREIGN] });
    const el = dialog();
    await attachInspector(el, {
      dataPortalBase: PORTAL,
      getAuthHeaders: signedIn,
      signIn: () => {},
    }).load(FOREIGN);
    expect(calls.find((c) => c.url === `${FOREIGN}/.zmetadata`)?.auth).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith("/zarr/convert"))?.body).toEqual({ path: FOREIGN });
    expect(el.getAttribute("status")).toBe("ready");
    expect(el.getAttribute("error-action")).toBeNull();
  });

  it("a converted store that answers 401 means the session ended: sign-in is offered", async () => {
    backend({ refuse: 401, refuseFor: [STORE] });
    const el = dialog();
    await attachInspector(el, {
      dataPortalBase: PORTAL,
      getAuthHeaders: signedIn,
      signIn: () => {},
    }).load("/arch/b.nc");
    expect(el.getAttribute("status")).toBe("error");
    expect(el.error).toMatch(/session has ended/);
    expect(el.getAttribute("error-action")).toBe("Sign in");
  });

  it("with the data-loader, signed out: the store's refusal is what is reported", async () => {
    const calls = backend({ refuse: 401 });
    const el = dialog();
    await attachInspector(el, {
      dataPortalBase: PORTAL,
      getAuthHeaders: signedOut,
      signIn: () => {},
    }).load(STORE);
    expect(el.error).toMatch(/store needs sign-in/);
    expect(el.getAttribute("error-action")).toBe("Sign in");
    expect(calls.some((c) => c.url.endsWith("/zarr/convert"))).toBe(false);
  });
});

describe("the real element", () => {
  it("an array load switches to aggregation mode, so Retry re-submits the files", async () => {
    const calls = backend({ convert: 503 });
    const el = realDialog();
    const inspector = attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: signedIn });
    const first = inspector.load(["/a.nc", "/b.nc"], { dim: "time" });
    el.setAttribute("open", "");
    await first;
    expect(el.getAttribute("status")).toBe("error");
    expect(el.isAggregation).toBe(true);
    (el.querySelector("#nc-retry-btn") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith("/zarr/convert"))).toHaveLength(2),
    );
    expect(calls.filter((c) => c.url.endsWith("/zarr/convert"))[1].body).toMatchObject({
      path: ["/a.nc", "/b.nc"],
    });

    // ...and a single path afterwards is a single-file read again.
    await inspector.load(FOREIGN);
    expect(el.isAggregation).toBe(false);
  });

  it("Retry re-submits a read's own aggregation options exactly; the form shows them", async () => {
    const calls = backend({ convert: 503 });
    const el = realDialog();
    const inspector = attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: signedIn });
    const config = { aggregate: "concat", dim: "time", join: "exact" };
    const first = inspector.load(["/a.nc", "/b.nc"], config);
    el.setAttribute("open", "");
    await first;
    const form = el.querySelector("#nc-agg-config") as HTMLElement;
    expect((form.querySelector('[data-field="aggregate"]') as HTMLSelectElement).value).toBe(
      "concat",
    );
    expect((form.querySelector('[data-field="dim"]') as HTMLInputElement).value).toBe("time");
    expect((form.querySelector('[data-field="join"]') as HTMLSelectElement).value).toBe("exact");

    (el.querySelector("#nc-retry-btn") as HTMLButtonElement).click();
    const converts = (): Call[] => calls.filter((c) => c.url.endsWith("/zarr/convert"));
    await vi.waitFor(() => expect(converts()).toHaveLength(2));
    expect(converts()[1].body).toEqual(converts()[0].body);
    expect(converts()[1].body).toEqual({ ...config, path: ["/a.nc", "/b.nc"] });

    // An edit in the form is the user's choice: from then on the form's values are submitted.
    await vi.waitFor(() => expect(el.getAttribute("status")).toBe("error"));
    const dim = form.querySelector('[data-field="dim"]') as HTMLInputElement;
    dim.value = "ensemble";
    dim.dispatchEvent(new Event("change", { bubbles: true }));
    (el.querySelector("#nc-retry-btn") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(converts()).toHaveLength(3));
    expect(converts()[2].body).toMatchObject({ aggregate: "concat", dim: "ensemble" });
  });

  it("Retry re-submits a single file's options; an edited path is a plain new read", async () => {
    const calls = backend({ convert: 503 });
    const el = realDialog();
    const inspector = attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: signedIn });
    const first = inspector.load("/a.nc", { reload: true, chunk_size: 64 });
    el.setAttribute("open", "");
    await first;
    expect(el.getAttribute("status")).toBe("error");
    const converts = (): Call[] => calls.filter((c) => c.url.endsWith("/zarr/convert"));
    const retry = (): void => (el.querySelector("#nc-retry-btn") as HTMLButtonElement).click();

    retry();
    await vi.waitFor(() => expect(converts()).toHaveLength(2));
    expect(converts()[1].body).toEqual({ path: "/a.nc", reload: true, chunk_size: 64 });

    await vi.waitFor(() => expect(el.getAttribute("status")).toBe("error"));
    const input = el.querySelector("#nc-path-input") as HTMLInputElement;
    input.value = "/b.nc";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    retry();
    await vi.waitFor(() => expect(converts()).toHaveLength(3));
    expect(converts()[2].body).toEqual({ path: "/b.nc" });
  });

  it("Retry of a forced re-conversion of a store converts again, not a direct read", async () => {
    const calls = backend({ convert: 503, stores: [FOREIGN] });
    const el = realDialog();
    const inspector = attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: signedIn });
    const first = inspector.load(FOREIGN, { reload: true });
    el.setAttribute("open", "");
    await first;
    (el.querySelector("#nc-retry-btn") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith("/zarr/convert"))).toHaveLength(2),
    );
    await vi.waitFor(() => expect(el.getAttribute("status")).toBe("error"));
    expect(calls.some((c) => c.url.startsWith(`${FOREIGN}/`))).toBe(false); // never read as-is
  });

  it("reusing an open inspector shows the new path in the field", async () => {
    const OTHER = "https://object-store.example.org/bucket/b.zarr";
    backend({ stores: [FOREIGN, OTHER] });
    const el = realDialog();
    const inspector = attachInspector(el, { getAuthHeaders: signedOut });
    const first = inspector.load(FOREIGN);
    el.setAttribute("open", "");
    await first;
    const input = el.querySelector("#nc-path-input") as HTMLInputElement;
    expect(input.value).toBe(FOREIGN);
    await inspector.load(OTHER);
    expect(el.getAttribute("zarr-url")).toBe(OTHER);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe(OTHER);
  });
});

describe("dataLoader: false", () => {
  it("still shares a protected store, but never submits a conversion", async () => {
    const calls = backend();
    const el = dialog();
    const inspector = attachInspector(el, {
      dataPortalBase: PORTAL,
      dataLoader: false,
      getAuthHeaders: signedIn,
    });
    await inspector.load(STORE);
    expect(el.getAttribute("zarr-url")).toBe(SHARE);
    await inspector.load("/arch/b.nc");
    expect(el.error).toMatch(/conversion is not enabled here/);
    expect(calls.some((c) => c.url.endsWith("/zarr/convert"))).toBe(false);
  });
});

describe("lifecycle", () => {
  it("a newer load supersedes an older one; detach stops everything", async () => {
    backend({ statuses: [{ status: 4 }], stores: [FOREIGN] });
    const el = dialog();
    const inspector = attachInspector(el, {
      dataPortalBase: PORTAL,
      getAuthHeaders: signedIn,
      pollMs: 5,
    });
    const slow = inspector.load("/arch/slow.nc"); // polls forever (status 4)
    await new Promise((r) => setTimeout(r, 20));
    await inspector.load(FOREIGN); // a public store: ready at once
    expect(el.getAttribute("status")).toBe("ready");
    expect(el.getAttribute("zarr-url")).toBe(FOREIGN);
    await slow; // the first load noticed it was superseded and ended quietly
    expect(el.getAttribute("zarr-url")).toBe(FOREIGN); // ...without touching the dialog

    inspector.detach();
    el.dispatchEvent(
      new CustomEvent("inspector-submit", { detail: { file: "/x.nc", aggregationConfig: null } }),
    );
    expect(el.getAttribute("status")).toBe("ready"); // detached: the submit is ignored
  });

  it("detach cancels a metadata read in flight, and no second document is asked for", async () => {
    const seen: string[] = [];
    let aborted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      seen.push(String(input));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const el = dialog();
    const inspector = attachInspector(el, { getAuthHeaders: signedOut });
    const pending = inspector.load(FOREIGN);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    inspector.detach();
    await pending;
    expect(aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([`${FOREIGN}/.zmetadata`]); // no zarr.json after the abort
    expect(el.getAttribute("status")).toBe("loading"); // a detached read writes nothing
  });

  it("a superseding load cancels the converted store's metadata read too", async () => {
    let storeReadAborted = false;
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/zarr/convert")) return json({ urls: [STORE] });
      if (url.endsWith("/share-zarr")) return json({ url: SHARE });
      if (url.includes("/zarr-utils/status")) return json({ status: 0 });
      if (url.startsWith(STORE))
        return new Promise<Response>((_r, reject) =>
          init?.signal?.addEventListener("abort", () => {
            storeReadAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          }),
        );
      return url.endsWith("/.zmetadata") ? json(ZMETA) : new Response("", { status: 404 });
    });
    const el = dialog();
    const inspector = attachInspector(el, { dataPortalBase: PORTAL, getAuthHeaders: signedIn });
    const slow = inspector.load("/arch/b.nc");
    await vi.waitFor(() => expect(el.getAttribute("zarr-status-code")).toBe("0"));
    await inspector.load(FOREIGN);
    await slow;
    expect(storeReadAborted).toBe(true);
    expect(el.getAttribute("zarr-url")).toBe(FOREIGN);
  });
});
