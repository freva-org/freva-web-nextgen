// The pure pieces: settings, offsets, notebook validation, defaults and the eval-free validator.
import { describe, expect, it } from "vitest";

import { kernelName, readSettings } from "../src/config.js";
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
});
