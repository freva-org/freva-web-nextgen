/**
 * Which add-ons may be optional, and why it is a proof rather than a policy.
 *
 * "Make the failure non-fatal" is wrong for most add-ons: preparation MUTATES the interpreter, and
 * an error caught half way leaves a session holding some of a dependency closure and not the
 * capability it was for - a page that says Ready over an interpreter that cannot do what it
 * promises. So an add-on qualifies only when everything before the first mutation can fail on its
 * own. The rule is DERIVED from the pin, so adding a wheel removes optionality automatically.
 */

import { describe, expect, it } from "vitest";
import { ADDONS, ADDON_CATALOGUE, supportsOptional } from "../src/addons.js";
import { ADDON_PINS } from "../src/worker/addon-pins.generated.js";
import { createBrowserPython } from "../src/browser-python.js";

describe("supportsOptional", () => {
  it("is true exactly when preparation cannot mutate the interpreter before it fails", () => {
    for (const id of ADDONS) {
      const pin = ADDON_PINS[id]!;
      const canBeOptional = pin.wheels.length === 0 && pin.runtimePackages.length === 0;
      expect(supportsOptional(id), `${id}`).toBe(canBeOptional);
    }
  });

  it("says yes to the data add-on and no to the one that installs wheels", () => {
    // Named rather than derived here, because the two answers are the point and a reader should be
    // able to see them without running the loop above. Cartopy stages twelve files and sets one
    // environment variable; Dask installs three wheels through micropip.
    expect(supportsOptional("cartopy-natural-earth-110m")).toBe(true);
    expect(supportsOptional("dask")).toBe(false);
  });

  it("says no to anything that is not a curated add-on at all", () => {
    expect(supportsOptional("numpy")).toBe(false);
    expect(supportsOptional("")).toBe(false);
  });

  it("is published on the catalogue a build tool reads", () => {
    expect(ADDON_CATALOGUE["cartopy-natural-earth-110m"].optionalCapable).toBe(true);
    expect(ADDON_CATALOGUE.dask.optionalCapable).toBe(false);
  });
});

describe("the engine refuses an impossible optional configuration at construction", () => {
  it("refuses an add-on that installs wheels, with the reason", () => {
    expect(() =>
      createBrowserPython({
        profile: "xarray-zarr",
        addons: ["dask"],
        optionalAddons: ["dask"],
      }),
    ).toThrow(/cannot be optional/);
  });

  it("refuses one that is not in `addons`, because it is a statement about a configured add-on", () => {
    expect(() =>
      createBrowserPython({
        profile: "xarray-zarr",
        addons: ["dask"],
        optionalAddons: ["cartopy-natural-earth-110m"],
      }),
    ).toThrow(/in optionalAddons but not in addons/);
  });

  it("accepts the one that qualifies", () => {
    expect(() =>
      createBrowserPython({
        profile: "xarray-zarr",
        addons: ["cartopy-natural-earth-110m", "dask"],
        optionalAddons: ["cartopy-natural-earth-110m"],
      }),
    ).not.toThrow();
  });

  it("fails before a Worker is created, so a typo does not cost a runtime download", () => {
    // Checked HERE rather than only in the worker. The worker's own refusal is the enforcement
    // boundary, but reaching it means downloading a runtime first - a long way to travel to be told
    // a list has the wrong name in it.
    let created = 0;
    expect(() =>
      createBrowserPython({
        profile: "xarray-zarr",
        addons: ["dask"],
        optionalAddons: ["dask"],
        workerFactory: () => {
          created += 1;
          return {} as unknown as Worker;
        },
      }),
    ).toThrow();
    expect(created).toBe(0);
  });
});
