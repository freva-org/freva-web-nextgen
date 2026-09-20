/**
 * The protocol boundary: what may cross it, and what must not. The checks that do not need a
 * browser, about SHAPE rather than Python. The display validator gets most of the attention because
 * everything a consumer is handed as renderable came through it.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_DISPLAY_ENCODED_CHARS,
  MAX_DISPLAY_TEXT_CHARS,
  PROTOCOL_VERSION,
  createIdFactory,
  isDisplayEncoding,
  isDisplayMime,
  validateDisplay,
} from "../src/protocol.js";

describe("display validation", () => {
  const png = {
    mime: "image/png",
    encoding: "base64",
    data: "iVBORw0KGgo=",
  };

  it("accepts a well-formed PNG payload", () => {
    const result = validateDisplay(png);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mime).toBe("image/png");
  });

  it("accepts plain text as utf8", () => {
    expect(validateDisplay({ mime: "text/plain", encoding: "utf8", data: "hi" }).ok).toBe(true);
  });

  // The short allow-list is the point. `text/html` and `image/svg+xml` both carry script, and the
  // markup is authored by whatever Python the visitor typed. A consumer that only ever receives PNG
  // bytes and text cannot be talked into running anything.
  it.each(["text/html", "image/svg+xml", "application/javascript", "", null, 42])(
    "refuses %s",
    (mime) => {
      const result = validateDisplay({ mime, encoding: "utf8", data: "<script>x</script>" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/unsupported mime/);
    },
  );

  it("refuses an unknown encoding", () => {
    const result = validateDisplay({ mime: "text/plain", encoding: "hex", data: "6869" });
    expect(result.ok).toBe(false);
  });

  // A binary MIME arriving as text (or the reverse) is worse than a rejected payload: a consumer
  // branching on `mime` alone would hand raw bytes to a text node, or a text blob to an <img>.
  it("refuses image/png that claims to be utf8", () => {
    const result = validateDisplay({ mime: "image/png", encoding: "utf8", data: "not bytes" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/must be base64/);
  });

  it("refuses text/plain that claims to be base64", () => {
    const result = validateDisplay({ mime: "text/plain", encoding: "base64", data: "aGk=" });
    expect(result.ok).toBe(false);
  });

  it("refuses base64 that is not base64", () => {
    for (const data of ["not base64!", "aGk", "aGk=extra", "a G k="]) {
      expect(validateDisplay({ ...png, data }).ok, data).toBe(false);
    }
  });

  it("refuses data that is not a string at all", () => {
    expect(validateDisplay({ ...png, data: new Uint8Array([1, 2]) }).ok).toBe(false);
    expect(validateDisplay({ ...png, data: null }).ok).toBe(false);
  });

  it("refuses a non-object", () => {
    for (const value of [null, undefined, 7, "png", []]) {
      expect(validateDisplay(value).ok).toBe(false);
    }
  });

  it("keeps only numeric metadata, and drops the rest", () => {
    const result = validateDisplay({
      ...png,
      metadata: { figure: 1, width: 400, height: 300, evil: "<script>", nested: { a: 1 } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.metadata).toEqual({ figure: 1, width: 400, height: 300 });
  });

  it("omits metadata entirely when none of it is usable", () => {
    const result = validateDisplay({ ...png, metadata: { evil: "x" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.metadata).toBeUndefined();
  });

  it("does not copy unexpected top-level fields through", () => {
    const result = validateDisplay({ ...png, script: "alert(1)", __proto__: { polluted: true } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.value).sort()).toEqual(["data", "encoding", "mime"]);
  });
});

describe("mime guards", () => {
  it("names exactly the two supported types", () => {
    expect(isDisplayMime("image/png")).toBe(true);
    expect(isDisplayMime("text/plain")).toBe(true);
    expect(isDisplayMime("text/html")).toBe(false);
    expect(isDisplayMime(undefined)).toBe(false);
  });

  it("names exactly the two supported encodings", () => {
    expect(isDisplayEncoding("base64")).toBe(true);
    expect(isDisplayEncoding("utf8")).toBe(true);
    expect(isDisplayEncoding("utf-8")).toBe(false);
  });
});

describe("request ids", () => {
  // Correlation is what makes concurrency safe here - see protocol.ts. A duplicated id would settle
  // the wrong promise silently.
  it("never repeats", () => {
    const next = createIdFactory("req");
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) seen.add(next());
    expect(seen.size).toBe(10_000);
  });

  it("keeps two factories in separate namespaces", () => {
    const a = createIdFactory("req");
    const b = createIdFactory("exec");
    expect(a()).toBe("req-1");
    expect(b()).toBe("exec-1");
  });
});

it("declares a protocol version, so a stale worker is detected rather than misread", () => {
  expect(PROTOCOL_VERSION).toBeTypeOf("number");
  expect(PROTOCOL_VERSION).toBeGreaterThan(0);
});

// The base64 check, and the size at which a regex-based one stops working. `validateDisplay` is
// called on both sides of the worker boundary, so a throw inside it escapes the worker's request
// handler and is reported as a fatal - above about 4 MB, which a matplotlib figure at a large size
// and dpi reaches.
describe("base64 validation", () => {
  const png = (data: string) => validateDisplay({ mime: "image/png", encoding: "base64", data });

  it("accepts what Python's b64encode produces, padding included", () => {
    for (const value of ["", "QUJD", "QQ==", "QUJ=", "QUJD/+aa"]) {
      expect(png(value).ok, value).toBe(true);
    }
  });

  it("rejects anything that is not canonical", () => {
    // Whitespace, a length that is not a multiple of four, padding in the wrong place, and
    // characters outside the alphabet. Python never emits any of them.
    for (const value of ["QQ=", "A", "====", "QU J D", "QUJD\n", "QU=D", "QU@D"]) {
      expect(png(value).ok, value).toBe(false);
    }
  });

  it("does not blow the stack on a payload a real plot can produce", () => {
    // The regression: `/^(?:[A-Za-z0-9+/]{4})*…$/` recurses per repetition in V8, so 4 MB passed in
    // 81 ms and 8 MB threw `RangeError: Maximum call stack size exceeded`. This is that size.
    const eightMiB = "QUJD".repeat(2 * 1024 * 1024);
    expect(eightMiB.length).toBe(8 * 1024 * 1024);
    expect(() => png(eightMiB)).not.toThrow();
    expect(png(eightMiB).ok).toBe(true);
  });
});

// Size limits, enforced before anything expensive happens to the payload. Every representation of a
// large figure is alive at once on the way through - Python bytes, base64 text, its
// structured-clone copy, the decoded bytes, a Blob - so five copies of 40 MiB is 200 MiB for one
// plot.
describe("display payload limits", () => {
  it("accepts a figure of a size a person would actually produce", () => {
    // ~3 MiB of base64, roughly a 2.2 MiB PNG: a large but ordinary plot.
    const data = "QUJD".repeat(768 * 1024);
    expect(validateDisplay({ mime: "image/png", encoding: "base64", data }).ok).toBe(true);
  });

  it("refuses an image over the encoded-character ceiling, and says what to do", () => {
    const data = "QUJD".repeat(7 * 1024 * 1024); // 28 MiB of base64
    const result = validateDisplay({ mime: "image/png", encoding: "base64", data });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("MiB limit") });
    expect(result).toMatchObject({ error: expect.stringContaining("/workspace") });
  });

  it("counts a text/plain display against the TEXT budget, not the image one", () => {
    // A repr is not a figure. Sharing the image budget puts a whole DataFrame in the transcript as
    // one node - well under 18 MiB, and far past what any surface can render.
    const data = "x".repeat(MAX_DISPLAY_TEXT_CHARS + 1);
    expect(validateDisplay({ mime: "text/plain", encoding: "utf8", data }).ok).toBe(false);
    expect(
      validateDisplay({ mime: "text/plain", encoding: "utf8", data: "x".repeat(1024) }).ok,
    ).toBe(true);
  });

  it("checks the size BEFORE validating the base64", () => {
    // The order matters: an oversized payload must be refused without being scanned, or the
    // expensive path is taken anyway for exactly the inputs the limit exists to avoid.
    const invalidAndHuge = "!".repeat(MAX_DISPLAY_ENCODED_CHARS + 4);
    const result = validateDisplay({
      mime: "image/png",
      encoding: "base64",
      data: invalidAndHuge,
    });
    expect(result).toMatchObject({ error: expect.stringContaining("MiB limit") });
  });
});
