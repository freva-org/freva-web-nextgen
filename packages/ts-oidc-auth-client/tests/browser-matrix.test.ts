/**
 * Which browser engines the tooling installs and runs.
 *
 * Tooling only - nothing here touches authentication, storage, lifecycle or
 * protocol behaviour. The selector is a pure function over an explicit
 * `platform`, so every branch is testable from any host: these assertions run
 * identically on the Linux CI box and on the macOS laptop they describe.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_BROWSERS,
  MACOS_STRICT_MESSAGE,
  MACOS_WEBKIT_NOTE,
  StrictUnavailableError,
  parseBrowserOverride,
  selectBrowsers,
  selectInstallBrowsers,
} from "../browser-tests/browsers.mjs";

describe("macOS development omits WebKit", () => {
  it("runs Chromium and Firefox only", () => {
    const { browsers, notes } = selectBrowsers({ platform: "darwin" });
    expect(browsers).toEqual(["chromium", "firefox"]);
    expect(browsers).not.toContain("webkit");
    // Exactly one line, and it says why and where the full matrix runs.
    expect(notes).toEqual([MACOS_WEBKIT_NOTE]);
    expect(MACOS_WEBKIT_NOTE).toMatch(/macOS/);
    expect(MACOS_WEBKIT_NOTE).toMatch(/Linux CI|Docker/);
  });

  it("installs Chromium and Firefox only", () => {
    const { browsers, notes } = selectInstallBrowsers({ platform: "darwin" });
    expect(browsers).toEqual(["chromium", "firefox"]);
    expect(notes).toEqual([MACOS_WEBKIT_NOTE]);
  });
});

describe("Linux runs and installs the full matrix", () => {
  it("development selects all three", () => {
    const { browsers, notes } = selectBrowsers({ platform: "linux" });
    expect(browsers).toEqual([...ALL_BROWSERS]);
    expect(notes).toEqual([]);
  });

  it("installation selects all three", () => {
    expect(selectInstallBrowsers({ platform: "linux" }).browsers).toEqual([...ALL_BROWSERS]);
  });

  it("the release gate selects all three", () => {
    const { browsers } = selectBrowsers({ platform: "linux", strict: true });
    expect(browsers).toEqual([...ALL_BROWSERS]);
  });
});

describe("strict mode is the release contract", () => {
  it("refuses to run on macOS rather than pass with two engines", () => {
    let thrown: unknown;
    try {
      selectBrowsers({ platform: "darwin", strict: true });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(StrictUnavailableError);
    expect((thrown as Error).message).toBe(MACOS_STRICT_MESSAGE);
    // It must point somewhere the gate can actually run.
    expect(MACOS_STRICT_MESSAGE).toMatch(/Linux CI/);
    expect(MACOS_STRICT_MESSAGE).toMatch(/docker/i);
  });

  it("never yields a two-engine strict success on macOS, with or without an override", () => {
    for (const override of [undefined, "chromium,firefox", "chromium", "webkit"]) {
      expect(() => selectBrowsers({ platform: "darwin", strict: true, override })).toThrow(
        StrictUnavailableError,
      );
    }
  });

  it("ignores a narrowing BROWSERS override on a supported platform", () => {
    const { browsers, notes } = selectBrowsers({
      platform: "linux",
      strict: true,
      override: "chromium",
    });
    // A gate that reports "strict" while running one engine is exactly the
    // false evidence this refuses to produce.
    expect(browsers).toEqual([...ALL_BROWSERS]);
    expect(notes.join(" ")).toMatch(/ignored in strict mode/i);
  });
});

describe("BROWSERS overrides still work for debugging", () => {
  it("selects exactly what was asked for, on any platform", () => {
    expect(selectBrowsers({ platform: "darwin", override: "webkit" }).browsers).toEqual(["webkit"]);
    expect(selectBrowsers({ platform: "linux", override: "firefox,chromium" }).browsers).toEqual([
      "firefox",
      "chromium",
    ]);
    expect(selectInstallBrowsers({ platform: "darwin", override: "webkit" }).browsers).toEqual([
      "webkit",
    ]);
  });

  it("tolerates whitespace and duplicates, and ignores an empty value", () => {
    expect(parseBrowserOverride(" chromium , firefox ,chromium ")).toEqual(["chromium", "firefox"]);
    expect(parseBrowserOverride("")).toBeNull();
    expect(parseBrowserOverride("  ,  ")).toBeNull();
    expect(parseBrowserOverride(undefined)).toBeNull();
    // No override => the platform default, not an empty run.
    expect(selectBrowsers({ platform: "linux", override: "" }).browsers).toEqual([...ALL_BROWSERS]);
  });

  it("rejects an unknown engine instead of silently running nothing", () => {
    expect(() => parseBrowserOverride("chrome")).toThrow(/unknown engine/i);
    expect(() => selectBrowsers({ platform: "linux", override: "safari" })).toThrow(
      /unknown engine/i,
    );
  });
});
