import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { crc32c, decodeBytes, UnsupportedCodecError } from "../src/internal/chunk-codecs";
import { cfReference, previewStamp, readTimeValues } from "../src/time-values";
import { loadZarrMetadataHtml } from "../src/zarr-metadata";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(here, "fixtures/time-chunks.json"), "utf8")) as {
  floats: string;
  codecs: Record<string, { id: string; enc: string }>;
  unsupported: Record<string, string>;
  era5: { first: string; last: string; repr: string };
  monthly: { chunk: string; repr: string };
  six: { chunk: string; repr: string };
  checks: Record<string, string>;
  parallel: { enc: string; ordered: string };
};
const bytes = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

const STORE = "https://example.com/era5.zarr";
const ERA5 = {
  metadata: {
    ".zgroup": { zarr_format: 2 },
    "time/.zarray": {
      shape: [31593],
      chunks: [2738],
      dtype: "<i8",
      compressor: { id: "blosc", cname: "lz4", clevel: 5, shuffle: 1, blocksize: 0 },
      filters: null,
    },
    "time/.zattrs": {
      _ARRAY_DIMENSIONS: ["time"],
      units: "days since 1940-01-01 12:00:00",
      calendar: "proleptic_gregorian",
    },
  },
};

function serve(chunks: Record<string, Uint8Array | null>) {
  const requested: string[] = [];
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    requested.push(u);
    if (u.endsWith("/.zmetadata")) {
      return { ok: true, status: 200, json: async () => ERA5 } as unknown as Response;
    }
    const body = chunks[u.slice(STORE.length + 1)];
    if (!body) return { ok: false, status: 404 } as unknown as Response;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => body.slice().buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return requested;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("chunk codecs", () => {
  const floats = bytes(fixture.floats);
  for (const [name, { id, enc }] of Object.entries(fixture.codecs)) {
    it(`decodes ${name} as numcodecs wrote it`, async () => {
      expect(Buffer.from(await decodeBytes(bytes(enc), { id }, floats.length))).toEqual(
        Buffer.from(floats),
      );
    });
  }

  it("decodes Blosc blocks stored out of order, as threaded Blosc writes them", async () => {
    const ordered = await decodeBytes(bytes(fixture.parallel.ordered), { id: "blosc" }, 160_000);
    const parallel = await decodeBytes(bytes(fixture.parallel.enc), { id: "blosc" }, 160_000);
    expect(Buffer.from(parallel)).toEqual(Buffer.from(ordered));
  });

  it("refuses a chunk that claims to decode to more than its shape holds", async () => {
    const header = new Uint8Array(32);
    const view = new DataView(header.buffer);
    header.set([2, 1, 0x21, 8]);
    view.setUint32(4, 1 << 30, true);
    view.setUint32(8, 1 << 16, true);
    view.setUint32(12, 32, true);
    await expect(decodeBytes(header, { id: "blosc" }, 12)).rejects.toThrow(/more than/);
    const lz4 = new Uint8Array(8);
    new DataView(lz4.buffer).setUint32(0, 1 << 30, true);
    await expect(decodeBytes(lz4, { id: "lz4" }, 12)).rejects.toThrow(/more than/);
    const floats = bytes(fixture.floats);
    await expect(
      decodeBytes(bytes(fixture.codecs.zstd.enc), { id: "zstd" }, floats.length - 1),
    ).rejects.toThrow();
    await expect(
      decodeBytes(bytes(fixture.codecs.zlib.enc), { id: "zlib" }, floats.length - 1),
    ).rejects.toThrow(/more than/);
  });

  it("decodes small Blosc blocks by the format's split rule", async () => {
    const out = await decodeBytes(bytes(fixture.checks.bloscSmall), { id: "blosc" }, 800);
    expect(Buffer.from(out)).toEqual(Buffer.from(bytes(fixture.checks.bloscSmallRaw)));
  });

  it("checks Zstandard's content checksum and rejects truncated frames", async () => {
    const frame = bytes(fixture.checks.zstdChecksum);
    const clean = await decodeBytes(frame, { id: "zstd" }, 64);
    expect(Buffer.from(clean)).toEqual(Buffer.from(bytes(fixture.checks.zstdChecksumRaw)));
    const tampered = frame.slice();
    tampered[20] ^= 1;
    await expect(decodeBytes(tampered, { id: "zstd" }, 64)).rejects.toThrow(/checksum/);
    const rle = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x20, 0xc8, 0x43, 0x06, 0x00, 0x07);
    expect((await decodeBytes(rle, { id: "zstd" }, 200)).every((b) => b === 7)).toBe(true);
    await expect(decodeBytes(rle.subarray(0, 9), { id: "zstd" }, 200)).rejects.toThrow();
    const compressed = bytes(fixture.checks.zstdRle);
    await expect(
      decodeBytes(compressed.subarray(0, compressed.length - 1), { id: "zstd" }, 1000),
    ).rejects.toThrow();
  });

  it("checks a CRC32C checksum before trusting the bytes", async () => {
    const body = new TextEncoder().encode("123456789");
    expect(crc32c(body)).toBe(0xe3069283);
    const sealed = new Uint8Array(body.length + 4);
    sealed.set(body);
    new DataView(sealed.buffer).setUint32(body.length, 0xe3069283, true);
    expect(Buffer.from(await decodeBytes(sealed, { id: "crc32c" }, 9))).toEqual(Buffer.from(body));
    sealed[0] ^= 1;
    await expect(decodeBytes(sealed, { id: "crc32c" }, 9)).rejects.toThrow(/checksum/);
  });

  it("says which codecs it cannot decode", async () => {
    for (const enc of Object.values(fixture.unsupported)) {
      await expect(decodeBytes(bytes(enc), { id: "blosc" }, 1 << 20)).rejects.toBeInstanceOf(
        UnsupportedCodecError,
      );
    }
    await expect(decodeBytes(new Uint8Array(8), { id: "bz2" }, 8)).rejects.toBeInstanceOf(
      UnsupportedCodecError,
    );
  });
});

describe("CF time units", () => {
  it("reads the unit and the reference date", () => {
    const ref = cfReference("days since 1940-01-01 12:00:00")!;
    expect(ref.unitNs).toBe(86_400e9);
    expect(previewStamp(ref.origin)).toBe("1940-01-01T12:00:00");
    expect(previewStamp(cfReference("hours since 2000-01-01T00:00:00Z")!.origin)).toBe(
      "2000-01-01",
    );
    expect(previewStamp(cfReference("seconds since 1970-1-1 0:0:0 +01:00")!.origin)).toBe(
      "1969-12-31T23:00:00",
    );
    expect(cfReference("degrees_north")).toBeNull();
    expect(cfReference("fortnights since 2000-01-01")).toBeNull();
  });
});

describe("the time coordinate's values", () => {
  it("reads only the first and last chunk, and shows them as xarray does", async () => {
    const requested = serve({
      "time/0": bytes(fixture.era5.first),
      "time/11": bytes(fixture.era5.last),
    });
    const html = await loadZarrMetadataHtml(STORE, { injectCss: false });
    expect(requested.filter((u) => !u.endsWith(".zmetadata")).sort()).toEqual([
      `${STORE}/time/0`,
      `${STORE}/time/11`,
    ]);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector(".xr-var-dtype")?.textContent).toBe("datetime64[ns]");
    expect(doc.querySelector(".xr-var-preview")?.textContent).toBe(
      "1940-01-01T12:00:00 ... 2026-06-30T12:00:00",
    );
    expect(doc.querySelector(".xr-var-data > pre")?.textContent).toBe(fixture.era5.repr);
    expect(doc.querySelector(".xr-var-data table")?.textContent).toContain("datetime64[ns]");
  });

  it("shows the first and last three of more than six values, as numpy summarizes them", async () => {
    serve({ "time/0": bytes(fixture.monthly.chunk) });
    const values = await readTimeValues(
      STORE,
      {
        shape: [20],
        chunks: [20],
        dtype: "int64",
        dims: ["time"],
        attrs: { units: "days since 2000-01-01", calendar: "standard" },
      },
      {
        path: "time",
        chunkPrefix: "",
        dtype: "<i8",
        littleEndian: true,
        codecs: [{ id: "blosc" }],
      },
    );
    expect(values?.repr).toBe(fixture.monthly.repr);
    expect(values?.preview).toBe("2000-01-01 ... 2001-08-12");
  });

  it("lists all of six values, from a zstd chunk of a zarr v3 store", async () => {
    const requested = serve({ "time/c/0": bytes(fixture.six.chunk) });
    const values = await readTimeValues(
      STORE,
      {
        shape: [6],
        chunks: [6],
        dtype: "int64",
        dims: ["time"],
        attrs: { units: "hours since 2000-01-01", calendar: "proleptic_gregorian" },
      },
      {
        path: "time",
        chunkPrefix: "c/",
        dtype: "int64",
        littleEndian: true,
        codecs: [{ id: "blosc" }],
      },
    );
    expect(requested).toEqual([`${STORE}/time/c/0`]);
    expect(values?.repr).toBe(fixture.six.repr);
    expect(values?.preview).toBe("2000-01-01 ... 2000-01-02T06:00:00");
  });

  it("keeps today's summary when a chunk cannot be read", async () => {
    serve({ "time/0": bytes(fixture.era5.first) });
    const html = await loadZarrMetadataHtml(STORE, { injectCss: false });
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector(".xr-var-dtype")?.textContent).toBe("int64");
    expect(doc.querySelector(".xr-var-preview")?.textContent).toBe("int64 (31593 = 31,593)");
    expect(doc.querySelector(".xr-var-data > pre")).toBeNull();
  });

  const raw = (values: Array<number | bigint>, kind: "i8" | "f8" | "f4"): Uint8Array => {
    const size = kind === "f4" ? 4 : 8;
    const out = new Uint8Array(values.length * size);
    const view = new DataView(out.buffer);
    values.forEach((v, i) => {
      if (kind === "f8") view.setFloat64(i * 8, Number(v), true);
      else if (kind === "f4") view.setFloat32(i * 4, Number(v), true);
      else view.setBigInt64(i * 8, BigInt(v), true);
    });
    return out;
  };
  const read = (
    values: Array<number | bigint>,
    kind: "i8" | "f8" | "f4",
    attrs: Record<string, unknown>,
    fill: unknown = null,
  ) => {
    serve({ "time/0": raw(values, kind) });
    return readTimeValues(
      STORE,
      { shape: [values.length], chunks: [values.length], dtype: "x", dims: ["time"], attrs },
      { path: "time", chunkPrefix: "", dtype: `<${kind}`, littleEndian: true, codecs: [], fill },
    );
  };

  it("unpacks scale_factor and add_offset before reading dates", async () => {
    const values = await read([0, 2, 4], "i8", {
      units: "days since 2000-01-01",
      scale_factor: 0.5,
      add_offset: 1,
    });
    expect(values?.preview).toBe("2000-01-02 ... 2000-01-04");
    const scaled = await read([0, 1, 2], "i8", {
      units: "days since 2000-01-01",
      scale_factor: 2,
      add_offset: 10,
    });
    expect(scaled?.preview).toBe("2000-01-11 ... 2000-01-15");
  });

  it("shows missing values as NaT: the array's fill_value, _FillValue and missing_value", async () => {
    const units = { units: "days since 2000-01-01" };
    expect((await read([-1, 1, 2], "i8", units, -1))?.preview).toBe("NaT ... 2000-01-03");
    expect((await read([0, 1, 2], "i8", units, 0))?.repr).toContain("'NaT', '2000-01-02");
    const fractional = await read([-999.5, 1.5, 2], "f8", { ...units, _FillValue: -999.5 });
    expect(fractional?.preview).toBe("NaT ... 2000-01-03");
    const missing = await read([1, -1, 2], "i8", { ...units, missing_value: [-1] });
    expect(missing?.repr).toContain("'2000-01-02T00:00:00.000000000', 'NaT'");
  });

  it("keeps the summary for a standard calendar counted from before 1582", async () => {
    expect(await read([182612], "i8", { units: "days since 1500-01-01" })).toBeNull();
    expect(
      await read([182612], "i8", { units: "days since 1582-10-04", calendar: "gregorian" }),
    ).toBeNull();
    const proleptic = await read([152385], "i8", {
      units: "days since 1582-10-04",
      calendar: "proleptic_gregorian",
    });
    expect(proleptic?.preview).toBe("1999-12-22");
  });

  it("reads large integers exactly, in any unit", async () => {
    const micro = await read([BigInt("4733596800000000")], "i8", {
      units: "microseconds since 1900-01-01",
    });
    expect(micro?.preview).toBe("2050-01-01");
    const nano = await read([BigInt("1700000000000000001")], "i8", {
      units: "nanoseconds since 1970-01-01",
    });
    expect(nano?.preview).toBe("2023-11-14T22:13:20.000000001");
    const near = await read([BigInt("9007199254740993")], "i8", {
      units: "nanoseconds since 1970-01-01",
    });
    expect(near?.preview).toBe("1970-04-15T05:59:59.254740993");
    const masked = await read(
      [BigInt("9007199254740991"), 1],
      "i8",
      { units: "nanoseconds since 1970-01-01" },
      9007199254740991,
    );
    expect(masked?.preview).toBe("NaT 1970-01-01T00:00:00.000000001");
  });

  it("matches a float fill value at the precision it is stored in", async () => {
    const values = await read([-999.9, 1, 2], "f4", { units: "days since 2000-01-01" }, -999.9);
    expect(values?.preview).toBe("NaT ... 2000-01-03");
  });

  it("falls back, never shows NaT, for a value outside datetime64[ns]", async () => {
    expect(
      await read([BigInt("4733596800000000000")], "i8", { units: "microseconds since 1900-01-01" }),
    ).toBeNull();
  });

  it("decodes each codec stage within its own bound: crc32c then zstd or gzip", async () => {
    for (const [name, id] of [
      ["crcZstd", "zstd"],
      ["crcGzip", "gzip"],
    ]) {
      serve({ "time/c/0": bytes(fixture.checks[name]) });
      const values = await readTimeValues(
        STORE,
        {
          shape: [3],
          chunks: [3],
          dtype: "int64",
          dims: ["time"],
          attrs: { units: "days since 2000-01-01" },
        },
        {
          path: "time",
          chunkPrefix: "c/",
          dtype: "int64",
          littleEndian: true,
          codecs: [{ id: "crc32c" }, { id }],
        },
      );
      expect(values?.preview).toBe("2000-01-01 ... 2000-01-03");
    }
  });

  it("stops at the deadline even when the caller's abort fires while reads start", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn(async (url: string) =>
      String(url).endsWith("/.zmetadata")
        ? ({ ok: true, status: 200, json: async () => ERA5 } as unknown as Response)
        : new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;
    const pending = loadZarrMetadataHtml(STORE, {
      injectCss: false,
      signal: controller.signal,
      getAuthHeaders: (url) => {
        if (url.endsWith(".zmetadata")) return {};
        controller.abort();
        return new Promise(() => undefined);
      },
    });
    await expect(pending).rejects.toThrow();
  });

  it("falls back when a large integer fill value cannot be compared exactly", async () => {
    const values = await read(
      [BigInt("1700000000000000000"), BigInt("1700000000000000001")],
      "i8",
      { units: "nanoseconds since 1970-01-01" },
      JSON.parse("1700000000000000001"),
    );
    expect(values).toBeNull();
  });

  it("truncates fractional nanoseconds toward zero, as xarray does", async () => {
    const days = await read([0.1234567891234567, 1], "f8", { units: "days since 2000-01-01" });
    expect(days?.preview).toBe("2000-01-01T02:57:46.666580266 2000-01-02");
    const halves = await read([0.5, 1.5], "f8", { units: "nanoseconds since 2000-01-01" });
    expect(halves?.repr).toContain(
      "'2000-01-01T00:00:00.000000000', '2000-01-01T00:00:00.000000001'",
    );
  });

  it("reads int64's NaT sentinel as NaT under CF units too", async () => {
    const values = await read([BigInt("-9223372036854775808"), 0, 1], "i8", {
      units: "nanoseconds since 2000-01-01",
    });
    expect(values?.preview).toBe("NaT ... 2000-01-01T00:00:00.000000001");
  });

  it("imports and shows the metadata where BigInt is missing, without the dates", async () => {
    vi.stubGlobal("BigInt", undefined);
    vi.resetModules();
    try {
      const fresh = await import("../src/zarr-metadata");
      const requested = serve({ "time/0": bytes(fixture.era5.first) });
      const html = await fresh.loadZarrMetadataHtml(STORE, { injectCss: false });
      const doc = new DOMParser().parseFromString(html, "text/html");
      expect(doc.querySelector(".xr-var-preview")?.textContent).toBe("int64 (31593 = 31,593)");
      expect(requested.filter((u) => !u.endsWith(".zmetadata"))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("does not hold the metadata back for a chunk that never answers", async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn(async (url: string) =>
        String(url).endsWith("/.zmetadata")
          ? ({ ok: true, status: 200, json: async () => ERA5 } as unknown as Response)
          : new Promise<Response>(() => undefined),
      ) as unknown as typeof fetch;
      const pending = loadZarrMetadataHtml(STORE, { injectCss: false });
      await vi.advanceTimersByTimeAsync(3_000);
      const doc = new DOMParser().parseFromString(await pending, "text/html");
      expect(doc.querySelector(".xr-var-preview")?.textContent).toBe("int64 (31593 = 31,593)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a calendar numpy cannot hold alone", async () => {
    const requested = serve({});
    const values = await readTimeValues(
      STORE,
      {
        shape: [10],
        chunks: [10],
        dtype: "int64",
        dims: ["time"],
        attrs: { units: "days since 2000-01-01", calendar: "360_day" },
      },
      { path: "time", chunkPrefix: "", dtype: "<i8", littleEndian: true, codecs: [] },
    );
    expect(values).toBeNull();
    expect(requested).toEqual([]);
  });
});
