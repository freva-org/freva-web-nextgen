import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, it, expect, beforeAll, afterEach } from "vitest";

// Against the BUILT root, not the sources.
//
// What a consumer installs is `dist/`, and the two things that decide whether it works
// - the export map and the tree-shaking metadata - exist only there. A source-level
// test cannot see either: with `sideEffects` naming only `./dist/*`, rollup read this
// package's own sources as pure and dropped the root's registration from `index.mjs`
// while every source test stayed green.
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAGS = ["data-inspector", "aggregation-config", "zarr-loading-steps"] as const;

let root: Record<string, unknown>;

beforeAll(async () => {
  root = (await import(pathToFileURL(resolve(PKG, "dist/index.mjs")).href)) as typeof root;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the built package root", () => {
  it("registers every element", () => {
    for (const tag of TAGS)
      expect(customElements.get(tag), `${tag} is not defined`).toBeTypeOf("function");
  });

  it("exports the data API beside the element classes", () => {
    expect(Object.keys(root).sort()).toEqual([
      "AggregationConfigElement",
      "DataInspectorElement",
      "NcDumpDialogState",
      "ZarrLoadingStepsElement",
      "ZarrPoller",
      "buildXarrayRepr",
      "detectZarrStore",
      "injectXarrayCss",
      "loadZarrMetadataHtml",
      "openDatasetMeta",
    ]);
  });

  it("the dialog it registers opens, reads its file and closes", () => {
    const el = document.createElement("data-inspector");
    el.setAttribute("file", "/data/my.nc");
    document.body.append(el);
    const dialog = el as HTMLElement & { open: boolean; file: string };
    expect(dialog.file).toBe("/data/my.nc");
    expect(dialog.open).toBe(false);
    dialog.open = true;
    expect(el.hasAttribute("open")).toBe(true);
    dialog.open = false;
    expect(el.hasAttribute("open")).toBe(false);
  });

  it("every path the export map advertises is in the tarball", () => {
    const pkg = JSON.parse(readFileSync(resolve(PKG, "package.json"), "utf8"));
    for (const entry of Object.values(pkg.exports) as Array<string | Record<string, string>>) {
      for (const file of typeof entry === "string" ? [entry] : Object.values(entry)) {
        expect(
          () => readFileSync(resolve(PKG, file)),
          `${file} is advertised but missing`,
        ).not.toThrow();
      }
    }
  });
});
