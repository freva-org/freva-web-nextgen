// Which browser a visitor has, for the advice on the no-JSPI card. Never for capability: whether
// JSPI is present is detected in the worker.
import { describe, expect, it } from "vitest";
import { describeBrowser, JSPI_MINIMUM } from "../src/notices.js";

const UA = {
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15",
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0",
  opera:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 OPR/120.0.0.0",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1",
  ipadAsMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15",
};

describe("describeBrowser", () => {
  it("reads name, version and the first version with JSPI", () => {
    expect(describeBrowser({ userAgent: UA.safariMac })).toMatchObject({
      id: "safari",
      version: "26.2",
      major: 26,
      minimum: 27,
      apple: "mac",
    });
    expect(describeBrowser({ userAgent: UA.chrome })).toMatchObject({ id: "chrome", major: 136 });
    expect(describeBrowser({ userAgent: UA.firefox })).toMatchObject({
      id: "firefox",
      minimum: 153,
    });
  });

  it("tells Edge and Opera from the Chrome and Safari they also claim to be", () => {
    expect(describeBrowser({ userAgent: UA.edge })).toMatchObject({ id: "edge", minimum: 137 });
    expect(describeBrowser({ userAgent: UA.opera })).toMatchObject({ id: "opera", minimum: 121 });
  });

  it("gives no browser minimum on iPhone and iPad, where every browser is Safari's engine", () => {
    expect(describeBrowser({ userAgent: UA.chromeIphone })).toMatchObject({
      id: "chrome",
      minimum: null,
      apple: "ios",
    });
    // An iPad asks for desktop sites as a Mac; its touch points give it away.
    expect(describeBrowser({ userAgent: UA.ipadAsMac, maxTouchPoints: 5 }).apple).toBe("ios");
  });

  it("admits a browser it does not know", () => {
    expect(describeBrowser({ userAgent: "curl/8.0" })).toMatchObject({
      id: "other",
      minimum: null,
    });
  });

  it("matches the versions the plain message names", () => {
    expect(JSPI_MINIMUM).toEqual({ chrome: 137, edge: 137, opera: 121, firefox: 153, safari: 27 });
  });
});
