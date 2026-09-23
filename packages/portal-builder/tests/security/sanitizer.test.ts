// The malicious-content corpus. Content is reviewed in Git, which reduces risk but does not
// protect against a compromised dependency, a mistaken paste, or a change in who owns the
// content directory.

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures } from "../helpers/fixture.js";
import { errorCodes, renderOne } from "../helpers/render.js";
import { sanitizeSvg } from "../../src/rendering/svg.js";
import { loadProfile } from "../../src/rendering/profile.js";
import { sanitize, serialize, h, t } from "../../src/rendering/html.js";
import type { Diagnostic } from "../../src/diagnostics.js";

afterAll(cleanupFixtures);

const { profile } = loadProfile();
const page = (body: string): string => `---\ntitle: T\n---\n\n${body}\n`;

describe("authored content", () => {
  it.each([
    ["<script>alert(1)</script>"],
    ['<img src=x onerror="alert(1)">'],
    ["<iframe src='https://evil.example'></iframe>"],
    ["<object data='x.swf'></object>"],
    ["<form action='/'><input name=x></form>"],
    ["<style>body{display:none}</style>"],
    ['<a href="#" onclick="alert(1)">x</a>'],
    ["<svg onload=alert(1)></svg>"],
  ])("refuses raw active HTML: %s", async (markup) => {
    const out = await renderOne("t.md", page(markup));
    expect(errorCodes(out)).toContain("PC1002");
    expect(out.html).not.toContain("alert(1)");
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
  ])("refuses the unsafe URL %s", async (url) => {
    const out = await renderOne("t.md", page(`[x](${url})`));
    expect(errorCodes(out)).toContain("PC1007");
  });

  it("refuses an id that collides with a portal shell identifier", () => {
    const diagnostics: Diagnostic[] = [];
    sanitize([h("div", { id: "portal-shell-x" }, [t("x")])], {
      profile,
      file: "t.md",
      diagnostics,
    });
    expect(diagnostics.map((d) => d.code)).toContain("PC1015");
  });

  it("refuses a class outside the profile namespaces", () => {
    const diagnostics: Diagnostic[] = [];
    sanitize([h("p", { class: "totally-custom" }, [t("x")])], {
      profile,
      file: "t.md",
      diagnostics,
    });
    expect(diagnostics.map((d) => d.code)).toContain("PC1015");
  });

  it("refuses an inline style that authored content produced", () => {
    const diagnostics: Diagnostic[] = [];
    sanitize([h("p", { style: "color:red" }, [t("x")])], { profile, file: "t.md", diagnostics });
    expect(diagnostics.map((d) => d.code)).toContain("PC1015");
  });
});

describe("SVG", () => {
  const svg = (body: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`;

  it("keeps a plain drawing and adds nothing", () => {
    const result = sanitizeSvg(
      svg('<rect width="10" height="10" fill="#123456"/>'),
      "logo.svg",
      profile,
    );
    expect(result.ok).toBe(true);
    expect(result.svg).toBe(
      // SVG elements are not HTML void elements, so they close explicitly. The assertion is
      // that the bytes are fixed, not which form wins.
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"></rect></svg>',
    );
  });

  it.each([
    ["a script element", "<script>alert(1)</script>"],
    ["an event handler", '<rect onload="alert(1)"/>'],
    ["a foreignObject", "<foreignObject><div>x</div></foreignObject>"],
    ["a use element", '<use href="#x"/>'],
    ["an external image", '<image href="https://evil.example/x.png"/>'],
    ["an animation", '<animate attributeName="x"/>'],
    ["an xlink reference", '<rect xlink:href="https://evil.example"/>'],
  ])("refuses %s", (_name, body) => {
    const result = sanitizeSvg(svg(body), "logo.svg", profile);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("PC1018");
  });

  it("refuses markup it cannot read exactly rather than repairing it", () => {
    const result = sanitizeSvg("<svg><rect></svg>", "logo.svg", profile);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("PC1018");
  });

  it("strips comments, processing instructions and doctypes", () => {
    const result = sanitizeSvg(
      `<?xml version="1.0"?><!DOCTYPE svg><!-- note -->${svg('<rect width="1" height="1"/>')}`,
      "logo.svg",
      profile,
    );
    expect(result.ok).toBe(true);
    expect(result.svg).not.toContain("<!--");
    expect(result.svg).not.toContain("<?xml");
  });
});

describe("the serializer", () => {
  it("escapes text and attributes deterministically", () => {
    const html = serialize([h("p", { title: 'a "b" & <c>' }, [t("x < y & z")])], profile);
    expect(html).toBe('<p title="a &quot;b&quot; &amp; &lt;c&gt;">x &lt; y &amp; z</p>');
  });

  it("writes void elements in one fixed form", () => {
    expect(serialize([h("br"), h("img", { src: "/a.png", alt: "" })], profile)).toBe(
      '<br /><img src="/a.png" alt="" />',
    );
  });
});
