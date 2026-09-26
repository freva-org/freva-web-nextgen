import { describe, it, expect, vi, afterEach } from "vitest";
import { defaultGetAuthHeaders, resolveAuthHeaders, scopedBearerAuth } from "../src/internal/http";
import { openDatasetMeta } from "../src/zarr-metadata";
import { detectZarrStore } from "../src/detectZarrStore";
import { ZarrPoller } from "../src/ZarrPoller";

const HERE = location.origin;
const FOREIGN = "https://object-store.example.org";

function clearCookies(): void {
  for (const c of document.cookie.split(";")) {
    const name = c.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

afterEach(() => {
  clearCookies();
  vi.restoreAllMocks();
});

describe("defaultGetAuthHeaders is scoped to the page origin", () => {
  it("sends the legacy cookie token to a same-origin URL", () => {
    document.cookie = "freva_auth_token=abc";
    expect(defaultGetAuthHeaders(`${HERE}/api/x.zarr`)).toEqual({ Authorization: "Bearer abc" });
  });

  it("never sends it to another origin", () => {
    document.cookie = "freva_auth_token=abc";
    expect(defaultGetAuthHeaders(`${FOREIGN}/bucket/x.zarr`)).toEqual({});
  });
});

describe("resolveAuthHeaders", () => {
  it("hands the provider the ABSOLUTE url and awaits an async answer", async () => {
    const provider = vi.fn(async (url: string) => ({ "X-Url": url }));
    expect(await resolveAuthHeaders(provider, "/api/store.zarr/.zmetadata")).toEqual({
      "X-Url": `${HERE}/api/store.zarr/.zmetadata`,
    });
  });

  it("a provider that rejects yields no headers (anonymous request)", async () => {
    expect(await resolveAuthHeaders(() => Promise.reject(new Error("expired")), "/x")).toEqual({});
  });
});

describe("scopedBearerAuth", () => {
  it("defaults to the page origin and asks for the token only there", async () => {
    const getToken = vi.fn(async () => "tok");
    const auth = scopedBearerAuth({ getToken });
    expect(await auth(`${HERE}/api/a.zarr`)).toEqual({ Authorization: "Bearer tok" });
    expect(await auth(`${FOREIGN}/a.zarr`)).toEqual({});
    expect(getToken).toHaveBeenCalledTimes(1); // a foreign URL never triggers a token lookup
  });

  it("accepts extra origins given as origins or full URLs", async () => {
    const auth = scopedBearerAuth({
      getToken: () => "tok",
      origins: ["https://api.freva.example/api/freva-nextgen/data-portal"],
    });
    expect(
      await auth("https://api.freva.example/api/freva-nextgen/data-portal/zarr/x.zarr"),
    ).toEqual({
      Authorization: "Bearer tok",
    });
    expect(await auth(`${HERE}/x`)).toEqual({}); // not listed -> not sent
  });

  it("sends nothing while signed out", async () => {
    expect(await scopedBearerAuth({ getToken: () => null })(`${HERE}/x`)).toEqual({});
  });
});

describe("every fetcher asks per URL", () => {
  function captureFetch(ok = false) {
    const seen: Array<{ url: string; auth?: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: String(input), auth: h.Authorization });
      return new Response(ok ? JSON.stringify({ status: 3 }) : "", { status: ok ? 200 : 404 });
    });
    return seen;
  }
  const auth = scopedBearerAuth({ getToken: async () => "tok" });

  it("openDatasetMeta: bearer to its own origin, none to a foreign store", async () => {
    const seen = captureFetch();
    await openDatasetMeta(`${HERE}/api/a.zarr`, { getAuthHeaders: auth }).catch(() => {});
    await openDatasetMeta(`${FOREIGN}/a.zarr`, { getAuthHeaders: auth }).catch(() => {});
    expect(seen.filter((s) => s.url.startsWith(HERE)).every((s) => s.auth === "Bearer tok")).toBe(
      true,
    );
    expect(seen.filter((s) => s.url.startsWith(FOREIGN)).every((s) => !s.auth)).toBe(true);
  });

  it("detectZarrStore: same rule", async () => {
    const seen = captureFetch();
    await detectZarrStore(`${FOREIGN}/a.zarr`, { getAuthHeaders: auth });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => !s.auth)).toBe(true);
  });

  it("ZarrPoller: asks on every poll (a refreshed token is picked up)", async () => {
    const seen = captureFetch(true);
    let n = 0;
    const poller = new ZarrPoller(`${HERE}/api/freva-nextgen/data-portal/zarr/t.zarr`, {
      getAuthHeaders: async () => ({ Authorization: `Bearer t${++n}` }),
      intervalMs: 5,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 40));
    poller.stop();
    const tokens = seen.map((s) => s.auth);
    expect(tokens.length).toBeGreaterThan(1);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
