/**
 * `collapsePackageErrors`, the one reshaping this package does to the runtime's stderr. The input
 * is verbatim Pyodide, captured from a console whose runtime directory held no wheels:
 * `PyodideConsole` loads packages from inside Python, so the failures arrive concatenated with no
 * separator between one message and the next lead-in.
 */
import { describe, expect, it } from "vitest";
import {
  collapsePackageErrors,
  filterPackageNotes,
  loadProfilePackages,
} from "../src/worker/pyodide-runtime.js";

/** What a wheel-less `import xarray` actually produced. Not paraphrased. */
const RUN_ON =
  "The following error occurred while loading numpy:Failed to fetch" +
  "The following error occurred while loading xarray:Failed to fetch" +
  "The following error occurred while loading packaging:Failed to fetch" +
  "The following error occurred while loading pandas:Failed to fetch";

describe("collapsePackageErrors", () => {
  it("names every package once, and the reason once", () => {
    expect(collapsePackageErrors(RUN_ON)).toBe(
      "Could not download numpy, xarray, packaging, pandas: Failed to fetch\n",
    );
  });

  it("keeps distinct reasons rather than collapsing them into the first", () => {
    const mixed =
      "The following error occurred while loading numpy:Failed to fetch" +
      "The following error occurred while loading zarr:integrity check failed";
    expect(collapsePackageErrors(mixed)).toBe(
      "Could not download numpy, zarr: Failed to fetch; integrity check failed\n",
    );
  });

  it("handles a single package, which is the shape with no separator problem at all", () => {
    expect(
      collapsePackageErrors("The following error occurred while loading zarr:\nFailed to fetch"),
    ).toBe("Could not download zarr: Failed to fetch\n");
  });

  it("preserves anything printed before the first match", () => {
    expect(
      collapsePackageErrors(
        "warning: something else\nThe following error occurred while loading numpy:Failed to fetch",
      ),
    ).toBe("warning: something else\nCould not download numpy: Failed to fetch\n");
  });

  // The guard that matters. This reshapes ONE known message; it is wired into the interpreter's
  // stderr, so anything it touches that it should not have touched is output the user loses.
  it("passes ordinary stderr through untouched", () => {
    const traceback =
      'Traceback (most recent call last):\n  File "<console>", line 1\nValueError: nope\n';
    expect(collapsePackageErrors(traceback)).toBe(traceback);
    expect(collapsePackageErrors("")).toBe("");
    expect(collapsePackageErrors("loading numpy\n")).toBe("loading numpy\n");
  });
});

/**
 * What the console SAYS when wheels are missing, for both counts. The negation must not live inside
 * the word "none": with a single wheel missing that reads "but 1 of its packages could be
 * downloaded: micropip", naming the one success as the failure.
 */
describe("loadProfilePackages", () => {
  /** A Pyodide stand-in that reports success for some names and silently drops the rest. */
  const pyodideThatLoads = (names: readonly string[]) =>
    ({
      loadPackage: async (requested: string | string[]) => {
        const asked = Array.isArray(requested) ? requested : [requested];
        return asked.filter((name) => names.includes(name)).map((name) => ({ name }));
      },
    }) as never;

  it("says 'none' when nothing arrived", async () => {
    await expect(
      loadProfilePackages(pyodideThatLoads([]), ["xarray", "zarr"], "https://example.test/"),
    ).rejects.toThrow(/none of its packages could be downloaded: xarray, zarr\./);
  });

  it("says 'could NOT be downloaded' when only some are missing", async () => {
    await expect(
      loadProfilePackages(
        pyodideThatLoads(["xarray", "zarr", "fsspec", "numcodecs"]),
        ["xarray", "zarr", "fsspec", "numcodecs", "micropip"],
        "https://example.test/",
      ),
    ).rejects.toThrow(/1 of its 5 packages could not be downloaded: micropip\./);
  });

  it("names where the wheels were fetched from, because that is the thing to check", async () => {
    await expect(
      loadProfilePackages(pyodideThatLoads([]), ["zarr"], "https://cdn.example.test/full/"),
    ).rejects.toThrow(/https:\/\/cdn\.example\.test\/full\//);
  });

  it("resolves silently when everything arrived", async () => {
    await expect(
      loadProfilePackages(pyodideThatLoads(["xarray"]), ["xarray"], "https://example.test/"),
    ).resolves.toBeUndefined();
  });

  it("does nothing at all for an empty profile", async () => {
    await expect(
      loadProfilePackages(pyodideThatLoads([]), [], "https://example.test/"),
    ).resolves.toBeUndefined();
  });
});

/**
 * `filterPackageNotes`, the other reshaping - on stdout, and about noise. The four strings below
 * are Pyodide's own. It emits them WITHOUT a trailing newline, which is why a fresh transcript
 * reads "Loading …Loaded …Python 3.14.2 (Pyodide 314.0.6) on WebAssembly" as one line.
 */
describe("filterPackageNotes", () => {
  const PROFILE =
    "Loading deprecated, donfig, fsspec, google-crc32c, micropip, numcodecs, numpy, packaging, " +
    "pandas, python-dateutil, pytz, pyyaml, six, typing-extensions, wrapt, xarray, zarr";

  it("drops a report that nothing happened, in either phase", () => {
    // `import numpy` on an interpreter that has numpy is a silent success at a Python prompt. It
    // has no more to say here, and it was saying it twice.
    for (const phase of ["starting", "running"] as const) {
      expect(filterPackageNotes("numpy already loaded from default channel", phase)).toBe("");
      expect(filterPackageNotes("No new packages to load", phase)).toBe("");
      expect(
        filterPackageNotes(
          "pandas already loaded from default channel. To override a dependency, …",
          phase,
        ),
      ).toBe("");
    }
  });

  it("drops the profile's own loading pair while the interpreter is coming up", () => {
    // The status line is already saying "Loading Python…". Naming seventeen packages under it, and
    // then naming them again, is the wall of text this exists to remove.
    expect(filterPackageNotes(PROFILE, "starting")).toBe("");
    expect(filterPackageNotes(PROFILE.replace("Loading", "Loaded"), "starting")).toBe("");
  });

  it("keeps a running session's loading notes, and gives them the newline Pyodide did not", () => {
    // A bare `import matplotlib` fetches several megabytes. Silence for those seconds is a console
    // that looks hung, so this is the one of the four that earns its line.
    expect(filterPackageNotes("Loading matplotlib, pillow", "running")).toBe(
      "Loading matplotlib, pillow\n",
    );
    expect(filterPackageNotes("Loaded matplotlib, pillow", "running")).toBe(
      "Loaded matplotlib, pillow\n",
    );
  });

  it("passes a visitor's own output through untouched", () => {
    // The match is on the WHOLE message, so a program that prints something beginning with the same
    // word keeps its line. A filter on the interpreter's stdout that ate a print() would be far
    // worse than the noise it removes.
    for (const phase of ["starting", "running"] as const) {
      expect(filterPackageNotes("Loading data from the archive\n", phase)).toBe(
        "Loading data from the archive\n",
      );
      expect(filterPackageNotes("Loaded 42 rows\n", phase)).toBe("Loaded 42 rows\n");
      expect(filterPackageNotes("No new packages to load, he said\n", phase)).toBe(
        "No new packages to load, he said\n",
      );
      expect(filterPackageNotes("\n", phase)).toBe("\n");
    }
  });
});
