/**
 * The curated add-on registry as DATA: pins, catalogue, and the directory the CLI prepares.
 * Nothing here starts an interpreter - `browser-tests/addons.mjs` does that, in a real browser,
 * against the real runtime. What these check is the part a browser cannot: that the pin file, the
 * generated constant the Worker ships with, the exported catalogue a portal builder validates
 * against, and the planner the CLI downloads from are one description rather than four.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADDON_CATALOGUE, ADDONS, PROFILES, addonProfiles, isAddon } from "../src/addons.js";
import { ADDON_PINS } from "../src/worker/addon-pins.generated.js";
import { plannedAddons, plannedArtifacts, verifyAddons } from "../bin/freva-addons.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const PINS = JSON.parse(readFileSync(join(PKG, "bin", "freva-addons.json"), "utf8")) as {
  addons: Record<string, { profiles: string[]; wheels: unknown[]; data: unknown[] }>;
};

describe("the catalogue is the pin file", () => {
  it("offers exactly the add-ons that are pinned, sorted", () => {
    expect([...ADDONS]).toEqual(Object.keys(PINS.addons).sort());
    expect([...ADDONS]).toEqual([...ADDONS].sort());
  });

  it("is a CLOSED set: a plausible package name is not an add-on", () => {
    expect(isAddon("dask")).toBe(true);
    expect(isAddon("cartopy-natural-earth-110m")).toBe(true);
    for (const impostor of [
      "numpy",
      "dask[array]",
      "distributed",
      "cartopy",
      "",
      "DASK",
      "../dask",
    ]) {
      expect(isAddon(impostor)).toBe(false);
    }
  });

  it("names only profiles this package actually has", () => {
    for (const id of ADDONS) {
      expect(addonProfiles(id).length).toBeGreaterThan(0);
      for (const profile of addonProfiles(id)) expect(PROFILES).toContain(profile);
    }
  });

  it("keeps Dask off the profiles that carry no xarray, and says so in data", () => {
    // The contract is xarray's Dask-backed path, so a profile with no xarray cannot honour it.
    expect([...addonProfiles("dask")]).toEqual(["xarray-zarr", "freva-client"]);
    expect([...addonProfiles("cartopy-natural-earth-110m")]).toEqual([
      "minimal",
      "xarray-zarr",
      "freva-client",
    ]);
  });

  it("carries provenance for data this project did not author", () => {
    const dataset = ADDON_CATALOGUE["cartopy-natural-earth-110m"].dataset;
    expect(dataset).toBeDefined();
    expect(dataset?.name).toBe("Natural Earth vector");
    expect(dataset?.release).toBe("5.1.2");
    expect(dataset?.licence.toLowerCase()).toContain("public domain");
    expect(dataset?.attribution).toContain("Natural Earth");
    // Dask ships wheels, not data, so it has no dataset block to fill in.
    expect(ADDON_CATALOGUE.dask.dataset).toBeUndefined();
  });

  it("exposes no URL, digest or installer through the catalogue", () => {
    const serialised = JSON.stringify(ADDON_CATALOGUE);
    expect(serialised).not.toMatch(/https:\/\/files\.pythonhosted\.org/);
    expect(serialised).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("the pins", () => {
  it("mirror only the three packages the pinned runtime does not carry", () => {
    expect(ADDON_PINS.dask.wheels.map((wheel) => wheel.name)).toEqual(["locket", "partd", "dask"]);
    // Install order is dependency-first: partd imports locket, dask imports partd.
    expect(ADDON_PINS.dask.wheels.map((wheel) => wheel.file)).toEqual([
      "locket-1.0.0-py2.py3-none-any.whl",
      "partd-1.4.2-py3-none-any.whl",
      "dask-2026.8.0-py3-none-any.whl",
    ]);
  });

  // PURE PYTHON, and nothing else. A compiled wheel is built against one Emscripten ABI, and
  // micropip refuses it outright at start when the pinned Pyodide exposes another - with a
  // message naming Emscripten versions that appear nowhere in this repository. Every mirrored
  // add-on wheel is therefore pure Python; a compiled dependency comes from the runtime's own
  // lock, which is built against the same ABI as the interpreter, or it does not come at all.
  it("mirrors pure-Python wheels only", () => {
    const PURE_PYTHON = /-(?:py2\.)?py3-none-any\.whl$/;
    for (const id of ADDONS) {
      for (const wheel of ADDON_PINS[id].wheels) {
        expect(
          PURE_PYTHON.test(wheel.file),
          `${id}/${wheel.file}: not pure Python. A compiled wheel is built for one Emscripten ` +
            `ABI and is refused outright when the pinned Pyodide exposes another.`,
        ).toBe(true);
      }
    }
  });

  it("takes Dask's other dependencies from the runtime's own lock rather than re-hosting them", () => {
    // The list, not the lock. No unit test in this package may read `.runtime` - a generated
    // distribution is not a fixture, and `freva-closure.test.ts` enforces that. Whether these six
    // are really in the pinned lock and the mirrored three really are not is checked where it can
    // be checked honestly: `browser-tests/addons.mjs` loads them from the real runtime.
    expect([...ADDON_PINS.dask.runtimePackages]).toEqual([
      "toolz",
      "cloudpickle",
      "click",
      "packaging",
      "pyyaml",
      "fsspec",
    ]);
    // Nothing is both mirrored and taken from the lock: that would be two copies of one package.
    const mirrored = ADDON_PINS.dask.wheels.map((wheel) => wheel.name);
    for (const name of ADDON_PINS.dask.runtimePackages) expect(mirrored).not.toContain(name);
  });

  it("stages Natural Earth under the layout Cartopy looks in, with the whole shapefile set", () => {
    const paths = ADDON_PINS["cartopy-natural-earth-110m"].data.map((file) => file.path);
    for (const stem of [
      "shapefiles/natural_earth/physical/ne_110m_coastline",
      "shapefiles/natural_earth/cultural/ne_110m_admin_0_boundary_lines_land",
    ]) {
      // .shp alone is not a shapefile: the index and the attribute table are part of it.
      for (const extension of [".shp", ".shx", ".dbf", ".prj", ".cpg"]) {
        expect(paths).toContain(`${stem}${extension}`);
      }
    }
    expect(paths).toContain("LICENSE.md");
  });

  it("pins every artefact by digest, size and source", () => {
    for (const artifact of plannedAddons()) {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.bytes).toBeGreaterThan(0);
      expect(artifact.url).toMatch(/^https:\/\//);
    }
  });

  it("never names PyPI's simple index or Natural Earth's download host", () => {
    const sources = plannedAddons().map((artifact) => new URL(artifact.url).host);
    expect(sources).not.toContain("pypi.org");
    expect(sources).not.toContain("naturalearth.s3.amazonaws.com");
    expect(sources).not.toContain("naciscdn.org");
  });

  it("keeps the generated module in step with the pin file", () => {
    // `--check` is the same gate CI runs; a stale generated constant is a digest that lies.
    execFileSync(process.execPath, [join(PKG, "scripts", "gen-addon-pins.mjs"), "--check"], {
      stdio: "pipe",
    });
  });
});

describe("verifying a prepared directory", () => {
  it("reports every planned artefact as missing when there is nothing there", () => {
    const problems = verifyAddons(join(PKG, "tests", "fixtures", "not-a-directory"), ["dask"]);
    expect(problems.length).toBe(plannedArtifacts("dask").length + 1); // + the manifest
    expect(problems.every((problem: string) => problem.startsWith("missing:"))).toBe(true);
  });
});
