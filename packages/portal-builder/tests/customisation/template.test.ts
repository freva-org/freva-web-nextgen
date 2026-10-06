// portal-template-v1: slot templates are data with a tiny, closed language. Fields are escaped,
// markup goes through the sanitizer with a slot profile, links and images are validated, and a
// template can place only the sealed parts its slot takes.

import { describe, expect, it } from "vitest";
import { slotsApi } from "../../src/customisation/api.js";
import {
  compileTemplate,
  renderTemplate,
  segmentsText,
  type CompiledTemplate,
} from "../../src/customisation/template.js";
import { loadProfile } from "../../src/rendering/profile.js";

const api = slotsApi();
const { profile } = loadProfile();

function compile(source: string, slot = "footerTop") {
  return compileTemplate(source, {
    slot,
    file: "templates/t.html",
    api,
    resolveHref: (value) =>
      /^(https:\/\/|\/|#|mailto:)/.test(value) && !value.startsWith("//") ? value : undefined,
    resolveSrc: (value) => (value.startsWith("./") ? `/_portal/site/${value.slice(2)}` : undefined),
  });
}

const CONTEXT = {
  site: {
    title: "Centre <B>",
    subtitle: "",
    language: "en",
    institution: { name: "Centre & Co", url: "https://centre.example.org/" },
  },
  logo: { src: "/identity/logo.svg", light: "", dark: "", alt: "" },
  route: { path: "/", title: "Home", kind: "landing", isHome: true },
  links: [
    { label: "Docs", href: "/docs/", external: false, current: false },
    { label: "Data", href: "/data/", external: false, current: true },
  ],
  footer: { groups: [], legal: [], logos: [] },
  build: { year: "2025" },
};

function render(
  template: CompiledTemplate,
  context: Record<string, unknown> = CONTEXT,
  enabled = true,
) {
  return renderTemplate(template, context, { profile, api, partEnabled: () => enabled });
}

function errors(source: string, slot?: string): string[] {
  return compile(source, slot)
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.code);
}

describe("portal-template-v1 renders", () => {
  it("escapes fields in text and attribute values", () => {
    const { template, diagnostics } = compile(
      `<p class="site-x" title="{{ site.title }}">{{ site.title }} - {{ site.institution.name }}</p>`,
    );
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const html = segmentsText(render(template!).segments);
    expect(html).toContain("Centre &lt;B&gt; - Centre &amp; Co");
    expect(html).toContain('title="Centre &lt;B&gt;"');
    expect(html).not.toContain("<B>");
  });

  it("runs conditionals and loops over the typed context", () => {
    const { template } = compile(
      `<ul class="site-l">{% for link in links %}<li><a href="{{ link.href }}">{{ link.label }}</a></li>{% endfor %}</ul>{% if route.isHome %}<p>home</p>{% else %}<p>page</p>{% endif %}`,
    );
    const html = segmentsText(render(template!).segments);
    expect(html).toContain('<a href="/docs/">Docs</a>');
    expect(html).toContain('<a href="/data/">Data</a>');
    expect(html).toContain("<p>home</p>");
    expect(html).not.toContain("page");
  });

  it("places sealed parts as segments the framework renders", () => {
    const { template } = compile(
      `<div class="site-a">{% part "legal-links" %}</div>`,
      "footerBottom",
    );
    const result = render(template!);
    expect(result.segments.some((s) => "part" in s && s.part === "legal-links")).toBe(true);
    expect(template!.parts).toEqual(["legal-links"]);
  });

  it("renders a disabled feature's part as nothing, and reports it", () => {
    const { template } = compile(`{% part "search" %}`, "headerExtra");
    const result = render(template!, CONTEXT, false);
    expect(result.segments.some((s) => "part" in s)).toBe(false);
    expect(result.emptyParts).toEqual(["search"]);
  });

  it("is deterministic", () => {
    const { template } = compile(`<p>{{ site.title }} {{ build.year }}</p>`);
    expect(segmentsText(render(template!).segments)).toBe(segmentsText(render(template!).segments));
  });

  it("publishes the slot names and parts it implements in schema/slots-v1.json", () => {
    expect(Object.keys(api.slots).sort()).toEqual([
      "footerBottom",
      "footerColumns",
      "footerTop",
      "headerBrand",
      "headerExtra",
      "landingSectionShell",
      "proseAside",
    ]);
    expect(Object.keys(api.parts).sort()).toEqual([
      "auth",
      "blocks",
      "legal-links",
      "logo",
      "nav-links",
      "search",
      "theme-toggle",
    ]);
  });
});

describe("portal-template-v1 rejects, with a location", () => {
  it.each([
    ["script", `<script>alert(1)</script>`],
    ["style", `<style>p{}</style>`],
    ["iframe", `<iframe src="https://x.example.org/"></iframe>`],
    ["object", `<object data="./x.swf"></object>`],
    ["embed", `<embed src="./x.swf">`],
    ["form", `<form action="/x"><input name="q"></form>`],
    ["input", `<input name="q">`],
    ["an event handler", `<p onclick="alert(1)">x</p>`],
    ["an uppercase event handler", `<p ONMOUSEOVER="alert(1)">x</p>`],
    ["a style attribute", `<p style="color:red">x</p>`],
    ["an id", `<p id="portal-main">x</p>`],
    ["a framework class", `<p class="portal-header">x</p>`],
    ["target", `<a href="/x" target="_blank">x</a>`],
    ["a role outside the list", `<div role="button">x</div>`],
    ["an aria attribute outside the list", `<div aria-hidden="true">x</div>`],
    ["an img without alt", `<img src="./a.svg">`],
  ])("an element or attribute outside the slot profile: %s", (_name, source) => {
    expect(errors(source)).toContain("FP1914");
  });

  it.each([
    ["a javascript: link", `<a href="javascript:alert(1)">x</a>`],
    ["an entity-encoded javascript: link", `<a href="&#106;avascript:alert(1)">x</a>`],
    ["a data: link", `<a href="data:text/html,x">x</a>`],
    ["a protocol-relative link", `<a href="//evil.example.org/">x</a>`],
    ["a remote image", `<img src="https://x.example.org/a.png" alt="">`],
  ])("a link or image outside the policy: %s", (_name, source) => {
    expect(errors(source)).toContain("FP1917");
  });

  it("refuses a url field as an image source: a link may leave the site, an image may not", () => {
    expect(errors(`<img src="{{ site.institution.url }}" alt="Logo">`)).toContain("FP1912");
    expect(errors(`<picture><source srcset="{{ site.institution.url }}"></picture>`)).toContain(
      "FP1912",
    );
    expect(errors(`<img src="{{ logo.src }}" alt="Logo">`)).toEqual([]);
    expect(errors(`<a href="{{ logo.src }}">x</a>`)).toContain("FP1912");
  });

  it("renders a <picture> with a colour-mode <source>", () => {
    const source = `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="{{ logo.dark }}">
  <img src="{{ logo.src }}" alt="Logo">
</picture>`;
    const { template, diagnostics } = compile(source);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const withDark = render(template!, {
      ...CONTEXT,
      logo: { ...CONTEXT.logo, dark: "/_portal/site/logo-dark.0123abcd.svg" },
    });
    expect(withDark.diagnostics).toEqual([]);
    const html = segmentsText(withDark.segments);
    expect(html).toContain("<picture>");
    expect(html).toContain(
      '<source media="(prefers-color-scheme: dark)" srcset="/_portal/site/logo-dark.0123abcd.svg"',
    );
    expect(html).toContain('<img src="/identity/logo.svg" alt="Logo"');
    // Without a dark variant the candidate is left out, not emitted empty.
    const withoutDark = segmentsText(render(template!).segments);
    expect(withoutDark).not.toContain("<source");
    expect(withoutDark).toContain("<img");
  });

  it("allows <source> only directly inside <picture>", () => {
    expect(errors(`<div><source srcset="{{ logo.src }}"></div>`)).toContain("FP1914");
  });

  it("refuses an image field whose rendered value is not a same-origin path", () => {
    const { template } = compile(`<img src="{{ logo.src }}" alt="Logo">`);
    for (const src of ["https://cdn.example.org/logo.png", "//cdn.example.org/x.png", "data:x"]) {
      const result = render(template!, { ...CONTEXT, logo: { ...CONTEXT.logo, src } });
      expect(
        result.diagnostics.map((d) => d.code),
        src,
      ).toContain("FP1917");
      expect(segmentsText(result.segments), src).not.toContain("<img");
    }
    const ok = render(template!);
    expect(segmentsText(ok.segments)).toContain('<img src="/identity/logo.svg" alt="Logo"');
  });

  it("refuses a field in a link that is not a url field", () => {
    expect(errors(`<a href="{{ site.title }}">x</a>`)).toContain("FP1912");
  });

  it("refuses an href made of a field and literal text", () => {
    expect(errors(`<a href="javascript:{{ site.institution.url }}">x</a>`).length).toBeGreaterThan(
      0,
    );
  });

  it("refuses template syntax in an element or attribute name", () => {
    expect(errors(`<p {{ site.title }}="x">x</p>`).length).toBeGreaterThan(0);
    expect(errors(`<{{ site.title }}>x</p>`).length).toBeGreaterThan(0);
  });

  it("treats markup in a field value as text, not markup", () => {
    const { template } = compile(`<p>{{ site.title }}</p>`);
    const html = segmentsText(
      render(template!, {
        ...CONTEXT,
        site: { ...CONTEXT.site, title: "<script>alert(1)</script>" },
      }).segments,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("refuses unknown fields and mistyped uses, with line and column", () => {
    const result = compile(`<p>\n  {{ site.nope }}\n</p>`);
    const diagnostic = result.diagnostics.find((d) => d.code === "FP1912")!;
    expect(diagnostic.file).toBe("templates/t.html");
    expect(diagnostic.position).toEqual({ line: 2, column: 3 });
    expect(errors(`<p>{{ links }}</p>`)).toContain("FP1912");
    expect(errors(`{% for x in site.title %}{% endfor %}`)).toContain("FP1912");
  });

  it("refuses unknown, misplaced, repeated and looped parts", () => {
    expect(errors(`{% part "nope" %}`)).toContain("FP1913");
    expect(errors(`{% part "auth" %}`, "footerTop")).toContain("FP1913");
    expect(errors(`{% part "logo" %}{% part "logo" %}`, "footerTop")).toContain("FP1913");
    expect(errors(`{% for l in links %}{% part "logo" %}{% endfor %}`)).toContain("FP1913");
    expect(errors(`<div>no blocks</div>`, "landingSectionShell")).toContain("FP1913");
  });

  it("allows one wrapper around a protected part, and no more", () => {
    expect(errors(`<span class="site-a">{% part "auth" %}</span>`, "headerExtra")).toEqual([]);
    expect(
      errors(
        `<span class="site-a"><span class="site-b">{% part "auth" %}</span></span>`,
        "headerExtra",
      ),
    ).toContain("FP1913");
  });

  it("refuses a protected part inside a condition", () => {
    expect(errors(`{% if route.isHome %}{% part "auth" %}{% endif %}`, "headerExtra")).toContain(
      "FP1913",
    );
  });

  it("refuses unbalanced or unknown tags", () => {
    expect(errors(`{% if route.isHome %}<p>x</p>`)).toContain("FP1911");
    expect(errors(`{% endfor %}`)).toContain("FP1911");
    expect(errors(`{% include "x" %}`)).toContain("FP1911");
    expect(errors(`{{ site.title | safe }}`)).toContain("FP1911");
  });

  it("caps loops at the published iteration cap", () => {
    const { template } = compile(
      `{% for a in links %}{% for b in links %}<span>{{ b.label }}</span>{% endfor %}{% endfor %}`,
    );
    const many = Array.from({ length: api.iterationCap + 1 }, (_, i) => ({
      label: `L${i}`,
      href: "/x/",
      external: false,
      current: false,
    }));
    const result = render(template!, { ...CONTEXT, links: many });
    expect(result.diagnostics.map((d) => d.code)).toContain("FP1916");
  });

  it.each([
    ["in text, hexadecimal", `<p>&#xE010;auth&#xE011;</p>`],
    ["in text, decimal", `<p>&#57360;auth&#57361;</p>`],
    ["without semicolons", `<p>&#xe010auth&#xe011</p>`],
    ["in an attribute", `<p title="&#xE010;auth&#xE011;">x</p>`],
    ["as a forged field marker", `<p>&#xE000;0&#xE001;</p>`],
  ])("refuses character references to reserved markers: %s", (_name, source) => {
    expect(errors(source, "footerBottom")).toContain("FP1911");
  });

  it("renders a part only from a part node, never from marker text that reached the tree", () => {
    const marker = "\uE010auth\uE011";
    const template: CompiledTemplate = {
      slot: "footerBottom",
      file: "templates/t.html",
      nodes: [
        {
          t: "element",
          tag: "p",
          attrs: [{ name: "title", pieces: [marker], pos: { line: 1 } }],
          children: [{ t: "text", value: marker }],
          pos: { line: 1 },
        },
      ],
      parts: [],
      protectedSiteClasses: [],
    };
    const result = render(template, CONTEXT, false);
    expect(result.segments.some((s) => "part" in s)).toBe(false);
    expect(segmentsText(result.segments)).toBe('<p title="auth">auth</p>');
  });

  it("scans templates for credentials", () => {
    expect(errors(`<p>password=hunter22</p>`)).toContain("FP1210");
  });

  it("refuses an oversized template", () => {
    expect(errors(`<p>${"x".repeat(70 * 1024)}</p>`)).toContain("FP1407");
  });
});
