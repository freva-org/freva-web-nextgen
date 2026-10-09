// The pure pieces: settings, offsets, notebook validation, defaults and the eval-free validator.
import { describe, expect, it, vi } from "vitest";

import { kernelName, portalBaseSource, readSettings } from "../src/config.js";
import { MAX_NOTEBOOK_BYTES, notebookProblems, parseNotebook } from "../src/ipynb.js";
import { codePointsToUtf16, utf16ToCodePoints } from "../src/offsets.js";
import { InterpretingSchemaValidator, applyDefaults } from "../src/schema.js";

describe("readSettings", () => {
  it("keeps valid setups, drops unknown profiles, add-ons and duplicate ids", () => {
    const s = readSettings({
      runtimeIndexUrl: "https://runtime.example/pyodide/",
      setups: [
        {
          id: "xz",
          profile: "xarray-zarr",
          addons: ["dask", "nope", "dask"],
          optionalAddons: ["dask"],
        },
        { id: "xz", profile: "minimal" },
        { id: "bad", profile: "conda" },
        { id: "Bad Id", profile: "minimal" },
      ],
      maxLiveInterpreters: 9,
      interruptGraceMs: 10,
    });
    expect(s.setups).toHaveLength(1);
    expect(s.setups[0]).toMatchObject({ id: "xz", addons: ["dask"], optionalAddons: ["dask"] });
    expect(s.maxLiveInterpreters).toBe(2);
    expect(s.interruptGraceMs).toBe(3000);
    expect(s.runtimeIndexUrl).toBe("https://runtime.example/pyodide/");
  });

  it("falls back to one minimal setup and refuses non-http URLs", () => {
    const s = readSettings({ runtimeIndexUrl: "javascript:alert(1)" });
    expect(s.setups).toEqual([
      {
        id: "default",
        label: "minimal",
        profile: "minimal",
        addons: [],
        optionalAddons: [],
        runStarter: false,
      },
    ]);
    expect(s.starter).toBeUndefined();
    expect(readSettings({ starter: "import xarray" }).starter).toBe("import xarray");
    expect(readSettings({ starter: "x".repeat(5000) }).starter).toBeUndefined();
    expect(s.runtimeIndexUrl).toBeUndefined();
    expect(readSettings(null).maxLiveInterpreters).toBe(2);
  });

  it("reads the portal's base URL against the page, and defines it as a Python string", () => {
    const page = "https://p.example/showroom/notebook/lab/index.html";
    vi.stubGlobal("location", new URL(page));
    try {
      expect(readSettings({ portalBaseUrl: "/showroom/" }).portalBaseUrl).toBe(
        "https://p.example/showroom/",
      );
      expect(readSettings({ portalBaseUrl: "https://portal.example/a b/" }).portalBaseUrl).toBe(
        "https://portal.example/a%20b/",
      );
      for (const bad of ["javascript:alert(1)", "", 3, "data:text/plain,x"]) {
        expect(readSettings({ portalBaseUrl: bad }).portalBaseUrl).toBeUndefined();
      }
    } finally {
      vi.unstubAllGlobals();
    }
    const href = new URL('https://p.example/x"y\\z/?q=\\é').href;
    expect(portalBaseSource(href)).toBe(`PORTAL_BASE_URL = ${JSON.stringify(href)}`);
    expect(href).toMatch(/^[\x21-\x7e]+$/);
  });

  it("names the first setup freva-python and the others by id", () => {
    const setup = {
      id: "minimal",
      label: "m",
      profile: "minimal" as const,
      addons: [],
      optionalAddons: [],
      runStarter: false,
    };
    expect(kernelName(setup, 0)).toBe("freva-python");
    expect(kernelName(setup, 1)).toBe("freva-python-minimal");
  });
});

describe("offsets", () => {
  const text = "a😀b€c";
  it("maps code points to UTF-16 and back across astral characters", () => {
    expect(codePointsToUtf16(text, 2)).toBe(3);
    expect(codePointsToUtf16(text, 5)).toBe(6);
    expect(utf16ToCodePoints(text, 3)).toBe(2);
    expect(utf16ToCodePoints(text, 6)).toBe(5);
  });
  it("clamps to the text", () => {
    expect(codePointsToUtf16(text, 99)).toBe(text.length);
    expect(utf16ToCodePoints(text, 99)).toBe(5);
  });
});

describe("notebook validation", () => {
  const ok = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{ cell_type: "code", id: "a", source: ["x"], outputs: [] }],
  };
  it("accepts nbformat 4 with well-formed cells", () => {
    expect(notebookProblems(ok)).toEqual([]);
    expect(parseNotebook(JSON.stringify(ok))).toMatchObject({ nbformat: 4 });
  });
  it("names what is wrong", () => {
    expect(notebookProblems({ ...ok, nbformat: 3 })[0]).toMatch(/nbformat 3/);
    const bad = {
      ...ok,
      cells: [
        { cell_type: "javascript", source: 42 },
        { cell_type: "code", id: "a", source: "" },
        { cell_type: "code", id: "a", source: "" },
      ],
    };
    const problems = notebookProblems(bad).join("; ");
    expect(problems).toMatch(/unknown type/);
    expect(problems).toMatch(/no text source/);
    expect(problems).toMatch(/repeats the id a/);
    expect(() => parseNotebook("{")).toThrow(/not JSON/);
    expect(() => parseNotebook("[]")).toThrow(/not a JSON object/);
  });
  it("refuses an oversized notebook before parsing it", () => {
    expect(notebookProblems(null, MAX_NOTEBOOK_BYTES + 1)[0]).toMatch(/over the/);
  });
});

describe("eval-free settings validation", () => {
  const schema = {
    type: "object",
    definitions: {
      item: { type: "object", properties: { on: { type: "boolean", default: true } } },
    },
    properties: {
      theme: { type: "string", default: "light" },
      nested: {
        type: "object",
        default: {},
        properties: { size: { type: "number", default: 13 } },
      },
      items: { type: "array", items: { $ref: "#/definitions/item" }, default: [] },
      ref: { $ref: "#/definitions/item" },
      choice: { oneOf: [{ type: "object", properties: { x: { default: 1 } } }] },
    },
  };

  it("fills defaults where Ajv's useDefaults would", () => {
    const data: Record<string, unknown> = { items: [{}], ref: {}, choice: {} };
    applyDefaults(schema, schema, data);
    expect(data).toEqual({
      theme: "light",
      nested: { size: 13 },
      items: [{ on: true }],
      ref: { on: true },
      choice: {},
    });
  });

  it("validates without generating code, and reports errors in the registry's shape", () => {
    const validator = new InterpretingSchemaValidator();
    const plugin = {
      id: "p",
      schema,
      raw: "{ // comment\n theme: 3 }",
      data: { composite: {}, user: {} },
      version: "1",
    };
    const errors = validator.validateData(plugin as never);
    expect(errors?.some((e) => e.keyword === "type")).toBe(true);
    plugin.raw = '{ "theme": "dark" }';
    expect(validator.validateData(plugin as never)).toBeNull();
    expect(plugin.data.composite).toMatchObject({ theme: "dark", nested: { size: 13 } });
    expect(plugin.data.user).toEqual({ theme: "dark" });
    plugin.raw = "{ nope";
    expect(validator.validateData(plugin as never)?.[0]?.keyword).toBe("syntax");
    expect(
      validator.validateData({ ...plugin, schema: { type: "array" } } as never)?.[0]?.keyword,
    ).toBe("schema");
  });

  it("never calls Function or eval", () => {
    const original = globalThis.Function;
    const trap = new Proxy(original, {
      construct() {
        throw new Error("Function constructor used");
      },
      apply() {
        throw new Error("Function called");
      },
    });
    globalThis.Function = trap as FunctionConstructor;
    try {
      const plugin = {
        id: "q",
        schema,
        raw: "{}",
        data: { composite: {}, user: {} },
        version: "1",
      };
      expect(new InterpretingSchemaValidator().validateData(plugin as never)).toBeNull();
    } finally {
      globalThis.Function = original;
    }
  });
});

describe("portal theme", () => {
  it("reads a theme from the URL and from the portal's message, and nothing else", async () => {
    const { themeFromMessage, themeFromUrl } = await import("../src/theme-sync.js");
    expect(themeFromUrl("https://p.example/notebook/lab/?theme=dark")).toBe("dark");
    expect(themeFromUrl("https://p.example/notebook/lab/?theme=light")).toBe("light");
    expect(themeFromUrl("https://p.example/notebook/lab/?theme=solarized")).toBeNull();
    expect(themeFromUrl("https://p.example/notebook/lab/")).toBeNull();
    expect(themeFromMessage({ type: "freva-portal-theme", mode: "dark" })).toBe("dark");
    expect(themeFromMessage({ type: "freva-portal-theme", mode: "blue" })).toBeNull();
    expect(themeFromMessage({ type: "other", mode: "dark" })).toBeNull();
    expect(themeFromMessage(null)).toBeNull();
  });

  /** A theme manager whose switches the test finishes: loaded, failed, or never. */
  const fakeThemes = (initial: string) => {
    const slots: ((sender: unknown, args: { newValue: unknown }) => void)[] = [];
    const calls: { name: string; resolve: () => void; reject: (e: Error) => void }[] = [];
    const target = {
      theme: initial as string | null,
      setTheme: (name: string) =>
        new Promise<void>((resolve, reject) => calls.push({ name, resolve, reject })),
      themeChanged: { connect: (slot: (typeof slots)[number]) => slots.push(slot) },
      /** The app now has `name` (a switch loaded, or someone changed it in the notebook). */
      change(name: string) {
        target.theme = name;
        for (const slot of slots) slot(target, { newValue: name });
      },
    };
    return { target, calls };
  };
  const flush = () => new Promise((done) => setTimeout(done, 0));

  it("switches once for repeated requests, then follows a different one", async () => {
    const { followTheme } = await import("../src/theme-sync.js");
    const { target, calls } = fakeThemes("light");
    const follow = followTheme(target);
    follow("light");
    expect(calls).toHaveLength(0);
    follow("dark");
    follow("dark"); // the frame's load and the notebook's ready both tell it
    expect(calls.map((c) => c.name)).toEqual(["dark"]);
    follow("light"); // asked while switching: applied once the switch is over
    calls[0]!.resolve();
    await flush();
    expect(calls).toHaveLength(1);
    target.change("dark");
    expect(calls.map((c) => c.name)).toEqual(["dark", "light"]);
  });

  it("applies a repeated request after a failed switch or a change made in the notebook", async () => {
    vi.useFakeTimers();
    try {
      const { followTheme, THEME_SWITCH_LIMIT_MS } = await import("../src/theme-sync.js");
      const { target, calls } = fakeThemes("light");
      const follow = followTheme(target);
      // Saving fails.
      follow("dark");
      calls[0]!.reject(new Error("settings"));
      await vi.advanceTimersByTimeAsync(0);
      follow("dark");
      expect(calls.map((c) => c.name)).toEqual(["dark", "dark"]);
      // Saved, but the theme never loads (JupyterLab shows its error and keeps the old one).
      calls[1]!.resolve();
      await vi.advanceTimersByTimeAsync(THEME_SWITCH_LIMIT_MS);
      follow("dark");
      expect(calls.map((c) => c.name)).toEqual(["dark", "dark", "dark"]);
      // It loads; then someone picks Light in the notebook, and the portal says dark again.
      calls[2]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      target.change("dark");
      follow("dark");
      expect(calls).toHaveLength(3);
      target.change("light");
      follow("dark");
      expect(calls.map((c) => c.name)).toEqual(["dark", "dark", "dark", "dark"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Escape in a framed notebook", () => {
  it("reaches the framing page only when nothing in the notebook used it", async () => {
    const { relayUnhandledEscape } = await import("../src/theme-sync.js");
    const listeners: ((event: { key: string; defaultPrevented: boolean }) => void)[] = [];
    const sent: [unknown, string][] = [];
    const framed = {
      parent: { postMessage: (data: unknown, origin: string) => sent.push([data, origin]) },
      location: { origin: "https://p.example" },
      addEventListener: (type: string, listener: (typeof listeners)[number]) => {
        if (type === "keydown") listeners.push(listener);
      },
    } as unknown as Window;
    relayUnhandledEscape(framed);
    expect(listeners).toHaveLength(1);
    listeners[0]!({ key: "Escape", defaultPrevented: true });
    listeners[0]!({ key: "Enter", defaultPrevented: false });
    expect(sent).toEqual([]);
    listeners[0]!({ key: "Escape", defaultPrevented: false });
    expect(sent).toEqual([[{ type: "freva-lab-escape" }, "https://p.example"]]);
    const top = { addEventListener: () => listeners.push(() => undefined) } as unknown as Window & {
      parent: Window;
    };
    top.parent = top;
    relayUnhandledEscape(top);
    expect(listeners).toHaveLength(1);
  });
});
