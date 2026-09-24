// Section navigation defends two things that pull in different directions. A reader on any page
// of a documentation directory can see the rest of it without an author having typed a single
// link; and nothing about that is inferred from a URL, because the file tree decides membership
// and every way of guessing it from the final route is wrong in a way that only shows up on
// somebody else's site.
//
// The rendering half - one rail, two groups, exactly one `aria-current` - is asserted against
// built HTML rather than the model, because a correct model can still render into wrong markup.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, codes, resolveFixture, tempRoot, writeSite } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import {
  deriveSectionTitle,
  humanizeSegment,
  orderSection,
  type SectionCandidate,
} from "../../src/model/section-navigation.js";
import type { ResolvedRoute } from "../../src/model/types.js";

afterAll(cleanupFixtures);

const page = (title: string, body = "Body text.\n"): string =>
  `---\ntitle: ${JSON.stringify(title)}\n---\n\n${body}`;

/** A site with one content source mounted at `/docs/`. */
function docsSite(root: string, content: Record<string, string>, extra = ""): void {
  writeSite(root, {
    content,
    extra: `rendering:\n  profile: portal-content-v1\n  sources:\n    - root: ./content\n      mount: /docs/\n${extra}`,
  });
}

function sectionOf(routes: readonly ResolvedRoute[], path: string) {
  return routes.find((route) => route.path === path)?.sectionNavigation;
}

// membership

describe("what a section is", () => {
  it("1. an index plus two siblings is one three-item section", async () => {
    const root = tempRoot("secnav-basic-");
    docsSite(root, {
      "content/storage-concepts/index.md": page("HEALPix in Zarr on S3"),
      "content/storage-concepts/why-healpix.md": page("Why HEALPix?"),
      "content/storage-concepts/zarr-and-s3.md": page("Why Zarr and S3?"),
    });
    const { model, diagnostics } = await resolveFixture(root);
    expect(codes(diagnostics)).toEqual([]);
    const section = sectionOf(model!.routes, "/docs/storage-concepts/");
    expect(section).toBeDefined();
    expect(section!.title).toBe("Storage Concepts");
    expect(section!.sourceDirectory).toBe("content/storage-concepts");
    expect(section!.items.map((i) => i.title)).toEqual([
      "HEALPix in Zarr on S3",
      "Why HEALPix?",
      "Why Zarr and S3?",
    ]);
    expect(section!.items.map((i) => i.href)).toEqual([
      "/docs/storage-concepts/",
      "/docs/storage-concepts/why-healpix/",
      "/docs/storage-concepts/zarr-and-s3/",
    ]);
  });

  it("2. every page in the directory gets the same ordered section", async () => {
    const root = tempRoot("secnav-shared-");
    docsSite(root, {
      "content/guide/index.md": page("Guide"),
      "content/guide/install.md": page("Install"),
      "content/guide/upgrade.md": page("Upgrade"),
    });
    const { model } = await resolveFixture(root);
    const paths = ["/docs/guide/", "/docs/guide/install/", "/docs/guide/upgrade/"];
    const sections = paths.map((path) => sectionOf(model!.routes, path));
    for (const section of sections) {
      expect(section?.items.map((i) => i.source)).toEqual([
        "content/guide/index.md",
        "content/guide/install.md",
        "content/guide/upgrade.md",
      ]);
    }
    // The SAME object, not an equal one. One frozen section per directory keeps the model from
    // carrying N copies of one list, and is possible only because the current page is not marked
    // in the model.
    expect(sections[0]).toBe(sections[1]);
    expect(sections[1]).toBe(sections[2]);
    expect(Object.isFrozen(sections[0])).toBe(true);
    expect(Object.isFrozen(sections[0]!.items)).toBe(true);
  });

  it("6. a one-page directory produces no section at all", async () => {
    const root = tempRoot("secnav-lonely-");
    docsSite(root, {
      "content/alone/index.md": page("Alone"),
      "content/other/index.md": page("Other"),
      "content/other/second.md": page("Second"),
    });
    const { model } = await resolveFixture(root);
    // Two directories with one page each would be two lists whose single entry is the page
    // already being read.
    expect(sectionOf(model!.routes, "/docs/alone/")).toBeUndefined();
    expect(sectionOf(model!.routes, "/docs/other/")).toBeDefined();
  });

  it("10. a nested directory is its own section and never joins its parent's list", async () => {
    const root = tempRoot("secnav-nested-");
    docsSite(root, {
      "content/guide/index.md": page("Guide"),
      "content/guide/install.md": page("Install"),
      "content/guide/advanced/index.md": page("Advanced"),
      "content/guide/advanced/tuning.md": page("Tuning"),
    });
    const { model } = await resolveFixture(root);
    const parent = sectionOf(model!.routes, "/docs/guide/")!;
    const child = sectionOf(model!.routes, "/docs/guide/advanced/")!;
    expect(parent.items.map((i) => i.source)).toEqual([
      "content/guide/index.md",
      "content/guide/install.md",
    ]);
    expect(child.items.map((i) => i.source)).toEqual([
      "content/guide/advanced/index.md",
      "content/guide/advanced/tuning.md",
    ]);
    expect(parent.sourceDirectory).toBe("content/guide");
    expect(child.sourceDirectory).toBe("content/guide/advanced");
  });

  it("11. two content sources with the same directory name never mix", async () => {
    const root = tempRoot("secnav-two-roots-");
    writeSite(root, {
      content: {
        "docs-a/concepts/index.md": page("A index"),
        "docs-a/concepts/one.md": page("A one"),
        "docs-b/concepts/index.md": page("B index"),
        "docs-b/concepts/one.md": page("B one"),
      },
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./docs-a
      mount: /a/
    - root: ./docs-b
      mount: /b/
`,
    });
    const { model } = await resolveFixture(root);
    const a = sectionOf(model!.routes, "/a/concepts/")!;
    const b = sectionOf(model!.routes, "/b/concepts/")!;
    // Both directories are called `concepts`. Keying on the mount, on the URL, or on the
    // directory name alone merges them into one four-item section on both sites.
    expect(a.items.map((i) => i.title)).toEqual(["A index", "A one"]);
    expect(b.items.map((i) => i.title)).toEqual(["B index", "B one"]);
    expect(a.sourceDirectory).toBe("docs-a/concepts");
    expect(b.sourceDirectory).toBe("docs-b/concepts");
  });

  it("12. include and exclude rules decide what a section contains", async () => {
    const root = tempRoot("secnav-filters-");
    writeSite(root, {
      content: {
        "content/guide/index.md": page("Guide"),
        "content/guide/install.md": page("Install"),
        "content/guide/_draft.md": page("Draft"),
      },
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
      files:
        exclude:
          - "**/_*.md"
`,
    });
    const { model } = await resolveFixture(root);
    const section = sectionOf(model!.routes, "/docs/guide/")!;
    expect(section.items.map((i) => i.source)).toEqual([
      "content/guide/index.md",
      "content/guide/install.md",
    ]);
    expect(model!.routes.some((r) => r.source === "content/guide/_draft.md")).toBe(false);
  });

  it("13. Markdown and RST pages coexist in one section", async () => {
    const root = tempRoot("secnav-mixed-");
    docsSite(root, {
      "content/mixed/index.md": page("Mixed"),
      "content/mixed/beta.md": page("Beta"),
      "content/mixed/alpha.rst": "Alpha\n=====\n\nAn RST page.\n",
    });
    const { model, diagnostics } = await resolveFixture(root);
    expect(codes(diagnostics)).toEqual([]);
    const section = sectionOf(model!.routes, "/docs/mixed/")!;
    // Index first, then the two by filename: `alpha.rst` before `beta.md`.
    expect(section.items.map((i) => i.source)).toEqual([
      "content/mixed/index.md",
      "content/mixed/alpha.rst",
      "content/mixed/beta.md",
    ]);
    expect(section.items.map((i) => i.title)).toEqual(["Mixed", "Alpha", "Beta"]);
  });

  it("14. a frontmatter path override keeps source membership and links to the new route", async () => {
    const root = tempRoot("secnav-override-");
    docsSite(root, {
      "content/guide/index.md": page("Guide"),
      "content/guide/install.md":
        "---\ntitle: Install\npath: /docs/getting-started/\n---\n\nMoved.\n",
    });
    const { model } = await resolveFixture(root);
    const section = sectionOf(model!.routes, "/docs/guide/")!;
    // The page belongs to `content/guide`, where the file is, and the link goes where the page
    // lives. Deriving membership from the route throws a moved page out of its own section.
    expect(section.items.map((i) => i.source)).toEqual([
      "content/guide/index.md",
      "content/guide/install.md",
    ]);
    expect(section.items[1]!.href).toBe("/docs/getting-started/");
    expect(sectionOf(model!.routes, "/docs/getting-started/")).toBe(section);
  });

  it("distinguishes `guide.md` from `guide/index.md`, which a URL cannot", async () => {
    const root = tempRoot("secnav-flat-");
    docsSite(root, {
      "content/guide.md": page("Guide"),
      "content/reference.md": page("Reference"),
      "content/topics/index.md": page("Topics"),
      "content/topics/one.md": page("One"),
    });
    const { model } = await resolveFixture(root);
    // Two files at the content root are siblings of each other, named by the mount.
    const rootSection = sectionOf(model!.routes, "/docs/guide/")!;
    expect(rootSection.title).toBe("Docs");
    expect(rootSection.sourceDirectory).toBe("content");
    expect(rootSection.items.map((i) => i.source)).toEqual([
      "content/guide.md",
      "content/reference.md",
    ]);
    // And `topics/` is a different section, even though `/docs/guide/` and `/docs/topics/` are
    // siblings as URLs.
    expect(sectionOf(model!.routes, "/docs/topics/")).not.toBe(rootSection);
  });
});

// ordering

describe("ordering", () => {
  it("3. the index page is first by default", () => {
    const made = (name: string, isIndex = false, navOrder?: number): SectionCandidate => ({
      source: `content/s/${name}`,
      contentRoot: "content",
      directory: "s",
      isIndex,
      mount: "/docs/",
      route: `/docs/s/${name}/`,
      title: name,
      filename: name,
      ...(navOrder === undefined ? {} : { navOrder }),
    });
    const ordered = orderSection([made("zeta.md"), made("index.md", true), made("alpha.md")]);
    expect(ordered.map((p) => p.filename)).toEqual(["index.md", "alpha.md", "zeta.md"]);
  });

  it("4. navOrder moves a sibling, and does nothing else", async () => {
    const root = tempRoot("secnav-order-");
    docsSite(root, {
      "content/guide/index.md": page("Guide"),
      "content/guide/alpha.md": "---\ntitle: Alpha\nnavOrder: 20\n---\n\nA.\n",
      "content/guide/zeta.md": "---\ntitle: Zeta\nnavOrder: 10\n---\n\nZ.\n",
    });
    const { model, diagnostics } = await resolveFixture(root);
    expect(codes(diagnostics)).toEqual([]);
    const section = sectionOf(model!.routes, "/docs/guide/")!;
    expect(section.items.map((i) => i.title)).toEqual(["Guide", "Zeta", "Alpha"]);
    // It orders siblings. It does not move a route, and it does not create or remove a page.
    expect(model!.routes.map((r) => r.path)).toContain("/docs/guide/zeta/");
    expect(model!.routes.map((r) => r.path)).toContain("/docs/guide/alpha/");
    expect(model!.routes.filter((r) => r.kind === "content")).toHaveLength(3);
  });

  it("5. equal navOrder values fall back to the source filename", async () => {
    const root = tempRoot("secnav-tie-");
    docsSite(root, {
      "content/guide/index.md": page("Guide"),
      "content/guide/beta.md": "---\ntitle: Beta\nnavOrder: 5\n---\n\nB.\n",
      "content/guide/alpha.md": "---\ntitle: Alpha\nnavOrder: 5\n---\n\nA.\n",
      "content/guide/gamma.md": "---\ntitle: Gamma\nnavOrder: 5\n---\n\nG.\n",
    });
    const { model } = await resolveFixture(root);
    const section = sectionOf(model!.routes, "/docs/guide/")!;
    expect(section.items.map((i) => i.title)).toEqual(["Guide", "Alpha", "Beta", "Gamma"]);
  });

  it("orders by code point, never by locale", async () => {
    const root = tempRoot("secnav-codepoint-");
    docsSite(root, {
      "content/guide/index.md": page("Guide"),
      "content/guide/Zebra.md": page("Zebra"),
      "content/guide/apple.md": page("apple"),
      "content/guide/Ápple.md": page("Ápple"),
    });
    const { model } = await resolveFixture(root);
    const section = sectionOf(model!.routes, "/docs/guide/")!;
    // `Z` (0x5A) < `a` (0x61) < `Á` (0xC1). A locale-aware sort would interleave them.
    expect(section.items.map((i) => i.title)).toEqual(["Guide", "Zebra", "apple", "Ápple"]);
  });

  it("rejects a navOrder that is not a bounded integer, and names both reasons", async () => {
    const fractional = tempRoot("secnav-frac-");
    docsSite(fractional, {
      "content/guide/index.md": page("Guide"),
      "content/guide/a.md": "---\ntitle: A\nnavOrder: 1.5\n---\n\nA.\n",
    });
    const first = await resolveFixture(fractional);
    expect(codes(first.diagnostics)).toContain("PC1005");
    expect(first.diagnostics.items.map((d) => d.message).join("\n")).toMatch(/must be an integer/);

    const huge = tempRoot("secnav-huge-");
    docsSite(huge, {
      "content/guide/index.md": page("Guide"),
      "content/guide/a.md": "---\ntitle: A\nnavOrder: 20260902\n---\n\nA.\n",
    });
    const second = await resolveFixture(huge);
    // A year in the wrong key sorts silently and wrongly, which is why the range is bounded.
    expect(second.diagnostics.items.map((d) => d.message).join("\n")).toMatch(/must be between/);
  });

  it("rejects an alias rather than guessing what it meant", async () => {
    const root = tempRoot("secnav-alias-");
    docsSite(root, {
      "content/guide/index.md": page("Guide"),
      "content/guide/a.md": "---\ntitle: A\nnav_order: 3\n---\n\nA.\n",
    });
    const { diagnostics } = await resolveFixture(root);
    const text = diagnostics.items.map((d) => `${d.code} ${d.message}`).join("\n");
    expect(text).toMatch(/Unknown frontmatter key 'nav_order'/);
  });
});

// titles

describe("the section title", () => {
  it("humanizes a directory name", () => {
    expect(humanizeSegment("storage-concepts")).toBe("Storage Concepts");
    expect(humanizeSegment("technical-decisions")).toBe("Technical Decisions");
    expect(humanizeSegment("getting_started")).toBe("Getting Started");
    expect(humanizeSegment("apiReference")).toBe("Api Reference");
    // Unicode: the first character is upper-cased, the rest is left alone.
    expect(humanizeSegment("über-uns")).toBe("Über Uns");
    expect(humanizeSegment("日本語")).toBe("日本語");
  });

  it("prefers a navigation label that already names the section", () => {
    const title = deriveSectionTitle(
      "storage-concepts",
      "/docs/",
      "/docs/storage-concepts/",
      "HEALPix in Zarr on S3",
      [
        { label: "Elsewhere", href: "/docs/other/", external: false },
        { label: "Storage & access", href: "/docs/storage-concepts/", external: false },
      ],
    );
    expect(title).toBe("Storage & access");
  });

  it("ignores an external link that happens to end the same way", () => {
    const title = deriveSectionTitle("guide", "/docs/", "/docs/guide/", "Guide index", [
      { label: "Mirror", href: "https://elsewhere.test/docs/guide/", external: true },
    ]);
    expect(title).toBe("Guide");
  });

  it("falls back to the mount for the content root, and to the index title last", () => {
    expect(deriveSectionTitle("", "/user-guide/", undefined, "Front page", [])).toBe("User Guide");
    // Nothing to humanize at all: the index page's own title is the last resort.
    expect(deriveSectionTitle("", "/", undefined, "Front page", [])).toBe("Front page");
  });
});

// rendering

describe("the document rail", () => {
  const build = async (
    root: string,
    prefix: string,
  ): Promise<{ html: (path: string) => string }> => {
    const out = join(root, "..", `${prefix}${process.pid}`);
    const result = await buildFixture(root, out);
    expect(result.diagnostics.items.filter((d) => d.severity === "error")).toEqual([]);
    return {
      html: (path: string) => readFileSync(join(out, ...path.split("/")), "utf8"),
    };
  };

  it("7. a page with no eligible headings still gets its section", async () => {
    const root = tempRoot("secnav-short-");
    docsSite(root, {
      "content/guide/index.md": page("Guide", "One paragraph and no headings at all.\n"),
      "content/guide/install.md": page("Install", "## A\n\ntext\n\n## B\n\ntext\n"),
    });
    const { html } = await build(root, "secnav-short-out-");
    const index = html("docs/guide/index.html");
    // The rail does not depend on the contents list. Tying the two-column layout to the contents
    // list costs a short introduction page - where "what else is in this section?" matters most
    // - its entire left column.
    expect(index).toContain('data-rail="true"');
    expect(index).toContain("portal-section-nav");
    expect(index).not.toContain("portal-toc-list");
  });

  it("8. a page with only a contents list keeps the two-column layout", async () => {
    const root = tempRoot("secnav-toconly-");
    docsSite(root, {
      "content/alone.md": page("Alone", "## A\n\ntext\n\n## B\n\ntext\n"),
    });
    const { html } = await build(root, "secnav-toconly-out-");
    const only = html("docs/alone/index.html");
    expect(only).toContain('data-rail="true"');
    expect(only).toContain("portal-toc-list");
    expect(only).not.toContain("portal-section-nav");
  });

  it("9. a page with both shows ONE outline, opened at the page being read", async () => {
    // One outline: the section's pages, with the current page's headings nested under its own
    // entry, so there is one list, one accessible name, and the nesting says which page the
    // headings belong to. Two lists in one rail - the section, then a second headed "On this
    // page" - leave a reader working out which column they are in, with the headings of the page
    // they are reading further from its title than the titles of pages they are not.
    const root = tempRoot("secnav-both-");
    docsSite(root, {
      "content/guide/index.md": page("Guide"),
      "content/guide/install.md": page("Install", "## A\n\ntext\n\n## B\n\ntext\n"),
    });
    const { html } = await build(root, "secnav-both-out-");
    const both = html("docs/guide/install/index.html");
    const rail = both.indexOf("portal-doc-rail");
    const sectionNav = both.indexOf("portal-section-nav");
    const current = both.indexOf('aria-current="page"');
    const toc = both.indexOf("portal-toc-list");
    const article = both.indexOf("portal-document");
    expect(rail).toBeGreaterThan(-1);
    // One rail; the section above the headings; both before the article in reading order.
    expect(both.match(/portal-doc-rail/g)).toHaveLength(1);
    expect(sectionNav).toBeGreaterThan(rail);
    expect(toc).toBeGreaterThan(sectionNav);
    expect(article).toBeGreaterThan(toc);
    // One navigation region with one name, and no second heading over a second list, SCOPED TO
    // THE RAIL. The medium-width breadcrumb bar has its own "On this page" block, and the two
    // are never visible at the same width - the bar is 720-1023px, the rail 1024px and up - so
    // checking the whole document would fail on a region this reader never sees at once.
    const railHtml = both.slice(rail, article);
    expect(both).toContain('aria-labelledby="portal-section-nav-title"');
    expect(railHtml).not.toContain('aria-labelledby="portal-toc-title"');
    expect(railHtml).not.toContain(">On this page</p>");
    // The headings hang off the current page's entry, not off the list.
    expect(current).toBeGreaterThan(-1);
    expect(toc).toBeGreaterThan(current);
    expect(both.slice(current, toc)).not.toContain("</ul>");
  });

  it("9b. a page with headings and no section list still gets its outline", async () => {
    // Nested is only possible when there is an entry to nest under. A standalone document, or a
    // section of one page, keeps the free-standing list and the heading that names it.
    const root = tempRoot("secnav-toc-only-");
    docsSite(root, {
      "content/guide/index.md": page("Guide", "## A\n\ntext\n\n## B\n\ntext\n"),
    });
    const { html } = await build(root, "secnav-toc-only-out-");
    const only = html("docs/guide/index.html");
    expect(only).toContain('aria-labelledby="portal-toc-title"');
    expect(only).toContain(">On this page</p>");
    expect(only).not.toContain("portal-section-nav-list");
  });

  it("16. exactly one aria-current=page, on the page being read", async () => {
    const root = tempRoot("secnav-current-");
    docsSite(root, {
      "content/guide/index.md": page("Guide"),
      "content/guide/install.md": page("Install"),
      "content/guide/upgrade.md": page("Upgrade"),
    });
    const { html } = await build(root, "secnav-current-out-");
    for (const [file, expected] of [
      ["docs/guide/index.html", "Guide"],
      ["docs/guide/install/index.html", "Install"],
      ["docs/guide/upgrade/index.html", "Upgrade"],
    ] as const) {
      const document = html(file);
      const marks = document.match(/aria-current="page"/g) ?? [];
      expect(marks).toHaveLength(1);
      const at = document.indexOf('aria-current="page"');
      // The marked link is the one whose text is this page's title.
      expect(document.slice(at, at + 200)).toContain(expected);
    }
  });

  it("17. section links are not selected by the in-page heading tracker", async () => {
    const root = tempRoot("secnav-tracker-");
    docsSite(root, {
      "content/guide/index.md": page("Guide"),
      "content/guide/install.md": page("Install", "## A\n\ntext\n\n## B\n\ntext\n"),
    });
    const { html } = await build(root, "secnav-tracker-out-");
    const document = html("docs/guide/install/index.html");
    // `initToc()` selects `.portal-toc-link` and marks the active heading with
    // `aria-current="true"`. A section link must not answer that selector, or scrolling moves
    // the "you are here" mark off the current page and onto a heading.
    const sectionLinks = document.match(/class="portal-section-nav-link"/g) ?? [];
    expect(sectionLinks.length).toBeGreaterThan(0);
    for (const link of document.match(/<a class="[^"]*"/g) ?? []) {
      if (link.includes("portal-section-nav-link")) expect(link).not.toContain("portal-toc-link");
    }
    const shell = readFileSync(join(REPO_ROOT_CLIENT, "client", "shell.ts"), "utf8");
    expect(shell).toContain('querySelectorAll<HTMLAnchorElement>(".portal-toc-link")');
    expect(shell).not.toContain("portal-section-nav-link");
  });

  it("18. the complete navigation is in the HTML, with no JavaScript involved", async () => {
    const root = tempRoot("secnav-nojs-");
    docsSite(root, {
      "content/guide/index.md": page("Guide"),
      "content/guide/install.md": page("Install"),
      "content/guide/upgrade.md": page("Upgrade"),
    });
    const { html } = await build(root, "secnav-nojs-out-");
    const document = html("docs/guide/index.html");
    for (const href of [
      'href="/docs/guide/"',
      'href="/docs/guide/install/"',
      'href="/docs/guide/upgrade/"',
    ]) {
      expect(document).toContain(href);
    }
    // Nothing in the rail is a script, a template or a data island.
    const rail = document.slice(
      document.indexOf("portal-doc-rail"),
      document.indexOf("portal-document"),
    );
    expect(rail).not.toContain("<script");
    expect(rail).not.toContain("data-portal-");
  });

  it("19. no section markup on landing, component, callback or error routes", async () => {
    const root = tempRoot("secnav-other-routes-");
    docsSite(root, {
      "content/guide/index.md": page("Guide"),
      "content/guide/install.md": page("Install"),
    });
    const { html } = await build(root, "secnav-other-out-");
    expect(html("index.html")).not.toContain("portal-section-nav");
    expect(html("404.html")).not.toContain("portal-section-nav");
    expect(html("500.html")).not.toContain("portal-section-nav");
  });

  it("15. a base-path deployment links through the base path", async () => {
    const root = tempRoot("secnav-base-");
    writeSite(root, {
      canonicalUrl: "https://portal.example.org/portal/",
      content: {
        "content/guide/index.md": page("Guide"),
        "content/guide/install.md": page("Install"),
      },
      extra: `rendering:\n  profile: portal-content-v1\n  sources:\n    - root: ./content\n      mount: /docs/\n`,
    });
    const { model } = await resolveFixture(root);
    const section = sectionOf(model!.routes, "/docs/guide/")!;
    expect(section.items.map((i) => i.href)).toEqual([
      "/portal/docs/guide/",
      "/portal/docs/guide/install/",
    ]);
  });

  it("escapes a hostile title rather than emitting it as markup", async () => {
    const root = tempRoot("secnav-escape-");
    docsSite(root, {
      "content/guide/index.md": page("Guide"),
      "content/guide/evil.md": page('</a><script>alert(1)</script> & "quoted"'),
    });
    const { html } = await build(root, "secnav-escape-out-");
    const document = html("docs/guide/index.html");
    const rail = document.slice(
      document.indexOf("portal-doc-rail"),
      document.indexOf("portal-document"),
    );
    expect(rail).not.toContain("<script>");
    expect(rail).toContain("&lt;/a&gt;&lt;script&gt;");
    expect(rail).toContain("&amp;");
  });

  it("carries a long Unicode title without widening anything", async () => {
    const root = tempRoot("secnav-unicode-");
    const long = "Ein außergewöhnlich langer Abschnittstitel über Datenspeicherung und Zugriff";
    docsSite(root, {
      "content/übersicht/index.md": page("Übersicht"),
      "content/übersicht/lang.md": page(long),
    });
    const { model, diagnostics } = await resolveFixture(root);
    expect(codes(diagnostics)).toEqual([]);
    const section =
      sectionOf(model!.routes, "/docs/%C3%BCbersicht/") ??
      sectionOf(model!.routes, "/docs/übersicht/");
    expect(section).toBeDefined();
    expect(section!.title).toBe("Übersicht");
    expect(section!.items.map((i) => i.title)).toContain(long);
  });

  it("20. a site whose directories hold one page each gets no rail it did not have", async () => {
    const root = tempRoot("secnav-unchanged-");
    docsSite(root, { "content/guide.md": page("Guide", "One paragraph.\n") });
    const { html } = await build(root, "secnav-unchanged-out-");
    const document = html("docs/guide/index.html");
    // No section, no contents list, and therefore the centred document with no empty gutter.
    expect(document).toContain('data-rail="false"');
    // And no `data-toc`: the layout does not key on it and nothing else reads it. A test
    // asserting a dead hook is emitted is what keeps dead selectors alive.
    expect(document).not.toContain("data-toc");
    expect(document).not.toContain("portal-doc-rail");
    expect(document).not.toContain("portal-section-nav");
  });
});

/** The package root, for the one test that reads the client source. */
const REPO_ROOT_CLIENT = new URL("../..", import.meta.url).pathname;
