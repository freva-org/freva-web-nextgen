// `rendering.assets` and `rendering.downloads` take the same `files.include/exclude` globs as a
// content source. The shape that needs it: a directory of worked examples holding the page, its
// thumbnail and the script a reader downloads, where only the script is a download.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";
import { filterMountedFiles } from "../../src/model/assets.js";

afterAll(cleanupFixtures);

const PAGE = (title: string): string => `---\ntitle: ${title}\n---\n\n# ${title}\n\nText.\n`;
const PNG = "\u0089PNG\r\n\u001a\n";

function examplesSite(files: string, assetFiles = ""): string {
  const root = tempRoot("mount-filter-");
  writeSite(root, {
    content: {
      "content/examples/01_first_map.md": PAGE("A map of one month"),
      "content/examples/01_first_map.py": "print('map')\n",
      "content/examples/02_zonal_mean.md": PAGE("A zonal mean"),
      "content/examples/02_zonal_mean.py": "print('mean')\n",
      "content/examples/helpers/_common.py": "X = 1\n",
      "content/examples/notes.txt": "scratch\n",
    },
    extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
  downloads:
    - root: ./content/examples
      mount: /downloads/examples/
${files}${assetFiles}`,
  });
  return root;
}

describe("files.include / files.exclude on a mounted root", () => {
  it("publishes only the matching downloads, beside the pages that use them", async () => {
    const root = examplesSite(`      files:
        include: ["*.py"]
`);
    const { model, diagnostics } = await resolveFixture(root);
    expect(codes(diagnostics.errors)).toEqual([]);
    const downloads = model!.passiveDownloads.map((f) => f.file).sort();
    expect(downloads).toEqual([
      "downloads/examples/01_first_map.py",
      "downloads/examples/02_zonal_mean.py",
    ]);
    // The pages in the same directory are still pages.
    expect(model!.routes.map((r) => r.path)).toContain("/docs/examples/01_first_map/");
  });

  it("excludes after including, with the content sources' glob dialect", async () => {
    const root = examplesSite(`      files:
        include: ["**/*.py"]
        exclude: ["helpers/**"]
`);
    const { model } = await resolveFixture(root);
    expect(model!.passiveDownloads.map((f) => f.file).sort()).toEqual([
      "downloads/examples/01_first_map.py",
      "downloads/examples/02_zonal_mean.py",
    ]);
  });

  it("keeps every file when a root says nothing, as before", async () => {
    const root = examplesSite("");
    const { model } = await resolveFixture(root);
    expect(model!.passiveDownloads).toHaveLength(6);
  });

  it("filters an asset root before the MIME allowlist sees it", async () => {
    // An asset root holding a script would fail FP1401; excluded, the script is never examined.
    const root = tempRoot("mount-filter-assets-");
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  assets:
    - root: ./media
      mount: /media/
      files:
        exclude: ["**/*.py"]
`,
    });
    write(root, "media/thumb.png", PNG);
    write(root, "media/make_thumb.py", "print('thumb')\n");
    const unfiltered = tempRoot("mount-filter-assets-bad-");
    writeSite(unfiltered, {
      extra: `rendering:
  profile: portal-content-v1
  assets:
    - root: ./media
      mount: /media/
`,
    });
    write(unfiltered, "media/thumb.png", PNG);
    write(unfiltered, "media/make_thumb.py", "print('thumb')\n");

    expect(codes((await resolveFixture(unfiltered)).diagnostics.errors)).toContain("FP1401");
    const { model, diagnostics } = await resolveFixture(root);
    expect(codes(diagnostics.errors)).toEqual([]);
    expect(model!.embeddableAssets.map((f) => f.file)).toEqual(["media/thumb.png"]);
  });

  it("records only the published files as inputs", async () => {
    const root = examplesSite(`      files:
        include: ["*.py"]
`);
    const { model } = await resolveFixture(root);
    const text = JSON.stringify(model);
    expect(text).not.toContain("notes.txt");
  });

  it("is a closed object", async () => {
    const root = examplesSite(`      files:
        only: ["*.py"]
`);
    const { diagnostics } = await resolveFixture(root);
    expect(codes(diagnostics.errors)).toContain("FP1104");
  });

  it("the filter itself: no include keeps dotfiles, an include does not", () => {
    const root = { absolute: "/x", relative: "x", mount: "/x/" };
    const files = [".keep", "a.py", "b/c.py", "d.md"];
    expect(filterMountedFiles(files, root)).toEqual(files);
    expect(filterMountedFiles(files, { ...root, include: ["**/*.py"] })).toEqual([
      "a.py",
      "b/c.py",
    ]);
    expect(filterMountedFiles(files, { ...root, exclude: ["*.md"] })).toEqual([
      ".keep",
      "a.py",
      "b/c.py",
    ]);
  });
});

it("is documented beside the content sources", () => {
  const doc = readFileSync(join(__dirname, "..", "..", "docs", "configuration.md"), "utf8");
  expect(doc).toMatch(/downloads:[\s\S]*files:[\s\S]*include/);
});
