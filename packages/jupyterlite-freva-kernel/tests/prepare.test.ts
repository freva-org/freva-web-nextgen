// The site audit's Lab rules, on stand-in sites: what was asked for must be what was built.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DISABLED_EXTENSIONS,
  LAB_APPS,
  auditSite,
  cspMetaTags,
  faviconProblems,
  linkFavicon,
  metaPolicyOf,
  metaPolicyProblems,
  pageMetaPolicyProblem,
  setMetaPolicy,
  missingPluginIds,
  prepareNotebookSite,
  writeMetaPolicy,
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

const metaTag = (policy: string) =>
  `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;

describe("the meta policy (a same-origin site on a host without headers)", () => {
  const POLICY =
    "default-src 'none'; frame-ancestors 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
    "report-uri /csp; connect-src 'self' https:";

  it("drops what a <meta> tag cannot deliver, and says which", () => {
    expect(metaPolicyOf(POLICY)).toEqual({
      policy: "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https:",
      dropped: ["frame-ancestors", "report-uri"],
    });
  });

  it("is every page's first head element, once, and its absence or a change is a problem", () => {
    const { policy } = metaPolicyOf(POLICY);
    const dir = site({
      "lab/index.html": '<!doctype html><html><head>\n<script src="./a.js"></script></head></html>',
      "notebooks/index.html": '<!doctype html><html><head lang="en"><title>x</title></head></html>',
    });
    expect(metaPolicyProblems(dir, policy)).toHaveLength(2);
    writeMetaPolicy(dir, policy);
    writeMetaPolicy(dir, policy); // idempotent: still one tag
    const page = readFileSync(join(dir, "lab", "index.html"), "utf8");
    expect(page.match(/http-equiv/g)).toHaveLength(1);
    expect(page).toMatch(
      /^<!doctype html><html><head>\n<meta http-equiv="Content-Security-Policy"/,
    );
    expect(metaPolicyProblems(dir, policy)).toEqual([]);
    expect(metaPolicyProblems(dir, `${policy}; img-src *`)).toHaveLength(2);
  });

  it("replaces a page's own policies, however written, and finds one left beside it", () => {
    const { policy } = metaPolicyOf(POLICY);
    const old = [
      "<meta http-equiv='Content-Security-Policy' content=\"script-src 'none'\">",
      '<meta content="script-src \'none\'" http-equiv="content-security-policy" />',
      "<META HTTP-EQUIV=Content-Security-Policy CONTENT=\"img-src 'none'\">",
    ];
    const dir = site({
      "lab/index.html": `<!doctype html><html><head>\n${old.join("\n")}\n<title>x</title></head></html>`,
    });
    writeMetaPolicy(dir, policy);
    const page = readFileSync(join(dir, "lab", "index.html"), "utf8");
    expect(page.match(/content-security-policy/gi)).toHaveLength(1);
    expect(page).not.toMatch(/'none'"/);
    expect(metaPolicyProblems(dir, policy)).toEqual([]);
    // One added after preparing is found, in any form.
    for (const extra of old) {
      writeFileSync(join(dir, "lab", "index.html"), page.replace("<title>", `${extra}<title>`));
      expect(metaPolicyProblems(dir, policy)).toEqual([
        "lab/index.html carries another meta policy beside the site's",
      ]);
    }
  });

  it("reads tags as a browser does: a quoted '>' is not their end; comments and scripts are not markup", () => {
    const { policy } = metaPolicyOf(POLICY);
    const tricky = [
      // `content` first, with a '>' in it: the whole tag goes, and nothing of it is left.
      `<meta content="script-src 'none' > x" http-equiv="Content-Security-Policy">`,
      // `http-equiv` first, the same.
      `<meta http-equiv='content-security-policy' content='img-src > none'>`,
    ];
    const dir = site({
      "lab/index.html":
        `<!doctype html><html><head>\n${tricky.join("\n")}\n` +
        `<!-- <meta http-equiv="Content-Security-Policy" content="old"> -->\n` +
        `<script type="application/json">{"x": "<meta http-equiv=Content-Security-Policy>"}</script>\n` +
        `<meta name="viewport" content="a > b"><title>x</title></head></html>`,
    });
    expect(cspMetaTags(readFileSync(join(dir, "lab", "index.html"), "utf8"))).toHaveLength(2);
    writeMetaPolicy(dir, policy);
    const page = readFileSync(join(dir, "lab", "index.html"), "utf8");
    expect(page).not.toContain("> x");
    expect(page).not.toContain("img-src > none");
    expect(page).toContain('<meta name="viewport" content="a > b">');
    expect(page).toContain("<!-- <meta http-equiv");
    expect(cspMetaTags(page)).toHaveLength(1);
    expect(metaPolicyProblems(dir, policy)).toEqual([]);
    // Added afterwards, in either order and with a quoted '>', it is found.
    for (const extra of tricky) {
      writeFileSync(join(dir, "lab", "index.html"), page.replace("<title>", `${extra}<title>`));
      expect(metaPolicyProblems(dir, policy)).toEqual([
        "lab/index.html carries another meta policy beside the site's",
      ]);
    }
  });

  it("reads pages as a browser's parser does: character references, quoted '>', raw text", () => {
    const { policy } = metaPolicyOf(POLICY);
    const entity = `<meta http-equiv="content&#45;security&#45;policy" content="script-src 'none'">`;
    const inScript = `<script>window.value='</scriptx><meta http-equiv="Content-Security-Policy" content="x">';</script>`;
    const inAttribute = `<meta name="a" content='<meta http-equiv="Content-Security-Policy" content="x">'>`;
    const inert =
      `<noscript><meta http-equiv="Content-Security-Policy" content="n"></noscript>` +
      `<template><meta http-equiv="Content-Security-Policy" content="t"></template>`;
    const dir = site({
      "lab/index.html": `<!doctype html><html><head data-description="x > y">${entity}${inScript}${inAttribute}${inert}<title>x</title></head></html>`,
    });
    const before = readFileSync(join(dir, "lab", "index.html"), "utf8");
    // The encoded tag is a policy; the script string, the attribute value and inert markup are not.
    expect(cspMetaTags(before)).toHaveLength(1);
    expect(metaPolicyProblems(dir, policy)).toEqual([
      "lab/index.html does not start with the site's meta policy",
    ]);
    writeMetaPolicy(dir, policy);
    const page = readFileSync(join(dir, "lab", "index.html"), "utf8");
    // The tag follows the real end of `<head ...>`, the old policy is gone, nothing else changed.
    expect(page).toBe(
      `<!doctype html><html><head data-description="x > y">\n${metaTag(policy)}\n` +
        `${inScript}${inAttribute}${inert}<title>x</title></head></html>`,
    );
    expect(metaPolicyProblems(dir, policy)).toEqual([]);
    // An encoded policy added afterwards is found.
    writeFileSync(join(dir, "lab", "index.html"), page.replace("<title>", `${entity}<title>`));
    expect(metaPolicyProblems(dir, policy)).toEqual([
      "lab/index.html carries another meta policy beside the site's",
    ]);
  });

  it("is not satisfied by a policy the parser does not see as the head's first element", () => {
    const { policy } = metaPolicyOf(POLICY);
    const tag = metaTag(policy);
    for (const html of [
      // Inside a quoted attribute of `<head>`.
      `<!doctype html><html><head data-x="a > ${tag.replace(/"/g, "'")}"><title>x</title></head></html>`,
      // Inside a script's string.
      `<!doctype html><html><head><script>"${tag.replace(/"/g, "'")}"</script></head></html>`,
      // After something it should govern.
      `<!doctype html><html><head><script src="a.js"></script>${tag}</head></html>`,
      // In the body: a browser ignores it there.
      `<!doctype html><html><head></head><body>${tag}</body></html>`,
    ]) {
      expect(pageMetaPolicyProblem(html, policy)).toBe(
        "does not start with the site's meta policy",
      );
    }
  });

  it("keeps a leading <meta charset> first, keeps a byte order mark and line ends, and finds the head without a <head> tag", () => {
    const { policy } = metaPolicyOf(POLICY);
    const tag = metaTag(policy);
    const cases: [string, string][] = [
      [
        `<!doctype html><html><head><meta charset="utf-8"><title>x</title></head></html>`,
        `<!doctype html><html><head><meta charset="utf-8">\n${tag}\n<title>x</title></head></html>`,
      ],
      [
        `\uFEFF<!doctype html>\r\n<html><head>\r\n<meta http-equiv=Content-Security-Policy content=old>\r\n</head></html>`,
        `\uFEFF<!doctype html>\r\n<html><head>\n${tag}\n\r\n\r\n</head></html>`,
      ],
      [
        `<!doctype html><title>x</title><head><script src="a.js"></script>`,
        `<!doctype html>\n${tag}\n<title>x</title><head><script src="a.js"></script>`,
      ],
    ];
    for (const [html, expected] of cases) {
      expect(setMetaPolicy(html, policy)).toBe(expected);
      expect(pageMetaPolicyProblem(expected, policy)).toBeNull();
      expect(setMetaPolicy(expected, policy)).toBe(expected);
    }
  });

  it("refuses to prepare with a policy a meta tag cannot carry", async () => {
    await expect(
      prepareNotebookSite({ out: join(tmpdir(), "never"), settings: {}, metaPolicy: POLICY }),
    ).rejects.toThrow(/frame-ancestors, report-uri/);
  });
});
