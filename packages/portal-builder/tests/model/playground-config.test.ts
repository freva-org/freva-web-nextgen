// Two configuration questions the build answers rather than leaving to the browser.
//
// WHERE do the playground's static assets come from? "Beside the runtime" is right for a
// deployment that mirrors Pyodide and nonsense for one that does not: it resolves to
// `https://cdn.jsdelivr.net/pyodide/v314.0.6/freva-wheels/`, a directory on a host this project
// does not control, and a visitor gets a 403 with nothing said.
//
// WHICH add-ons may be missing without stopping the interpreter? With the answer "none", the
// registry's own order costs a portal Dask because its unused Cartopy data is missing - the
// capability nothing needed breaking the one everything needed.
//
// Both are decided from the configuration and both fail at build time with the key named. Every
// case below is one where carrying on silently is the alternative.

import { describe, expect, it } from "vitest";
import { DiagnosticBag } from "../../src/diagnostics.js";
import { resolvePlaygroundSettings } from "../../src/model/python-playground.js";
import { resolvePlaygroundAssets, runtimeIsDefaultCdn } from "../../src/model/playground-assets.js";
import type { RawPythonPlaygroundBase } from "../../src/config/types.js";
import type { PlaygroundSettings } from "../../src/model/types.js";

const WHERE = { file: "portal.yaml", pointer: "/pythonPlayground" };

function resolve(raw: Partial<RawPythonPlaygroundBase>): {
  settings: PlaygroundSettings | undefined;
  bag: DiagnosticBag;
} {
  const bag = new DiagnosticBag();
  const settings = resolvePlaygroundSettings(
    { enabled: true, profile: "xarray-zarr", ...raw } as RawPythonPlaygroundBase,
    WHERE,
    bag,
  );
  return { settings, bag };
}

function assets(
  settings: PlaygroundSettings,
  materialsIncorporated = false,
): { sources: ReturnType<typeof resolvePlaygroundAssets>; bag: DiagnosticBag } {
  const bag = new DiagnosticBag();
  const sources = resolvePlaygroundAssets({
    settings,
    materialsIncorporated,
    basePath: "/",
    file: "portal.yaml",
    pointer: "/pythonPlayground",
    bag,
  });
  return { sources, bag };
}

describe("1. required add-ons are unchanged", () => {
  it("keeps `addons: [dask]` required, with nothing optional", () => {
    // A plain `addons` list is REQUIRED, asserted rather than assumed: turning it into
    // best-effort behaviour silently downgrades every portal that writes one, so a page that
    // promises Dask would start without it and say nothing.
    const { settings, bag } = resolve({ addons: ["dask"] });
    expect(bag.errors).toEqual([]);
    expect(settings?.addons).toEqual(["dask"]);
    expect(settings?.optionalAddons).toEqual([]);
  });

  it("still refuses an unknown add-on, and one the profile cannot carry", () => {
    expect(resolve({ addons: ["numpy"] }).bag.errors[0]?.code).toBe("FP1219");
    expect(resolve({ profile: "minimal", addons: ["dask"] }).bag.errors[0]?.message).toContain(
      "does not work with the 'minimal' profile",
    );
  });
});

describe("2. optional add-ons", () => {
  it("accepts one that can be dropped without leaving a half-changed interpreter", () => {
    const { settings, bag } = resolve({
      addons: ["dask", "cartopy-natural-earth-110m"],
      optionalAddons: ["cartopy-natural-earth-110m"],
    });
    expect(bag.errors).toEqual([]);
    expect(settings?.addons).toEqual(["cartopy-natural-earth-110m", "dask"]);
    expect(settings?.optionalAddons).toEqual(["cartopy-natural-earth-110m"]);
  });

  it("refuses one that installs wheels, and says why rather than downgrading it", () => {
    // `dask` installs three wheels through micropip, and a failure on the second leaves a
    // session holding its dependency closure and not the capability, which nothing can undo in
    // a live interpreter. So this is an error rather than a quiet promotion to required: a
    // deployment that asked for best-effort Dask has decided what its pages may promise.
    const { bag } = resolve({ addons: ["dask"], optionalAddons: ["dask"] });
    const error = bag.errors[0];
    expect(error?.code).toBe("FP1219");
    expect(error?.message).toContain("cannot be optional");
    expect(error?.hint).toContain("installs wheels into the interpreter");
    expect(error?.hint).toContain("Keep 'dask' in addons");
  });

  it("refuses an optional add-on that is not configured at all", () => {
    const { bag } = resolve({
      addons: ["dask"],
      optionalAddons: ["cartopy-natural-earth-110m"],
    });
    expect(bag.errors[0]?.message).toContain("is in optionalAddons but not in addons");
  });

  it("refuses a duplicate inside optionalAddons", () => {
    const { bag } = resolve({
      addons: ["cartopy-natural-earth-110m"],
      optionalAddons: ["cartopy-natural-earth-110m", "cartopy-natural-earth-110m"],
    });
    expect(bag.errors.map((d) => d.message).join("\n")).toContain("listed twice in optionalAddons");
  });

  it("refuses an unknown id in optionalAddons", () => {
    const { bag } = resolve({ addons: ["dask"], optionalAddons: ["scipy"] });
    expect(bag.errors[0]?.message).toContain("is not a curated add-on");
  });
});

describe("3. where the assets come from", () => {
  it("refuses the sibling default when the runtime is the public CDN", () => {
    const { settings } = resolve({ profile: "freva-client", addons: ["dask"] });
    expect(runtimeIsDefaultCdn(settings!)).toBe(true);
    const { sources, bag } = assets(settings!);
    expect(sources.wheelhouse).toBeUndefined();
    expect(sources.addons).toBeUndefined();

    const codes = bag.errors.map((d) => d.code);
    expect(codes).toEqual(["FP1223", "FP1223"]);
    const text = bag.errors.map((d) => `${d.message} ${d.hint}`).join("\n");
    // The key a reader would edit, the exact URL that cannot work, and the way out.
    expect(text).toContain("pythonPlayground.wheelhouseUrl");
    expect(text).toContain("pythonPlayground.addonBaseUrl");
    expect(text).toContain("https://cdn.jsdelivr.net/pyodide/v314.0.6/freva-wheels/");
    expect(text).toContain("https://cdn.jsdelivr.net/pyodide/v314.0.6/python-addons/");
    expect(text).toContain("prepare-playground");
    // …and it says why the default is right somewhere else, so it does not read as a bug.
    expect(text).toContain("valid layout for a deployment that mirrors Pyodide");
  });

  it("allows the sibling default when the runtime is self-hosted", () => {
    // The convenience it exists for: copy the three directories together onto one origin and
    // configure one URL. It is only nonsense against a CDN.
    const { settings } = resolve({
      profile: "freva-client",
      addons: ["dask"],
      runtimeIndexUrl: "https://assets.example.org/pyodide/",
    });
    const { sources, bag } = assets(settings!);
    expect(bag.errors).toEqual([]);
    expect(sources.wheelhouse).toEqual({
      url: "https://assets.example.org/freva-wheels/",
      origin: "beside-runtime",
    });
    expect(sources.addons).toEqual({
      url: "https://assets.example.org/python-addons/",
      origin: "beside-runtime",
    });
  });

  it("keeps an explicit external URL, for a deployment that hosts them elsewhere on purpose", () => {
    const { settings } = resolve({
      profile: "freva-client",
      addons: ["dask"],
      wheelhouseUrl: "https://wheels.example.org/w/",
      addonBaseUrl: "https://addons.example.org/a/",
    });
    const { sources, bag } = assets(settings!);
    expect(bag.errors).toEqual([]);
    expect(sources.wheelhouse?.origin).toBe("configured");
    expect(sources.wheelhouse?.url).toBe("https://wheels.example.org/w/");
    expect(sources.addons?.url).toBe("https://addons.example.org/a/");
  });

  it("serves them from the artifact when this build was given materials", () => {
    const { settings } = resolve({ profile: "freva-client", addons: ["dask"] });
    const { sources, bag } = assets(settings!, true);
    expect(bag.errors).toEqual([]);
    // Root-relative: one artifact that is correct in a preview and in production alike.
    expect(sources.wheelhouse).toEqual({ url: "/freva-wheels/", origin: "artifact" });
    expect(sources.addons).toEqual({ url: "/python-addons/", origin: "artifact" });
  });

  it("asks for nothing an asset class this profile never fetches", () => {
    // No wheelhouse question at all on a profile that does not install the Freva client.
    const { settings } = resolve({ profile: "xarray-zarr" });
    const { sources, bag } = assets(settings!);
    expect(bag.errors).toEqual([]);
    expect(sources.wheelhouse).toBeUndefined();
    expect(sources.addons).toBeUndefined();
  });
});
