// `pythonPlayground.terminal.osControls: auto` - which window controls the playground draws.
import { describe, expect, it } from "vitest";
import { osControlsFor } from "../../client/components/os-controls-core.js";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const WIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe("osControls: auto", () => {
  it("reads each platform", () => {
    expect(osControlsFor("auto", { platform: "MacIntel", userAgent: MAC_UA })).toBe("mac");
    expect(osControlsFor("auto", { platform: "Win32", userAgent: WIN_UA })).toBe("windows");
    expect(osControlsFor("auto", { platform: "Linux x86_64", userAgent: "X11; Linux" })).toBe(
      "linux",
    );
  });

  it("follows DevTools' user-agent override, which leaves navigator.platform alone", () => {
    const overridden = {
      userAgentData: { platform: "Windows" },
      platform: "MacIntel",
      userAgent: WIN_UA,
    };
    expect(osControlsFor("auto", overridden)).toBe("windows");
    expect(osControlsFor("auto", { ...overridden, userAgentData: { platform: "Linux" } })).toBe(
      "linux",
    );
  });

  it("falls back to the user-agent string, then to linux", () => {
    expect(osControlsFor("auto", { userAgent: WIN_UA })).toBe("windows");
    expect(osControlsFor("auto", {})).toBe("linux");
  });

  it("a fixed value is what the portal said, whatever the browser is", () => {
    expect(osControlsFor("windows", { platform: "MacIntel" })).toBe("windows");
  });
});
