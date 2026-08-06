import { describe, it, expect, vi, afterEach } from "vitest";
import { detectZarrStore } from "../src/detectZarrStore";

interface FakeResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

/** Build a fetch mock whose response depends on the requested path. */
function routeFetch(routes: {
  zmetadata?: { ok: boolean; body?: unknown };
  zarrJson?: { ok: boolean; body?: unknown };
  error?: "zmetadata" | "zarrJson";
}) {
  const impl = (url: string): Promise<FakeResponse> => {
    const u = String(url);
    if (u.endsWith("/.zmetadata")) {
      if (routes.error === "zmetadata") return Promise.reject(new Error("boom"));
      const r = routes.zmetadata ?? { ok: false };
      return Promise.resolve({ ok: r.ok, json: () => Promise.resolve(r.body ?? {}) });
    }
    if (u.endsWith("/zarr.json")) {
      if (routes.error === "zarrJson") return Promise.reject(new Error("boom"));
      const r = routes.zarrJson ?? { ok: false };
      return Promise.resolve({ ok: r.ok, json: () => Promise.resolve(r.body ?? {}) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  };
  // The mock only reads the URL, but it stands in for the real fetch.
  return vi.fn(impl as unknown as typeof fetch);
}

const URL_BASE = "https://example.com/store.zarr";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detectZarrStore", () => {
  it("returns NOT_ZARR for an empty url without fetching", async () => {
    const fetchMock = routeFetch({});
    globalThis.fetch = fetchMock;

    const info = await detectZarrStore("");
    expect(info).toEqual({ isZarr: false, version: null, consolidated: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("detects a v2 store from .zmetadata (consolidated)", async () => {
    globalThis.fetch = routeFetch({ zmetadata: { ok: true } });

    const info = await detectZarrStore(URL_BASE);
    expect(info).toEqual({ isZarr: true, version: 2, consolidated: true });
  });

  it("probes .zmetadata first, then zarr.json", async () => {
    const fetchMock = routeFetch({
      zmetadata: { ok: false },
      zarrJson: { ok: true, body: { zarr_format: 3, consolidated_metadata: {} } },
    });
    globalThis.fetch = fetchMock;

    await detectZarrStore(URL_BASE);
    const requested = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(requested[0]).toBe(`${URL_BASE}/.zmetadata`);
    expect(requested[1]).toBe(`${URL_BASE}/zarr.json`);
  });

  it("detects a consolidated v3 store from zarr.json", async () => {
    globalThis.fetch = routeFetch({
      zmetadata: { ok: false },
      zarrJson: { ok: true, body: { zarr_format: 3, consolidated_metadata: { metadata: {} } } },
    });

    const info = await detectZarrStore(URL_BASE);
    expect(info).toEqual({ isZarr: true, version: 3, consolidated: true });
  });

  it("detects a non-consolidated v3 store from zarr.json", async () => {
    globalThis.fetch = routeFetch({
      zmetadata: { ok: false },
      zarrJson: { ok: true, body: { zarr_format: 3 } },
    });

    const info = await detectZarrStore(URL_BASE);
    expect(info).toEqual({ isZarr: true, version: 3, consolidated: false });
  });

  it("reports a v2 store reached via zarr.json as non-consolidated", async () => {
    globalThis.fetch = routeFetch({
      zmetadata: { ok: false },
      zarrJson: { ok: true, body: { zarr_format: 2 } },
    });

    const info = await detectZarrStore(URL_BASE);
    expect(info).toEqual({ isZarr: true, version: 2, consolidated: false });
  });

  it("returns NOT_ZARR when zarr.json has an unexpected zarr_format", async () => {
    globalThis.fetch = routeFetch({
      zmetadata: { ok: false },
      zarrJson: { ok: true, body: { zarr_format: 1 } },
    });

    const info = await detectZarrStore(URL_BASE);
    expect(info).toEqual({ isZarr: false, version: null, consolidated: false });
  });

  it("returns NOT_ZARR when neither probe succeeds", async () => {
    globalThis.fetch = routeFetch({ zmetadata: { ok: false }, zarrJson: { ok: false } });

    const info = await detectZarrStore(URL_BASE);
    expect(info).toEqual({ isZarr: false, version: null, consolidated: false });
  });

  it("falls through to zarr.json when the first probe throws", async () => {
    globalThis.fetch = routeFetch({
      error: "zmetadata",
      zarrJson: { ok: true, body: { zarr_format: 3, consolidated_metadata: {} } },
    });

    const info = await detectZarrStore(URL_BASE);
    expect(info).toEqual({ isZarr: true, version: 3, consolidated: true });
  });

  it("returns NOT_ZARR when both probes throw", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network"));

    const info = await detectZarrStore(URL_BASE);
    expect(info).toEqual({ isZarr: false, version: null, consolidated: false });
  });

  it("strips a trailing slash before probing", async () => {
    const fetchMock = routeFetch({ zmetadata: { ok: true } });
    globalThis.fetch = fetchMock;

    await detectZarrStore(`${URL_BASE}/`);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${URL_BASE}/.zmetadata`);
  });

  it("uses a custom getAuthHeaders provider", async () => {
    const fetchMock = routeFetch({ zmetadata: { ok: true } });
    globalThis.fetch = fetchMock;
    const getAuthHeaders = vi.fn(() => ({ Authorization: "Bearer custom" }));

    await detectZarrStore(URL_BASE, { getAuthHeaders });
    expect(getAuthHeaders).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      `${URL_BASE}/.zmetadata`,
      expect.objectContaining({ headers: { Authorization: "Bearer custom" } }),
    );
  });
});
