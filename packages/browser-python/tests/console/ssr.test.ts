/**
 * @vitest-environment node
 *
 * `@freva-org/browser-python/console` has to be importable where there is no DOM. Not
 * hypothetical: a Next.js or Astro page that renders a console imports the module on the server
 * first, and two things in it run at module-evaluation time and need a browser unless they are
 * stopped - the jQuery Terminal plugin, which measures a character cell against `document`, and
 * `class BrowserPythonConsole extends HTMLElement`, which needs the global to exist. Both throw,
 * with messages that name neither this package nor the import that caused it. The environment
 * here is `node` deliberately: under happy-dom this file would pass while asserting nothing.
 */
import { describe, expect, it } from "vitest";

describe("server-side rendering", () => {
  it("has no DOM, so the test means what it says", () => {
    expect(typeof document).toBe("undefined");
    expect(typeof HTMLElement).toBe("undefined");
  });

  it("imports without throwing", async () => {
    const api = await import("../../src/console/index.js");
    expect(typeof api.defineBrowserPythonConsole).toBe("function");
    expect(typeof api.BrowserPythonConsole).toBe("function");
    expect(api.DEFAULT_TAG_NAME).toBe("freva-python-console");
  });

  it("registers nothing - there is no registry to register with", async () => {
    const { defineBrowserPythonConsole } = await import("../../src/console/index.js");
    // Returns rather than throws, so a component's effect can call it unconditionally.
    expect(() => defineBrowserPythonConsole()).not.toThrow();
  });

  it("the history store works without a DOM, because it is not a DOM thing", async () => {
    const { HistoryStore } = await import("../../src/console/history-store.js");
    const store = new HistoryStore({ persistence: "memory" });
    store.add("x = 1");
    expect(store.previous("")?.value).toBe("x = 1");
  });

  // The engine's own entry point is what a headless host imports, and it must stay free of all of
  // this. If this ever fails, the entry-point split has leaked.
  it("the headless engine imports on a server too", async () => {
    const engine = await import("../../src/index.js");
    expect(typeof engine.createBrowserPython).toBe("function");
  });
});
