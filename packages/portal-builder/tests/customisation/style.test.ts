// portal-style-v1: what a consumer stylesheet may say, checked on the text a browser reads.
// Every rejection names the file, line and column, and an accepted stylesheet is re-serialized
// from its checked form, so nothing the checks did not see reaches the artifact.

import { describe, expect, it } from "vitest";
import { checkStylesheet, type StyleCheckContext } from "../../src/customisation/style.js";
import { styleApi } from "../../src/customisation/api.js";

function check(css: string, overrides: Partial<StyleCheckContext> = {}) {
  const assets: string[] = [];
  const result = checkStylesheet(css, {
    file: "brand/site.css",
    disabledFeatures: new Set(["dataset-tree", "footer-badge"]),
    resolveAsset: (ref, kind) => {
      assets.push(`${kind}:${ref}`);
      return ref.startsWith("./") || ref.startsWith("../")
        ? `/_portal/site/${ref.replace(/^.*\//, "")}`
        : undefined;
    },
    ...overrides,
  });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  return { ...result, errors, codes: errors.map((d) => d.code), assets };
}

function rejects(css: string, ...accepted: string[]): void {
  const result = check(css);
  const report = `${css}\n${result.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n")}`;
  expect(
    result.codes.some((code) => accepted.includes(code)),
    report,
  ).toBe(true);
  expect(result.css).toBeUndefined();
}

describe("portal-style-v1 accepts the public API", () => {
  it("keeps parts, variants, states, themes, site classes and the allowed pseudo-classes", () => {
    const result = check(`
:root { --portal-color-accent: #123456; --site-gap: 4px; }
[data-theme="dark"] { --portal-color-accent: #abcdef; }
[data-part="header"][data-variant="split"] > [data-part="header-brand"] { gap: var(--site-gap); }
[data-part="header-link"][data-state="current"]:hover { text-decoration: underline; }
[data-part="card"]:nth-child(2n + 1):not([data-state="current"]) { color: red; }
[data-part="card"]:is([data-part="card"], .site-x)::before { content: "→ "; }
.site-note a:focus-visible { outline: 3px solid currentColor; }
.site-note p:first-child { margin: 0; }
@media (min-width: 768px) and (prefers-color-scheme: dark) { .site-note { padding: 2px; } }
@media print { [data-part="footer-logos"] { display: none; } }
@media (prefers-reduced-motion: reduce) { .site-note { transition: none; } }
@supports (display: grid) { .site-note { display: grid; } }
@layer cards { .site-note { color: blue; } }
@keyframes site-pulse { from { opacity: 0.5; } to { opacity: 1; } }
@font-face { font-family: "Site Serif"; src: url("./fonts/serif.woff2") format("woff2"); }
.site-hero { background-image: url("../img/wave.svg"); }
`);
    expect(result.errors).toEqual([]);
    expect(result.css).toBeDefined();
    // Public tokens are mapped onto the framework's own custom properties.
    expect(result.css).toContain("--accent: #123456");
    expect(result.css).not.toContain("--portal-color-accent");
    // Consumer properties keep their prefix; local files are resolved to published URLs.
    expect(result.css).toContain("--site-gap: 4px");
    expect(result.css).toContain('url("/_portal/site/wave.svg")');
    expect(result.css).toContain('url("/_portal/site/serif.woff2")');
    expect(result.assets).toEqual(["font:./fonts/serif.woff2", "image:../img/wave.svg"]);
  });

  it("publishes every token in schema/style-parts-v1.json and maps each to a framework property", () => {
    const api = styleApi();
    for (const [token, target] of Object.entries(api.tokens)) {
      expect(token.startsWith("--portal-")).toBe(true);
      // A colour token takes a colour; the others are lengths, factors and fonts.
      const value = token.startsWith("--portal-color-") ? "#123456" : "1px";
      const result = check(`.site-scope { ${token}: ${value}; }`);
      expect(result.errors, token).toEqual([]);
      expect(result.css).toContain(`${target}: ${value}`);
    }
  });

  it("is deterministic", () => {
    const css = `[data-part="card"] { color: red; }\n.site-a { margin: 0; }`;
    expect(check(css).css).toBe(check(css).css);
  });
});

describe("portal-style-v1 rejects, with a location", () => {
  it("reports parse errors at file:line:col", () => {
    const result = check(`.site-a {\n  color: red;\n`);
    expect(result.codes).toEqual(["FP1901"]);
    expect(result.errors[0]!.file).toBe("brand/site.css");
    expect(result.errors[0]!.position?.line).toBeGreaterThan(0);
  });

  it("locates a rejected declaration on its own line and column", () => {
    const result = check(`.site-a {\n  color: red;\n  behavior: url(x.htc);\n}`);
    const diagnostic = result.errors.find((d) => d.code === "FP1904")!;
    expect(diagnostic.position).toEqual({ line: 3, column: 3 });
  });

  it.each([
    ["@import", `@import url("./other.css");`],
    ["@import, escaped", `@\\69mport "./other.css";`],
    ["@namespace", `@namespace svg url(http://www.w3.org/2000/svg);`],
    ["an unknown at-rule", `@page { margin: 0; }`],
    ["@container", `@container (min-width: 1px) { .site-a { color: red; } }`],
    ["a media feature outside the list", `@media (hover: hover) { .site-a { color: red; } }`],
    ["a reserved keyframes name", `@keyframes portal-spin { to { opacity: 1; } }`],
  ])("an at-rule outside the profile: %s", (_name, css) => rejects(css, "FP1903", "FP1901"));

  it.each([
    ["a framework class", `.portal-header { color: red; }`],
    ["an escaped framework class", `.\\70 ortal-header { color: red; }`],
    ["an id", `#portal-main { color: red; }`],
    ["the universal selector", `* { color: red; }`],
    ["a bare element", `a { color: red; }`],
    [
      "an element under a part that is not a slot container",
      `[data-part="header"] a { color: red; }`,
    ],
    ["a private attribute", `[data-portal-account] { color: red; }`],
    ["an unknown part", `[data-part="nope"] { color: red; }`],
    ["an unknown variant", `[data-variant="bold"] { color: red; }`],
    ["a substring attribute match", `[data-part^="header"] { color: red; }`],
    ["a sibling combinator", `.site-a + .site-b { color: red; }`],
    ["a pseudo-class outside the list", `.site-a:focus-within { color: red; }`],
    [":has()", `.site-a:has(.site-b) { color: red; }`],
    [":not() over a complex selector", `.site-a:not(.site-b .site-c) { color: red; }`],
    ["a pseudo-element outside the list", `.site-a::selection { color: red; }`],
    ["::marker", `.site-a::marker { color: red; }`],
    ["the html element", `html { color: red; }`],
  ])("a selector outside the API: %s", (_name, css) => rejects(css, "FP1902"));

  it.each([
    ["a remote url", `.site-a { background: url(https://cdn.example.org/x.png); }`],
    ["a protocol-relative url", `.site-a { background: url(//cdn.example.org/x.png); }`],
    ["a data: url", `.site-a { background: url(data:image/png;base64,AAAA); }`],
    ["a javascript: url", `.site-a { background: url("javascript:alert(1)"); }`],
    ["an escaped url()", `.site-a { background: \\75 rl(https://cdn.example.org/x.png); }`],
    ["a url split by a comment", `.site-a { background: u/**/rl(https://cdn.example.org/x.png); }`],
    ["a remote image-set", `.site-a { background: image-set("https://x.example.org/a.png" 1x); }`],
    ["expression()", `.site-a { width: expression(alert(1)); }`],
    ["behavior", `.site-a { behavior: url(./x.htc); }`],
    ["-moz-binding", `.site-a { -moz-binding: url(./x.xml#y); }`],
    ["attr() in content", `.site-a::before { content: attr(href); }`],
    ["a url in content", `.site-a::before { content: url(./x.svg); }`],
    ["a remote url in a custom property", `:root { --site-bg: url(https://x.example.org/a.png); }`],
    ["a framework custom property", `:root { --accent: red; }`],
    ["an unprefixed custom property", `:root { --brand: red; }`],
    ["an unknown public token", `:root { --portal-color-nope: red; }`],
    [
      "a remote font source",
      `@font-face { font-family: "X"; src: url(https://fonts.example.org/x.woff2); }`,
    ],
    ["local() font source", `@font-face { font-family: "X"; src: local("Arial"); }`],
    ["a stray brace in a value", `.site-a { color: red}x{color:blue; }`],
  ])("a value outside the profile: %s", (_name, css) =>
    rejects(css, "FP1904", "FP1907", "FP1901", "FP1902"),
  );

  it.each([
    ["the account control", `[data-part="header-auth"] { display: none; }`],
    ["the skip link", `[data-part="skip-link"] { visibility: hidden; }`],
    ["the menu button", `[data-part="nav-toggle"] { opacity: 0; }`],
    ["the header landmark", `[data-part="header"] { display: none; }`],
    ["the main landmark", `[data-part="main"] { content-visibility: hidden; }`],
    ["the footer landmark", `[data-part="footer"] { height: 0; overflow: hidden; }`],
    ["the side navigation", `[data-part="side-nav"] { width: 0; }`],
    ["the account control, by pointer", `[data-part="header-auth"] { pointer-events: none; }`],
    [
      "the account control, off screen",
      `[data-part="header-auth"] { position: absolute; left: -9999px; }`,
    ],
    ["the account control, scaled away", `[data-part="header-auth"] { transform: scale(0); }`],
    ["a container of a protected control", `[data-part="header-controls"] { display: none; }`],
    ["the focus indicator", `.site-a:focus-visible { outline: none; }`],
    [
      "the focus indicator on a part",
      `[data-part="nav-toggle"]:focus-visible { outline-width: 0; }`,
    ],
  ])("hiding a protected control: %s", (_name, css) => rejects(css, "FP1905"));

  it("allows hiding a protected control for print, and hiding unprotected parts", () => {
    expect(check(`@media print { [data-part="header"] { display: none; } }`).errors).toEqual([]);
    expect(check(`[data-part="header-title"] { display: none; }`).errors).toEqual([]);
  });

  it("treats a site class that wraps the account control as protected", () => {
    const result = check(`.site-account { display: none; }`, {
      protectedSiteClasses: new Set(["site-account"]),
    });
    expect(result.codes).toContain("FP1905");
  });

  it("scans the stylesheet for credentials", () => {
    const result = check(`.site-a::before { content: "client_secret=abc123"; }`);
    expect(result.codes).toContain("FP1210");
  });

  it("refuses an oversized stylesheet", () => {
    const result = check(".site-a { color: red; }\n".repeat(20), { maxBytes: 64 });
    expect(result.codes).toContain("FP1407");
  });
});

describe("portal-style-v1 and disabled features", () => {
  it("prunes a rule that can only match a disabled feature's parts, with an info diagnostic", () => {
    const result = check(
      `[data-part="block-dataset-tree"] { outline: 1px solid; }\n[data-part="card"] { color: red; }`,
    );
    expect(result.errors).toEqual([]);
    expect(result.css).not.toContain("block-dataset-tree");
    expect(result.css).toContain('[data-part="card"]');
    expect(result.pruned).toEqual([
      { selector: '[data-part="block-dataset-tree"]', features: ["dataset-tree"], line: 1 },
    ]);
    expect(result.diagnostics.map((d) => [d.code, d.severity])).toContainEqual(["FP1906", "info"]);
  });

  it("keeps the parts of a selector list that can still match", () => {
    const result = check(`[data-part="block-dataset-tree"], [data-part="card"] { color: red; }`);
    expect(result.errors).toEqual([]);
    expect(result.css).toContain('[data-part="card"]');
    expect(result.css).not.toContain("block-dataset-tree");
    expect(result.pruned[0]!.selector).toBe('[data-part="block-dataset-tree"]');
  });
});

describe("portal-style-v1 review findings", () => {
  it.each([
    ["not print", `@media not print { [data-part="header-auth"] { display: none; } }`],
    ["print, screen", `@media print, screen { [data-part="header-auth"] { display: none; } }`],
    ["screen, print", `@media screen, print { [data-part="skip-link"] { visibility: hidden; } }`],
    ["a width query", `@media (min-width: 1px) { [data-part="nav-toggle"] { display: none; } }`],
  ])("grants no print exemption to a query that reaches the screen: %s", (_name, css) =>
    rejects(css, "FP1905"),
  );

  it("still exempts queries that only print", () => {
    for (const media of ["print", "only print", "print and (min-width: 10px)", "print, print"]) {
      const result = check(`@media ${media} { [data-part="header"] { display: none; } }`);
      expect(result.errors, media).toEqual([]);
    }
  });

  it("refuses an animation on a protected control whose keyframes hide it", () => {
    rejects(
      `@keyframes fade { to { opacity: 0; } }\n[data-part="header-auth"] { animation: fade 1s forwards; }`,
      "FP1905",
    );
    // Declared after its use, through animation-name, and by visibility.
    rejects(
      `[data-part="nav-toggle"] { animation-name: gone; }\n@keyframes gone { 50% { visibility: hidden; } }`,
      "FP1905",
    );
  });

  it("refuses an animation on a protected control naming keyframes it cannot check", () => {
    rejects(`[data-part="header-auth"] { animation: portal-spin 1s; }`, "FP1905");
    rejects(`[data-part="header-auth"] { animation: var(--site-anim); }`, "FP1905");
  });

  it.each([
    ["a quoted name", `[data-part="header-auth"] { animation: "fade" 1s forwards; }`],
    ["a single-quoted name", `[data-part="header-auth"] { animation-name: 'fade'; }`],
    [
      "a keyword-named keyframes, longhand",
      `[data-part="header-auth"] { animation-name: linear; }`,
    ],
    ["a keyword-named keyframes, shorthand", `[data-part="header-auth"] { animation: 1s linear; }`],
    ["a list", `[data-part="header-auth"] { animation-name: pulse, fade; }`],
    ["a prefixed property", `[data-part="header-auth"] { -webkit-animation: fade 1s; }`],
    ["an escaped name", `[data-part="header-auth"] { animation-name: \\66 ade; }`],
  ])("checks every name an animation can refer to: %s", (_name, rule) => {
    rejects(
      `@keyframes fade { to { opacity: 0; } }\n@keyframes linear { to { visibility: hidden; } }\n@keyframes pulse { to { color: red; } }\n${rule}`,
      "FP1905",
    );
  });

  it("decodes escapes inside a quoted name before comparing it", () => {
    const safe = check(
      `@keyframes pulse { to { color: red; } }\n[data-part="header-auth"] { animation: "\\70 ulse" 1s; }`,
    );
    expect(safe.errors).toEqual([]);
    rejects(
      `@keyframes fade { to { opacity: 0; } }\n[data-part="header-auth"] { animation-name: "\\66 ade"; }`,
      "FP1905",
    );
  });

  it("treats names as case-sensitive: a name with no keyframes of that case is refused", () => {
    rejects(
      `@keyframes pulse { to { color: red; } }\n[data-part="header-auth"] { animation-name: PULSE; }`,
      "FP1905",
    );
  });

  it("allows animations that keep a protected control visible, and any on other parts", () => {
    const safe = check(
      `@keyframes pulse { from { color: red; } to { color: blue; } }\n[data-part="header-auth"] { animation: pulse 2s ease-in-out infinite alternate; }`,
    );
    expect(safe.errors).toEqual([]);
    const quoted = check(
      `@keyframes pulse { to { color: red; } }\n[data-part="header-auth"] { animation: "pulse" 2s linear, none; }`,
    );
    expect(quoted.errors).toEqual([]);
    const elsewhere = check(
      `@keyframes fade { to { opacity: 0; } }\n[data-part="card"] { animation: fade 1s forwards; }`,
    );
    expect(elsewhere.errors).toEqual([]);
  });
});

describe("portal-style-v1: protected controls take only provably safe declarations", () => {
  it.each([
    ["opacity through calc()", `[data-part="header-auth"] { opacity: calc(1 - 1); }`],
    ["opacity through min()", `[data-part="header-auth"] { opacity: min(0, 1); }`],
    ["a low opacity", `[data-part="header-auth"] { opacity: 0.2; }`],
    ["a zero matrix()", `[data-part="header-auth"] { transform: matrix(0, 0, 0, 0, 0, 0); }`],
    ["a 3D transform", `[data-part="nav-toggle"] { transform: rotateX(90deg); }`],
    ["a small scale()", `[data-part="nav-toggle"] { transform: scale(0.1); }`],
    ["an off-screen translate()", `[data-part="nav-toggle"] { transform: translateX(-9999px); }`],
    [
      "a computed translate()",
      `[data-part="nav-toggle"] { transform: translateX(calc(-1 * 100vw)); }`,
    ],
    ["the scale property", `[data-part="header-auth"] { scale: 0; }`],
    ["filter: opacity()", `[data-part="header-auth"] { filter: opacity(0); }`],
    ["filter: blur()", `[data-part="header-auth"] { filter: blur(40px); }`],
    [
      "a mask",
      `[data-part="header-auth"] { mask-image: linear-gradient(transparent, transparent); }`,
    ],
    ["clip-path: inset()", `[data-part="header-auth"] { clip-path: inset(50%); }`],
    ["overflow on a container", `[data-part="header-controls"] { overflow: hidden; }`],
    ["a computed width", `[data-part="header-auth"] { width: calc(0px); }`],
    ["a 1px width", `[data-part="header-auth"] { max-width: 1px; }`],
    ["a tiny font", `[data-part="header"] { font-size: 1px; }`],
    ["a far offset", `[data-part="header-auth"] { margin-left: 5000px; }`],
    ["a positive off-screen offset", `[data-part="nav-toggle"] { margin-left: 200vw; }`],
    ["collapsed letters", `[data-part="header-auth"] { letter-spacing: -1000px; }`],
    ["a transparent colour", `[data-part="header-auth"] { color: transparent; }`],
    ["a zero-alpha colour", `[data-part="header-auth"] { color: rgb(0 0 0 / 0); }`],
    ["a zero-alpha hex", `[data-part="header-auth"] { color: #0000; }`],
    ["a colour from a site property", `[data-part="header-auth"] { color: var(--site-ink); }`],
    ["a transparent colour token", `:root { --portal-color-chrome-text: transparent; }`],
    ["a zero header height", `:root { --portal-header-height: 0; }`],
    ["a zero type scale", `:root { --portal-type-scale: 0; }`],
    ["position", `[data-part="header-auth"] { position: absolute; }`],
    ["z-index on a control", `[data-part="header-auth"] { z-index: 0; }`],
    ["visibility through the root", `:root { visibility: hidden; }`],
    ["an unknown property", `[data-part="header-auth"] { zoom: 0.01; }`],
    // Some of these fail earlier, as functions portal-style-v1 does not accept at all (FP1904).
  ])("refuses %s", (_name, css) => rejects(css, "FP1905", "FP1904"));

  it.each([
    ["a surface", `[data-part="header-auth"]::after { content: ""; background: #000; }`],
    ["a position", `[data-part="nav-toggle"]::before { content: ""; position: absolute; }`],
    [
      "a shadow",
      `[data-part="header-auth"]::after { content: ""; box-shadow: 0 0 0 9999px #000; }`,
    ],
    ["a transform", `[data-part="header"]::after { content: "x"; transform: translateY(-50px); }`],
    [
      "a negative margin",
      `[data-part="header-auth"]::before { content: "x"; margin-left: -50px; }`,
    ],
  ])("refuses generated content of a protected control with %s", (_name, css) =>
    rejects(css, "FP1905"),
  );

  it.each([
    ["z-index above 10", `.site-a { position: relative; z-index: 11; }`],
    ["position: fixed", `.site-a { position: fixed; }`],
    ["a computed z-index", `[data-part="card"] { z-index: calc(100); }`],
    ["z-index in keyframes", `@keyframes up { to { z-index: 99; } }`],
  ])("refuses anything lifted over the chrome: %s", (_name, css) => rejects(css, "FP1905"));

  it("accepts what keeps a protected control visible", () => {
    const result = check(`
:root { --portal-color-accent: #0b6e8a; --portal-header-height: 64px; --portal-type-scale: 1.07; }
[data-part="header-auth"] { opacity: 0.95; border-radius: 999px; background: var(--portal-color-surface); }
[data-part="header-auth"]:hover { color: var(--portal-color-accent); border: 2px solid var(--portal-color-accent); }
[data-part="card"]:hover { transform: translateY(-2px) scale(1.02); }
[data-part="nav-toggle"]:focus-visible { outline: 3px dashed var(--portal-color-accent); outline-offset: 4px; }
[data-part="nav-toggle"] { padding: 8px 12px; margin-left: 8px; font-size: 15px; letter-spacing: 0.02em; }
[data-part="header"] { border-bottom-width: 2px; box-shadow: 0 2px 8px rgb(0 0 0 / 0.2); }
[data-part="header-auth"]::before { content: "→ "; color: var(--portal-color-accent); }
.site-badge { position: absolute; z-index: 5; }
`);
    expect(result.errors).toEqual([]);
  });
});

describe("portal-style-v1: what composes is bounded, and focus indicators are provable", () => {
  it.each([
    [
      "ten translations",
      `[data-part="nav-toggle"] { transform: ${"translateX(200px) ".repeat(10)}; }`,
    ],
    [
      "repeated scales",
      `[data-part="header-auth"] { transform: scale(0.5) scale(0.5) scale(0.5); }`,
    ],
    ["a skew in turns", `[data-part="header-auth"] { transform: skewX(0.24turn); }`],
    ["a skew in radians", `[data-part="header-auth"] { transform: skewX(1.5rad); }`],
    ["the translate property", `[data-part="nav-toggle"] { translate: 8px; }`],
    ["the scale property", `[data-part="nav-toggle"] { scale: 0.9; }`],
    ["the rotate property", `[data-part="nav-toggle"] { rotate: 0.5turn; }`],
    ["a transform on a container", `[data-part="header-controls"] { transform: translateX(8px); }`],
    ["an opacity that compounds", `[data-part="header-controls"] { opacity: 0.5; }`],
    ["a shrinking relative font", `[data-part="header"] { font-size: 0.6em; }`],
    ["wide padding", `[data-part="header"] { padding-left: 200px; }`],
    ["a wide margin", `[data-part="header-controls"] { margin-left: 50px; }`],
    ["a wide border", `[data-part="header-auth"] { border: 50px solid red; }`],
    ["a fixed width", `[data-part="header-controls"] { width: 2000px; }`],
    ["an offset", `[data-part="header-auth"] { left: 8px; }`],
    ["a wide gap", `[data-part="header-controls"] { gap: 200px; }`],
    ["a wide shell padding", `:root { --portal-shell-padding: 2000px; }`],
    ["a computed border", `[data-part="header-auth"] { border-width: calc(100px); }`],
    ["a site-property border", `[data-part="header-auth"] { border: var(--site-b); }`],
    [
      "a long generated text",
      `[data-part="header-auth"]::before { content: "a very long label"; }`,
    ],
  ])("refuses on a protected control or its containers: %s", (_name, css) =>
    rejects(css, "FP1905"),
  );

  it.each([
    [
      "a computed width",
      `[data-part="nav-toggle"]:focus-visible { outline-width: calc(1px - 1px); }`,
    ],
    ["a site property", `[data-part="nav-toggle"]:focus-visible { outline: var(--site-none); }`],
    ["none, on any rule", `.site-a { outline: none; }`],
    ["zero, on any rule", `[data-part="card"] { outline: 0; }`],
    ["a shorthand without a style", `.site-a:focus-visible { outline: 2px red; }`],
    ["a style of none", `.site-a { outline-style: none; }`],
    ["a transparent colour", `.site-a { outline-color: transparent; }`],
    ["a far offset", `.site-a { outline-offset: -50px; }`],
    ["a computed offset", `.site-a { outline-offset: calc(-100px); }`],
    ["a long transition", `.site-a { transition: outline-color 100s; }`],
    ["a long delay", `.site-a { transition-delay: 30s; }`],
    ["discrete transitions", `.site-a { transition-behavior: allow-discrete; }`],
    ["a transparent colour token anywhere", `.site-a { --portal-color-accent: transparent; }`],
  ])("refuses a focus indicator that cannot be shown to be visible: %s", (_name, css) =>
    rejects(css, "FP1905"),
  );

  it("accepts visible outlines and short transitions", () => {
    const result = check(`
.site-a:focus-visible { outline: 3px solid var(--portal-color-accent); outline-offset: 2px; }
[data-part="nav-toggle"]:focus-visible { outline-width: thick; outline-style: dotted; outline-color: #123456; }
.site-a { transition: color 0.2s ease-in-out, outline-color 150ms; }
[data-part="header-controls"] { padding: 0 12px; gap: 8px; border-left: 1px solid var(--portal-color-border); }
`);
    expect(result.errors).toEqual([]);
  });
});

describe("portal-style-v1: colours and generated text are checked as rendered", () => {
  it.each([
    [
      "a layout token as an outline width",
      `.site-a:focus-visible { outline: solid var(--portal-shell-padding); }`,
    ],
    [
      "a layout token as an outline colour",
      `.site-a { outline-color: var(--portal-shell-padding); }`,
    ],
    [
      "a token with a fallback",
      `.site-a { outline: 2px solid var(--portal-color-accent, transparent); }`,
    ],
    ["a computed alpha", `.site-a { outline-color: rgb(0 0 0 / calc(1 - 1)); }`],
    ["a computed channel", `.site-a { outline-color: rgb(calc(0) 0 0); }`],
    ["a faint alpha", `.site-a { outline-color: rgb(0 0 0 / 0.1); }`],
    ["a faint hex", `.site-a { outline-color: #00000010; }`],
    ["a colour mix", `.site-a { outline-color: color-mix(in srgb, red 0%, transparent); }`],
    ["a colour token from a site property", `.site-a { --portal-color-accent: var(--site-x); }`],
    [
      "a colour token from a length token",
      `:root { --portal-color-accent: var(--portal-shell-padding); }`,
    ],
    ["a computed colour token", `:root { --portal-color-accent: rgb(0 0 0 / calc(0)); }`],
    [
      "a layout token as a border on a control",
      `[data-part="header-auth"] { border: var(--portal-shell-padding) solid red; }`,
    ],
    [
      "a computed text colour on a control",
      `[data-part="header-auth"] { color: hsl(0 0% 0% / calc(0)); }`,
    ],
    [
      "a relative colour",
      `[data-part="nav-toggle"]:focus-visible { outline-color: rgb(from transparent r g b); }`,
    ],
    [
      "a relative text colour",
      `[data-part="header-auth"] { color: oklch(from transparent l c h); }`,
    ],
    ["a relative colour token", `:root { --portal-color-accent: hsl(from transparent h s l); }`],
    ["a missing alpha", `.site-a { outline-color: rgb(0 0 0 / none); }`],
    ["missing channels", `.site-a { outline-color: rgb(none none none); }`],
    ["a relative color()", `.site-a { outline-color: color(from red srgb r g b); }`],
  ])("refuses %s", (_name, css) => rejects(css, "FP1905"));

  it.each([
    [
      "thirty short strings",
      `[data-part="nav-toggle"]::before { content: ${'"abc" '.repeat(30)}; }`,
    ],
    ["two strings over the limit", `[data-part="header-auth"]::after { content: "ab" "cd"; }`],
    ["escaped characters", `[data-part="header-auth"]::after { content: "\\41\\42\\43\\44"; }`],
    ["a counter", `[data-part="header-auth"]::after { content: counter(item); }`],
  ])("limits generated text on a protected control in total: %s", (_name, css) =>
    rejects(css, "FP1905", "FP1904"),
  );

  it("accepts visible colours, colour tokens and a short glyph", () => {
    const result = check(`
:root { --portal-color-accent: #0b6e8a; --portal-color-surface: var(--portal-color-background); }
.site-a:focus-visible { outline: 2px solid var(--portal-color-accent); outline-color: rgb(10 20 30 / 0.8); }
.site-b { outline-color: color(display-p3 0.2 0.4 0.6); }
[data-part="header-auth"] { color: oklch(0.5 0.1 200deg / 90%); }
[data-part="header-auth"] { color: currentColor; border: 1px solid var(--portal-color-border); }
[data-part="header-auth"]::before { content: "→" " "; }
`);
    expect(result.errors).toEqual([]);
  });
});
