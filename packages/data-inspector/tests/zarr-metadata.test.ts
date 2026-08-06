import { describe, it, expect, vi, afterEach } from "vitest";
import {
  openDatasetMeta,
  buildXarrayRepr,
  injectXarrayCss,
  loadZarrMetadataHtml,
  type ZarrMetadataResult,
  type ZarrDataset,
} from "../src/zarr-metadata";

interface FakeResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

/** Route fetch by suffix: `.zmetadata` (v2) or `zarr.json` (v3). */
function routeFetch(routes: {
  zmetadata?: { ok: boolean; body?: unknown };
  zarrJson?: { ok: boolean; body?: unknown };
}) {
  const impl = (url: string): Promise<FakeResponse> => {
    const u = String(url);
    if (u.endsWith("/.zmetadata")) {
      const r = routes.zmetadata ?? { ok: false };
      return Promise.resolve({ ok: r.ok, json: () => Promise.resolve(r.body ?? {}) });
    }
    if (u.endsWith("/zarr.json")) {
      const r = routes.zarrJson ?? { ok: false };
      return Promise.resolve({ ok: r.ok, json: () => Promise.resolve(r.body ?? {}) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  };
  // The mock only reads the URL, but it stands in for the real fetch.
  return vi.fn(impl as unknown as typeof fetch);
}

const URL_BASE = "https://example.com/store.zarr";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Flat v2 store exercising: time-coord detection, scalar (0-dim) var,
// per-variable `coordinates`, 1-D/2-D/3-D chunk cubes, dtype mapping, and
// fmtBytes across B / KiB / MiB / GiB, plus a chunks/shape length mismatch.
const V2_FLAT = {
  metadata: {
    ".zgroup": { zarr_format: 2 },
    ".zattrs": { title: "Test dataset", Conventions: "CF-1.8" },
    "time/.zarray": { shape: [3], chunks: [3], dtype: "<i8" },
    "time/.zattrs": {
      _ARRAY_DIMENSIONS: ["time"],
      units: "days since 2000-01-01",
      calendar: "standard",
    },
    "height/.zarray": { shape: [], chunks: [], dtype: "<f4" },
    "height/.zattrs": { _ARRAY_DIMENSIONS: [], units: "m" },
    "tas/.zarray": { shape: [3, 4], chunks: [3, 2], dtype: "<f4" },
    "tas/.zattrs": {
      _ARRAY_DIMENSIONS: ["time", "x"],
      units: "K",
      coordinates: "height",
      standard_name: "air_temperature",
    },
    "kvar/.zarray": { shape: [512], chunks: [512], dtype: "<f4" },
    "kvar/.zattrs": { _ARRAY_DIMENSIONS: ["k"] },
    "big/.zarray": { shape: [1024, 1024], chunks: [256, 256], dtype: "<f4" },
    "big/.zattrs": { _ARRAY_DIMENSIONS: ["y", "x2"] },
    "huge/.zarray": { shape: [1024, 1024, 1024], chunks: [128, 128, 128], dtype: "<f4" },
    "huge/.zattrs": { _ARRAY_DIMENSIONS: ["a", "b", "c"] },
    "mismatch/.zarray": { shape: [2, 2], chunks: [2], dtype: "<f4" },
    "mismatch/.zattrs": { _ARRAY_DIMENSIONS: ["m", "n"] },
  },
};

// Grouped v2 store (two groups) exercising the group-card path.
const V2_GROUPED = {
  metadata: {
    ".zgroup": { zarr_format: 2 },
    "g1/.zgroup": { zarr_format: 2 },
    "g1/.zattrs": { title: "group one" },
    "g1/temp/.zarray": { shape: [2], chunks: [2], dtype: "<f4" },
    "g1/temp/.zattrs": { _ARRAY_DIMENSIONS: ["t"], units: "K" },
    "g2/.zgroup": { zarr_format: 2 },
    "g2/pr/.zarray": { shape: [2, 2], chunks: [2, 2], dtype: "<f4" },
    "g2/pr/.zattrs": { _ARRAY_DIMENSIONS: ["t", "s"] },
  },
};

// Flat v3 store via zarr.json consolidated metadata.
const V3_FLAT = {
  zarr_format: 3,
  node_type: "group",
  consolidated_metadata: {
    metadata: {
      "": { node_type: "group", attributes: { title: "V3 dataset" } },
      time: {
        node_type: "array",
        shape: [3],
        chunk_grid: { configuration: { chunk_shape: [3] } },
        data_type: "int64",
        dimension_names: ["time"],
        attributes: { units: "days since 2000-01-01" },
      },
      tas: {
        node_type: "array",
        shape: [3, 4],
        chunk_grid: { configuration: { chunk_shape: [3, 2] } },
        data_type: "float32",
        dimension_names: ["time", "x"],
        attributes: { units: "K" },
      },
    },
  },
};

// Grouped v3 store.
const V3_GROUPED = {
  zarr_format: 3,
  node_type: "group",
  consolidated_metadata: {
    metadata: {
      "": { node_type: "group", attributes: {} },
      grp: { node_type: "group", attributes: { title: "grp" } },
      "grp/x": {
        node_type: "array",
        shape: [4],
        chunk_grid: { configuration: { chunk_shape: [4] } },
        data_type: "float64",
        dimension_names: ["x"],
        attributes: {},
      },
    },
  },
};

// Deeply nested v2 store: model/ocean/temp, model/atmos/pr, plus a root array.
const V2_NESTED = {
  metadata: {
    ".zgroup": { zarr_format: 2 },
    "root_var/.zarray": { shape: [2], chunks: [2], dtype: "<f4" },
    "root_var/.zattrs": { _ARRAY_DIMENSIONS: ["t"] },
    "model/.zgroup": { zarr_format: 2 },
    "model/ocean/.zgroup": { zarr_format: 2 },
    "model/ocean/temp/.zarray": { shape: [2], chunks: [2], dtype: "<f4" },
    "model/ocean/temp/.zattrs": { _ARRAY_DIMENSIONS: ["t"] },
    "model/atmos/.zgroup": { zarr_format: 2 },
    "model/atmos/pr/.zarray": { shape: [2], chunks: [2], dtype: "<f4" },
    "model/atmos/pr/.zattrs": { _ARRAY_DIMENSIONS: ["t"] },
  },
};

// Deeply nested v3 store.
const V3_NESTED = {
  zarr_format: 3,
  node_type: "group",
  consolidated_metadata: {
    metadata: {
      "": { node_type: "group", attributes: {} },
      top: {
        node_type: "array",
        shape: [2],
        chunk_grid: { configuration: { chunk_shape: [2] } },
        data_type: "float32",
        dimension_names: ["t"],
        attributes: {},
      },
      model: { node_type: "group", attributes: {} },
      "model/ocean": { node_type: "group", attributes: {} },
      "model/ocean/temp": {
        node_type: "array",
        shape: [2],
        chunk_grid: { configuration: { chunk_shape: [2] } },
        data_type: "float32",
        dimension_names: ["t"],
        attributes: {},
      },
      "model/atmos": { node_type: "group", attributes: {} },
      "model/atmos/pr": {
        node_type: "array",
        shape: [2],
        chunk_grid: { configuration: { chunk_shape: [2] } },
        data_type: "float32",
        dimension_names: ["t"],
        attributes: {},
      },
    },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Parsing ───────────────────────────────────────────────────────────────────

describe("openDatasetMeta (v2)", () => {
  it("parses a flat .zmetadata store into a single dataset", async () => {
    globalThis.fetch = routeFetch({ zmetadata: { ok: true, body: V2_FLAT } });

    const result = await openDatasetMeta(URL_BASE);
    expect(result.groups).toBeNull();
    const ds = result as Extract<ZarrMetadataResult, { groups: null }>;

    // time is a 1-D self-named coordinate; height is promoted via `coordinates`.
    expect(Object.keys(ds.coords).sort()).toEqual(["height", "time"]);
    expect(ds.data_vars).toHaveProperty("tas");
    expect(ds.data_vars).toHaveProperty("huge");

    // dtype mapping and dimensions.
    expect(ds.coords.time.dtype).toBe("int64");
    expect(ds.data_vars.tas.dtype).toBe("float32");
    expect(ds.coords.time._isTimeCoord).toBe(true);
    expect(ds.dims.time).toBe(3);
    expect(ds.dims.x).toBe(4);

    // _ARRAY_DIMENSIONS is stripped from user-facing attrs.
    expect(ds.coords.time.attrs).not.toHaveProperty("_ARRAY_DIMENSIONS");
    expect(ds.coords.time.attrs.units).toBe("days since 2000-01-01");

    // root attributes preserved.
    expect(ds.attrs.title).toBe("Test dataset");
  });

  it("parses a grouped .zmetadata store into named groups", async () => {
    globalThis.fetch = routeFetch({ zmetadata: { ok: true, body: V2_GROUPED } });

    const result = await openDatasetMeta(URL_BASE);
    expect(result.groups).not.toBeNull();
    const groups = (result as { groups: Record<string, unknown> }).groups;
    expect(Object.keys(groups).sort()).toEqual(["g1", "g2"]);
  });

  it("parses nested v2 groups at all depths and keeps root arrays", async () => {
    globalThis.fetch = routeFetch({ zmetadata: { ok: true, body: V2_NESTED } });

    const result = await openDatasetMeta(URL_BASE);
    const groups = (result as { groups: Record<string, ZarrDataset> }).groups;
    // Root ("/") plus the two leaf groups that actually hold arrays; the
    // pure-container "model" group is omitted.
    expect(Object.keys(groups).sort()).toEqual(["/", "model/atmos", "model/ocean"]);
    expect(groups["/"].data_vars.root_var).toBeDefined();
    expect(groups["model/ocean"].data_vars.temp).toBeDefined();
    expect(groups["model/atmos"].data_vars.pr).toBeDefined();
  });

  it("throws when a flat store has no arrays", async () => {
    globalThis.fetch = routeFetch({
      zmetadata: { ok: true, body: { metadata: { ".zgroup": { zarr_format: 2 }, ".zattrs": {} } } },
    });

    await expect(openDatasetMeta(URL_BASE)).rejects.toThrow(/No arrays found in \.zmetadata/);
  });
});

describe("openDatasetMeta (v3)", () => {
  it("parses a flat zarr.json store when .zmetadata is absent", async () => {
    globalThis.fetch = routeFetch({
      zmetadata: { ok: false },
      zarrJson: { ok: true, body: V3_FLAT },
    });

    const result = await openDatasetMeta(URL_BASE);
    expect(result.groups).toBeNull();
    const ds = result as Extract<ZarrMetadataResult, { groups: null }>;
    expect(ds.coords.time.dtype).toBe("int64");
    expect(ds.coords.time._isTimeCoord).toBe(true);
    expect(ds.data_vars.tas.chunks).toEqual([3, 2]);
    expect(ds.attrs.title).toBe("V3 dataset");
  });

  it("parses a grouped zarr.json store", async () => {
    globalThis.fetch = routeFetch({
      zmetadata: { ok: false },
      zarrJson: { ok: true, body: V3_GROUPED },
    });

    const result = await openDatasetMeta(URL_BASE);
    const groups = (result as { groups: Record<string, unknown> }).groups;
    expect(Object.keys(groups)).toEqual(["grp"]);
  });

  it("parses nested v3 groups at all depths and keeps root arrays", async () => {
    globalThis.fetch = routeFetch({
      zmetadata: { ok: false },
      zarrJson: { ok: true, body: V3_NESTED },
    });

    const result = await openDatasetMeta(URL_BASE);
    const groups = (result as { groups: Record<string, ZarrDataset> }).groups;
    expect(Object.keys(groups).sort()).toEqual(["/", "model/atmos", "model/ocean"]);
    expect(groups["/"].data_vars.top).toBeDefined();
    expect(groups["model/ocean"].data_vars.temp).toBeDefined();
    expect(groups["model/atmos"].data_vars.pr).toBeDefined();
  });

  it("throws when consolidated_metadata is empty", async () => {
    globalThis.fetch = routeFetch({
      zmetadata: { ok: false },
      zarrJson: { ok: true, body: { zarr_format: 3, consolidated_metadata: { metadata: {} } } },
    });

    await expect(openDatasetMeta(URL_BASE)).rejects.toThrow(/no consolidated_metadata/);
  });

  it("throws when a v3 store has only a group and no arrays", async () => {
    globalThis.fetch = routeFetch({
      zmetadata: { ok: false },
      zarrJson: {
        ok: true,
        body: {
          zarr_format: 3,
          consolidated_metadata: { metadata: { "": { node_type: "group", attributes: {} } } },
        },
      },
    });

    await expect(openDatasetMeta(URL_BASE)).rejects.toThrow(/No arrays found in zarr\.json/);
  });

  it("throws when neither .zmetadata nor zarr.json is reachable", async () => {
    globalThis.fetch = routeFetch({ zmetadata: { ok: false }, zarrJson: { ok: false } });

    await expect(openDatasetMeta(URL_BASE)).rejects.toThrow(/Could not read zarr metadata/);
  });

  it("uses a custom getAuthHeaders provider", async () => {
    const fetchMock = routeFetch({ zmetadata: { ok: true, body: V2_FLAT } });
    globalThis.fetch = fetchMock;
    const getAuthHeaders = vi.fn(() => ({ Authorization: "Bearer meta" }));

    await openDatasetMeta(URL_BASE, { getAuthHeaders });
    expect(fetchMock).toHaveBeenCalledWith(
      `${URL_BASE}/.zmetadata`,
      expect.objectContaining({ headers: { Authorization: "Bearer meta" } }),
    );
  });
});

// ── HTML rendering ──────────────────────────────────────────────────────────--

describe("buildXarrayRepr", () => {
  it("renders a flat dataset as an xarray.Dataset repr", async () => {
    globalThis.fetch = routeFetch({ zmetadata: { ok: true, body: V2_FLAT } });
    const result = await openDatasetMeta(URL_BASE);

    const html = buildXarrayRepr(result);
    expect(html).toContain("xarray.Dataset");
    expect(html).toContain("Coordinates:");
    expect(html).toContain("Data variables:");
    // fmtBytes across magnitudes is reached through the data-repr tables.
    expect(html).toContain("KiB");
    expect(html).toContain("MiB");
    expect(html).toContain("GiB");
  });

  it("renders grouped datasets as group cards", async () => {
    globalThis.fetch = routeFetch({ zmetadata: { ok: true, body: V2_GROUPED } });
    const result = await openDatasetMeta(URL_BASE);

    const html = buildXarrayRepr(result);
    expect(html).toContain("Group: g1");
    expect(html).toContain("Group: g2");
    expect(html).toContain("xarray.Dataset");
  });

  it("renders nested groups as cards labelled with their full path", async () => {
    globalThis.fetch = routeFetch({ zmetadata: { ok: true, body: V2_NESTED } });
    const result = await openDatasetMeta(URL_BASE);

    const html = buildXarrayRepr(result);
    expect(html).toContain("Group: /");
    expect(html).toContain("Group: model/ocean");
    expect(html).toContain("Group: model/atmos");
  });
});

describe("injectXarrayCss", () => {
  it("appends a single style tag and is idempotent", async () => {
    vi.resetModules();
    document.head.innerHTML = "";
    const mod = await import("../src/zarr-metadata");

    mod.injectXarrayCss();
    mod.injectXarrayCss();

    const styles = document.head.querySelectorAll("style[data-xarray-repr]");
    expect(styles.length).toBe(1);
  });

  it("derives chunk colors from a provided mainColor", async () => {
    vi.resetModules();
    document.head.innerHTML = "";
    const mod = await import("../src/zarr-metadata");

    mod.injectXarrayCss({ mainColor: "#000000" });
    const style = document.head.querySelector("style[data-xarray-repr]");
    expect(style?.textContent).toContain("--xr-chunk-face:rgb(0,0,0)");
  });

  it("is callable through the statically imported module", () => {
    // Exercises the module-level guard on the shared instance.
    expect(() => injectXarrayCss()).not.toThrow();
  });
});

describe("loadZarrMetadataHtml", () => {
  it("fetches metadata and returns the HTML repr without injecting CSS", async () => {
    globalThis.fetch = routeFetch({ zmetadata: { ok: true, body: V2_FLAT } });

    const html = await loadZarrMetadataHtml(URL_BASE, { injectCss: false });
    expect(html).toContain("xarray.Dataset");
  });

  it("injects CSS by default before building HTML", async () => {
    vi.resetModules();
    document.head.innerHTML = "";
    const mod = await import("../src/zarr-metadata");
    globalThis.fetch = routeFetch({
      zmetadata: { ok: false },
      zarrJson: { ok: true, body: V3_FLAT },
    });

    const html = await mod.loadZarrMetadataHtml(URL_BASE);
    expect(html).toContain("xarray.Dataset");
    expect(document.head.querySelectorAll("style[data-xarray-repr]").length).toBe(1);
  });
});
