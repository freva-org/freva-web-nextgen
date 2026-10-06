// The site audit's Lab rules, on stand-in sites: what was asked for must be what was built.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DISABLED_EXTENSIONS,
  LAB_APPS,
  auditSite,
  faviconProblems,
  linkFavicon,
  missingPluginIds,
} from "../bin/prepare-notebook.mjs";

function site(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "freva-audit-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const config = (extensions: readonly string[], disabled: readonly string[]) =>
  JSON.stringify({
    "jupyter-config-data": {
      federated_extensions: extensions.map((name) => ({ name })),
      disabledExtensions: disabled,
    },
  });

const BUNDLE = [
  ...DISABLED_EXTENSIONS.map((id) => `id:"${id.includes(":") ? id : `${id}:plugin`}"`),
  'id:"@jupyterlab/console-extension:tracker"',
].join(";");

describe("the site audit", () => {
  it("reports a disabled id that is not a plugin of the build", () => {
    const dir = site({ "build/app.js": BUNDLE });
    expect(missingPluginIds(dir, ["@jupyterlab/console-extension:tracker"])).toEqual([]);
    expect(missingPluginIds(dir, ["@jupyterlab/console-extension:trackr"])).toEqual([
      "@jupyterlab/console-extension:trackr",
    ]);
    // A whole package counts when one of its plugins is there.
    expect(missingPluginIds(dir, ["@jupyterlab/console-extension"])).toEqual([]);
  });

  it("checks nothing against a site with no application bundle", () => {
    expect(missingPluginIds(site({ "x.txt": "" }), ["anything:at-all"])).toEqual([]);
  });

  it("requires the Lab app, the federated extensions and the disabled plugins asked for", () => {
    const disabled = [...DISABLED_EXTENSIONS, "@jupyterlab/console-extension:tracker"];
    const extensions = [
      "@freva-org/jupyterlite-freva-kernel",
      "@freva-org/jupyterlite-climateclaw",
    ];
    const expect_ = { apps: LAB_APPS, extensions, disabledExtensions: disabled };
    const good = site({
      "build/app.js": BUNDLE,
      "lab/index.html": '<script src="./a.js"></script>',
      "notebooks/index.html": '<script src="./a.js"></script>',
      "jupyter-lite.json": config(extensions, disabled),
    });
    expect(auditSite(good, expect_)).toEqual([]);

    const noLab = site({
      "build/app.js": BUNDLE,
      "notebooks/index.html": "",
      "jupyter-lite.json": config(extensions, disabled),
    });
    expect(auditSite(noLab, expect_)).toContain("the lab interface is missing");

    const extra = site({
      "build/app.js": BUNDLE,
      "lab/index.html": "",
      "jupyter-lite.json": config([...extensions, "someone-else"], disabled),
    });
    expect(auditSite(extra, expect_).join("\n")).toMatch(/unexpected federated extensions/);

    const notDisabled = site({
      "build/app.js": BUNDLE,
      "lab/index.html": "",
      "jupyter-lite.json": config(extensions, DISABLED_EXTENSIONS),
    });
    expect(auditSite(notDisabled, expect_)).toContain(
      "@jupyterlab/console-extension:tracker is not disabled",
    );
  });

  it("still refuses a Lab app nobody asked for", () => {
    const dir = site({
      "lab/index.html": "",
      "jupyter-lite.json": config(["@freva-org/jupyterlite-freva-kernel"], DISABLED_EXTENSIONS),
    });
    expect(auditSite(dir)).toContain("the lab interface is present");
  });
});

describe("the site's own tab icon", () => {
  it("is written at the root and linked from every page, in place of any other", () => {
    const dir = site({
      "lab/index.html":
        '<html><head><title>JupyterLite</title><link rel="icon" href="x.ico"></head><body></body></html>',
      "notebooks/index.html": "<html><head></head><body></body></html>",
      "freva-login-callback.html": "<html><head></head></html>",
      "jupyter-lite.json": JSON.stringify({
        "jupyter-config-data": { appName: "Waterpark Notebook", faviconUrl: "./lab/favicon.ico" },
      }),
      "notebooks/jupyter-lite.json": JSON.stringify({
        "jupyter-config-data": { appUrl: "/notebooks", faviconUrl: "./favicon.ico" },
      }),
      "lab/jupyter-lite.json": JSON.stringify({ "jupyter-config-data": { appUrl: "/lab" } }),
    });
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    // Before: JupyterLite's own icon in its bootstrap config (what a reused site would keep).
    expect(faviconProblems(dir, "favicon.svg")).toEqual([
      "jupyter-lite.json does not name the site's tab icon (faviconUrl)",
      `${join("notebooks", "jupyter-lite.json")} does not name the site's tab icon (faviconUrl)`,
    ]);
    linkFavicon(dir, { path: "favicon.svg", bytes, type: "image/svg+xml" });
    expect(faviconProblems(dir, "favicon.svg")).toEqual([]);
    expect(readFileSync(join(dir, "favicon.svg"), "utf8")).toBe(bytes.toString());
    const lab = readFileSync(join(dir, "lab/index.html"), "utf8");
    expect(lab).toContain(
      '<link rel="icon" type="image/svg+xml" href="../favicon.svg" class="idle favicon">',
    );
    expect(lab).not.toContain("x.ico");
    expect(readFileSync(join(dir, "notebooks/index.html"), "utf8")).toContain(
      'href="../favicon.svg"',
    );
    expect(readFileSync(join(dir, "freva-login-callback.html"), "utf8")).toContain(
      'href="favicon.svg"',
    );
    // JupyterLite's boot script adds an icon link of its own, from faviconUrl: the site's too.
    const data = (path: string) =>
      JSON.parse(readFileSync(join(dir, path), "utf8"))["jupyter-config-data"];
    expect(data("jupyter-lite.json")).toEqual({
      appName: "Waterpark Notebook",
      faviconUrl: "./favicon.svg",
    });
    expect(data("notebooks/jupyter-lite.json").faviconUrl).toBe("./../favicon.svg");
    expect(data("lab/jupyter-lite.json")).toEqual({ appUrl: "/lab" });
  });
});
