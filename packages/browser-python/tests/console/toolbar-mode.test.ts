/**
 * @vitest-environment happy-dom
 *
 * How `toolbar` and `hide-toolbar` resolve, without building a console to find out. The element
 * is not mounted here on purpose: building one instantiates the jQuery Terminal surface, which
 * needs real layout and is exercised in `browser-tests/console-lifecycle.mjs` against a real
 * browser. What is pinned down here is the logic that turns two attributes into one answer.
 */
import { describe, expect, it } from "vitest";
import { BrowserPythonConsole } from "../../src/console/browser-python-console.js";

const TAG = "toolbar-mode-console";
if (!customElements.get(TAG)) customElements.define(TAG, BrowserPythonConsole);

/** An element that exists but has never been connected, so nothing is built. */
const make = (attributes: Record<string, string> = {}): BrowserPythonConsole => {
  const element = document.createElement(TAG) as BrowserPythonConsole;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
};

describe("toolbarMode", () => {
  it("is `full` when nothing says otherwise", () => {
    expect(make().toolbarMode).toBe("full");
    expect(make().hideToolbar).toBe(false);
  });

  it("reads the three documented values, and ignores anything else", () => {
    expect(make({ toolbar: "full" }).toolbarMode).toBe("full");
    expect(make({ toolbar: "status" }).toolbarMode).toBe("status");
    expect(make({ toolbar: "none" }).toolbarMode).toBe("none");
    // A value nobody defined falls back rather than drawing something nobody meant.
    expect(make({ toolbar: "compact" }).toolbarMode).toBe("full");
    expect(make({ toolbar: "" }).toolbarMode).toBe("full");
  });

  it("keeps `hide-toolbar` meaning exactly `none`", () => {
    const legacy = make({ "hide-toolbar": "" });
    expect(legacy.toolbarMode).toBe("none");
    expect(legacy.hideToolbar).toBe(true);
  });

  it("lets the explicit attribute win, because it is the more specific statement", () => {
    const both = make({ "hide-toolbar": "", toolbar: "status" });
    expect(both.toolbarMode).toBe("status");
    // …and `hideToolbar` follows the resolved answer rather than the attribute it is named after.
    expect(both.hideToolbar).toBe(false);
  });

  it("round-trips through the property, for a host that already used it", () => {
    const element = make();
    element.hideToolbar = true;
    expect(element.getAttribute("toolbar")).toBe("none");
    element.hideToolbar = false;
    expect(element.getAttribute("toolbar")).toBe("full");
    element.toolbarMode = "status";
    expect(element.hideToolbar).toBe(false);
    expect(element.toolbarMode).toBe("status");
  });
});
