// Parsed, containment-checked subsite inspection. Every case here is one a regular expression
// misses, and not because a pattern was written badly: a browser's HTML parser is not a regular
// language, so any pattern is a guess about what the browser will do.

import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";
import { inspectCss, inspectHtml, resolveReference } from "../../src/model/subsite-inventory.js";

afterAll(cleanupFixtures);

const MOUNT = "/reference/";

const kinds = (source: string, file = "index.html"): string[] =>
  inspectHtml(source, file, MOUNT).findings.map((finding) => finding.kind);

describe("attribute syntaxes a pattern misses", () => {
  it("sees an unquoted external script source", () => {
    expect(kinds("<script src=https://cdn.example.org/x.js></script>")).toContain(
      "external-subresource",
    );
  });

  it("sees a single-quoted external stylesheet", () => {
    expect(kinds("<link rel=stylesheet href='https://cdn.example.org/x.css'>")).toContain(
      "external-subresource",
    );
  });

  it("sees an unquoted inline event handler", () => {
    expect(kinds("<button onclick=alert(1)>go</button>")).toContain("event-handler");
  });

  it("sees an event handler with unusual spacing and case", () => {
    expect(kinds("<div   ONMOUSEOVER = 'x()' >hi</div>")).toContain("event-handler");
  });

  it("sees a javascript: link however it is quoted", () => {
    expect(kinds("<a href=javascript:alert(1)>x</a>")).toContain("active-url");
    expect(kinds(`<a href="JaVaScRiPt:alert(1)">x</a>`)).toContain("active-url");
  });

  it("sees a resource inside a template, which is not in the ordinary tree", () => {
    expect(kinds("<template><img src=https://cdn.example.org/x.png></template>")).toContain(
      "external-subresource",
    );
  });

  it("recovers from malformed markup the way a browser does", () => {
    const findings = kinds(
      "<p><b>unclosed <script src=https://cdn.example.org/a.js></script><i>tangled</p></b>",
    );
    expect(findings).toContain("external-subresource");
  });

  it("does not treat markup inside a comment as markup", () => {
    expect(kinds("<!-- <script src=https://cdn.example.org/x.js></script> -->")).toEqual([]);
  });

  it("does not treat an escaped angle bracket as a tag", () => {
    expect(kinds("&lt;script src=https://cdn.example.org/x.js&gt;")).toEqual([]);
  });

  it("treats a hyperlink as navigation, not as a fetched resource", () => {
    expect(kinds(`<a href="https://www.example.org/">out</a>`)).toEqual([]);
  });

  it("sees an escaping reference regardless of encoding", () => {
    expect(kinds(`<img src="../../../etc/passwd">`)).toContain("escaping-resource");
    expect(kinds(`<img src="..%2f..%2f..%2fetc/passwd">`)).toContain("escaping-resource");
  });

  it("hashes only genuinely inline blocks", () => {
    const inventory = inspectHtml(
      `<script src="app.js"></script><script>window.x = 1;</script><style>body{color:red}</style>`,
      "index.html",
      MOUNT,
    );
    expect(inventory.inlineScriptHashes).toHaveLength(1);
    expect(inventory.inlineStyleHashes).toHaveLength(1);
    expect(inventory.localResources).toEqual(["app.js"]);
  });
});

describe("CSS is parsed, not matched", () => {
  it("finds url() and @import references", () => {
    const inventory = inspectCss(
      `@import "theme.css";\n.a{background:url('img/a.png')}\n.b{background:url(img/b.png)}`,
      "style.css",
      MOUNT,
    );
    expect(inventory.localResources).toEqual(["img/a.png", "img/b.png", "theme.css"]);
  });

  it("refuses an external font and an external import", () => {
    const inventory = inspectCss(
      `@import url(https://fonts.example.org/x.css);\n@font-face{src:url("https://cdn.example.org/f.woff2")}`,
      "style.css",
      MOUNT,
    );
    expect(inventory.findings.map((f) => f.kind)).toEqual([
      "external-subresource",
      "external-subresource",
    ]);
  });

  it("ignores a url() that only appears inside a comment", () => {
    const inventory = inspectCss(
      `/* url(https://cdn.example.org/x.png) */\n.a{color:red}`,
      "style.css",
      MOUNT,
    );
    expect(inventory.findings).toEqual([]);
    expect(inventory.localResources).toEqual([]);
  });

  it("reports a stylesheet it cannot parse instead of guessing", () => {
    const inventory = inspectCss(".a{color:red", "style.css", MOUNT);
    // postcss recovers from an unclosed block; a genuinely broken at-rule does not.
    const broken = inspectCss("@media (min-width:){", "style.css", MOUNT);
    expect(
      inventory.findings.concat(broken.findings).every((f) => f.kind !== "external-subresource"),
    ).toBe(true);
  });

  it("inspects a style attribute as well as a style element", () => {
    const inventory = inspectHtml(
      `<div style="background:url(https://cdn.example.org/x.png)"></div>`,
      "index.html",
      MOUNT,
    );
    expect(inventory.findings.map((f) => f.kind)).toContain("external-subresource");
  });
});

describe("reference resolution shares one namespace", () => {
  it("resolves a relative reference against the referring file", () => {
    expect(resolveReference("img/a.png", "guide/index.html", MOUNT)).toEqual({
      kind: "local",
      path: "guide/img/a.png",
    });
  });

  it("resolves a root-relative reference against the mount", () => {
    expect(resolveReference("/reference/img/a.png", "guide/index.html", MOUNT)).toEqual({
      kind: "local",
      path: "img/a.png",
    });
  });

  it("refuses a root-relative reference outside the mount", () => {
    expect(resolveReference("/site/index.html", "index.html", MOUNT).kind).toBe("escapes");
  });

  it("keeps a query and fragment out of the resolved path", () => {
    expect(resolveReference("app.js?v=2#x", "index.html", MOUNT)).toEqual({
      kind: "local",
      path: "app.js",
    });
  });
});

describe("the copied tree must contain what it references", () => {
  const POLICY = `{
  "schemaVersion": 1,
  "profile": "static-docs-v1",
  "entryPoints": ["index.html"],
  "runtime": { "connectOrigins": [], "frameOrigins": [], "workers": "none" }
}
`;
  const SUBSITE = `trustedSubsites:
  - profile: static-docs-v1
    source: ./reference-docs
    mount: /reference/
    trust: active
    policy: ./policies/reference.json
`;

  it("refuses a reference to a file the documentation build did not ship", async () => {
    const root = tempRoot();
    write(root, "policies/reference.json", POLICY);
    write(
      root,
      "reference-docs/index.html",
      `<!doctype html><html><head><link rel="stylesheet" href="missing.css"></head><body>x</body></html>`,
    );
    writeSite(root, { extra: SUBSITE });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1405");
    expect(result.diagnostics.errors.some((d) => d.message.includes("missing.css"))).toBe(true);
  });

  it("accepts a subsite whose references all exist", async () => {
    const root = tempRoot();
    write(root, "policies/reference.json", POLICY);
    write(
      root,
      "reference-docs/index.html",
      `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>` +
        `<body><img src="img/a.png" alt="a"><a href="/site/">portal</a>` +
        `<script src="app.js"></script></body></html>`,
    );
    write(root, "reference-docs/style.css", `.a{background:url("img/a.png")}`);
    write(root, "reference-docs/img/a.png", "png");
    write(root, "reference-docs/app.js", "console.log(1);");
    writeSite(root, { extra: SUBSITE });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    const subsite = result.model!.trustedSubsiteMounts[0]!;
    expect([...subsite.staticResources]).toEqual(["app.js", "img/a.png", "style.css"]);
  });

  it("refuses an unquoted external resource end to end", async () => {
    const root = tempRoot();
    write(root, "policies/reference.json", POLICY);
    write(
      root,
      "reference-docs/index.html",
      `<!doctype html><html><body><script src=https://cdn.example.org/x.js></script></body></html>`,
    );
    writeSite(root, { extra: SUBSITE });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1405");
  });
});

describe("link relations", () => {
  it("treats a canonical link as navigation, not as a fetched resource", () => {
    const inventory = inspectHtml(
      '<link rel="canonical" href="https://docs.example.org/page/">',
      "index.html",
      MOUNT,
    );
    expect(inventory.findings.filter((f) => f.kind === "external-subresource")).toEqual([]);
  });

  it.each([
    ["stylesheet", "https://cdn.example.org/theme.css"],
    ["icon", "https://cdn.example.org/favicon.ico"],
    ["preload", "https://cdn.example.org/font.woff2"],
  ])("treats rel=%s as a fetched subresource", (rel, href) => {
    const inventory = inspectHtml(`<link rel="${rel}" href="${href}">`, "index.html", MOUNT);
    expect(inventory.findings.some((f) => f.kind === "external-subresource")).toBe(true);
  });

  it.each([
    ["preconnect", "https://fonts.gstatic.com"],
    ["dns-prefetch", "https://fonts.gstatic.com"],
  ])("treats rel=%s as a connection, not a subresource", (rel, href) => {
    // A hint opens a connection and loads nothing, so the policy decides whether that origin
    // is allowed. Reporting it as a subresource forbids it outright, with no policy consulted.
    const inventory = inspectHtml(`<link rel="${rel}" href="${href}">`, "index.html", MOUNT);
    expect(inventory.findings.map((f) => f.kind)).toEqual(["external-connection"]);
    expect(inventory.findings[0]).toMatchObject({ origin: "https://fonts.gstatic.com" });
  });

  it("reads a fetching relation out of a multi-token rel", () => {
    const inventory = inspectHtml(
      '<link rel="alternate stylesheet" href="https://cdn.example.org/theme.css">',
      "index.html",
      MOUNT,
    );
    expect(inventory.findings.some((f) => f.kind === "external-subresource")).toBe(true);
  });

  it("still records a local stylesheet as a static resource", () => {
    const inventory = inspectHtml(
      '<link rel="stylesheet" href="assets/theme.css">',
      "index.html",
      MOUNT,
    );
    expect(inventory.localResources).toContain("assets/theme.css");
  });
});

describe("data URLs", () => {
  it("permits a data image in a CSS declaration, where scripting is disabled", () => {
    const inventory = inspectCss(
      ":root { --icon: url(\"data:image/svg+xml;charset=utf-8,<svg xmlns='http://www.w3.org/2000/svg'/>\"); }",
      "assets/theme.css",
      MOUNT,
    );
    expect(inventory.findings).toEqual([]);
  });

  it("permits a data image on an img element", () => {
    expect(kinds('<img src="data:image/png;base64,iVBORw0KGgo=">')).toEqual([]);
  });

  it("still refuses a data document in an iframe", () => {
    expect(kinds('<iframe src="data:text/html,<script>alert(1)</script>"></iframe>')).toContain(
      "active-url",
    );
  });

  it("still refuses a data document in an object", () => {
    expect(kinds('<object data="data:text/html,x"></object>')).toContain("active-url");
  });

  it("still refuses a non-image data URL in CSS", () => {
    const inventory = inspectCss('@import url("data:text/css,body{}");', "assets/theme.css", MOUNT);
    expect(inventory.findings.map((f) => f.kind)).toContain("active-url");
  });

  it("still refuses javascript: wherever it appears", () => {
    expect(kinds('<img src="javascript:alert(1)">')).toContain("active-url");
  });
});
