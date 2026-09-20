/**
 * What the console will and will not render from a filename it did not choose. Every name in the
 * workspace was chosen by Python, and Python here is whatever the visitor typed or pasted, so the
 * extension is a hint about presentation and never a fact about content.
 */
import { describe, expect, it } from "vitest";

import {
  isActiveMime,
  mimeForName,
  previewKind,
  previewRefusal,
  safeBlobType,
} from "../src/artifact-mime.js";

describe("naming", () => {
  it("maps the extensions a scientific session produces", () => {
    expect(mimeForName("surface_wind.nc")).toBe("application/x-netcdf");
    expect(mimeForName("out/table.parquet")).toBe("application/vnd.apache.parquet");
    expect(mimeForName("plot.PNG")).toBe("image/png");
  });

  it("falls back to octet-stream rather than guessing", () => {
    expect(mimeForName("dump")).toBe("application/octet-stream");
    expect(mimeForName("archive.tar.zst")).toBe("application/octet-stream");
  });
});

describe("preview is an allowlist", () => {
  it("shows the data formats a person wants to glance at", () => {
    expect(previewKind("text/csv")).toBe("text");
    expect(previewKind("application/json")).toBe("text");
    expect(previewKind("image/png")).toBe("img");
    expect(previewKind("audio/wav")).toBe("audio");
    expect(previewKind("video/webm")).toBe("video");
  });

  it("refuses HTML and SVG, which the previous prefix test admitted", () => {
    // The two a family test gets wrong: `mime.startsWith("text/")` admits `text/html`, and
    // `mime.startsWith("image/")` admits `image/svg+xml`, an XML document with `<script>` in its
    // grammar that renders in an `<img>`. Both would put visitor-authored markup inside the
    // console's shadow root, on the host's origin.
    expect(previewKind("text/html")).toBe("none");
    expect(previewKind("image/svg+xml")).toBe("none");
    expect(previewKind("application/xhtml+xml")).toBe("none");
  });

  it("refuses anything it has not been told about, rather than trying", () => {
    expect(previewKind("application/x-netcdf")).toBe("none");
    expect(previewKind("text/vnd.something-new")).toBe("none");
    expect(previewKind("")).toBe("none");
  });

  it("says WHY for an active type, and merely what for the rest", () => {
    // "No preview" reads like a missing feature. For HTML it is a decision, and saying so is the
    // difference between a visitor filing a bug and a visitor clicking Download.
    expect(previewRefusal("text/html")).toMatch(/scripts/);
    expect(previewRefusal("text/html")).toMatch(/origin/);
    expect(previewRefusal("application/x-netcdf")).toMatch(/^No preview/);
  });
});

describe("blob types", () => {
  it("neutralises active types, and leaves data types alone", () => {
    // A blob URL is same-origin: a `text/html` blob is one accidental navigation away from being a
    // page on the host's origin, authored by whatever Python wrote.
    expect(safeBlobType("text/html")).toBe("application/octet-stream");
    expect(safeBlobType("image/svg+xml")).toBe("application/octet-stream");
    expect(safeBlobType("application/pdf")).toBe("application/octet-stream");
    expect(safeBlobType("text/csv")).toBe("text/csv");
    expect(safeBlobType("image/png")).toBe("image/png");
  });

  it("agrees with `isActiveMime`, so the two lists cannot drift apart", () => {
    for (const mime of ["text/html", "image/svg+xml", "application/xml", "application/pdf"]) {
      expect(isActiveMime(mime)).toBe(true);
      expect(safeBlobType(mime)).toBe("application/octet-stream");
      expect(previewKind(mime)).toBe("none");
    }
  });
});
