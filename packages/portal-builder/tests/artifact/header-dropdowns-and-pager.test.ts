import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtures, resolveFixture, tempRoot, writeSite } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";
import { pagerSequence, sectionFor, type OutlineSection } from "../../src/model/nav-outline.js";

afterAll(cleanupFixtures);

const PAGE = (title: string): string => `---\ntitle: ${title}\n---\n\n${title} body.\n`;

function site(navigation: string): string {
  const root = tempRoot("nav-dropdowns-");
  writeSite(root, {
    content: {
      "content/examples/index.md": PAGE("Examples"),
      "content/examples/first.md": PAGE("First example"),
      "content/examples/second.md": PAGE("Second example"),
      "content/concepts/index.md": PAGE("Concepts"),
      "content/concepts/why.md": PAGE("Why"),
      "content/loose.md": PAGE("Loose"),
    },
    extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
navigation:
${navigation}`,
  });
  return root;
}

const NAVIGATION = `  pager: true
  header:
    - landing: home
      label: Home
    - label: Examples
      href: /docs/examples/
      links:
        - href: /docs/examples/
          label: Start here
        - href: /docs/examples/first/
          label: First
        - href: /docs/examples/second/
          label: Second
        - href: https://example.org/more
          label: Elsewhere
    - label: Concepts
      href: /docs/concepts/
`;

describe("header entries with links", () => {
  it("resolve their links and keep plain entries plain", async () => {
    const { model, diagnostics } = await resolveFixture(site(NAVIGATION));
    expect(diagnostics.errors).toEqual([]);
    const [, examples, concepts] = model!.navigation.header;
    expect(examples!.links!.map((link) => link.href)).toEqual([
      "/docs/examples/",
      "/docs/examples/first/",
      "/docs/examples/second/",
      "https://example.org/more",
    ]);
    expect(examples!.links![3]!.external).toBe(true);
    expect(concepts!.links).toBeUndefined();
  });

  it("make the outline section's pages, without repeating the entry's own target", async () => {
    const { model } = await resolveFixture(site(NAVIGATION));
    const examples = model!.navOutline.find((section) => section.label === "Examples")!;
    expect(examples.pages.map((page) => [page.title, page.href, page.external ?? false])).toEqual([
      ["First", "/docs/examples/first/", false],
      ["Second", "/docs/examples/second/", false],
      ["Elsewhere", "https://example.org/more", true],
    ]);
  });

  it("refuse an empty list and an unknown target", async () => {
    const empty = await resolveFixture(
      site(`  header:\n    - label: Examples\n      href: /docs/examples/\n      links: []\n`),
    );
    expect(empty.diagnostics.errors.length).toBeGreaterThan(0);
    const unknown = await resolveFixture(
      site(
        `  header:\n    - label: Examples\n      href: /docs/examples/\n      links:\n        - component: nowhere\n          label: Lost\n`,
      ),
    );
    expect(unknown.diagnostics.errors.length).toBeGreaterThan(0);
  });
});

describe("the pager", () => {
  it("follows the header order through each entry's links or section pages", async () => {
    const { model } = await resolveFixture(site(NAVIGATION));
    const pager = (path: string) => model!.routes.find((route) => route.path === path)?.pager;
    expect(pager("/docs/examples/")).toEqual({
      next: { title: "First example", href: "/docs/examples/first/" },
    });
    expect(pager("/docs/examples/second/")).toEqual({
      previous: { title: "First example", href: "/docs/examples/first/" },
      next: { title: "Concepts", href: "/docs/concepts/" },
    });
    expect(pager("/docs/concepts/why/")).toEqual({
      previous: { title: "Concepts", href: "/docs/concepts/" },
    });
    expect(pager("/docs/loose/")).toBeUndefined();
  });

  it("is off unless asked for", async () => {
    const { model } = await resolveFixture(site(NAVIGATION.replace("  pager: true\n", "")));
    expect(model!.routes.some((route) => route.pager)).toBe(false);
  });

  it("orders, skips what is not a page, and never repeats", () => {
    const sections: OutlineSection[] = [
      {
        label: "A",
        href: "/a/",
        external: false,
        pages: [{ title: "1", href: "/a/1/", headings: [] }],
      },
      { label: "Data", href: "/data/", external: false, pages: [] },
      {
        label: "B",
        href: "/b/",
        external: false,
        pages: [{ title: "1", href: "/a/1/", headings: [] }],
      },
    ];
    const pages = new Set(["/a/", "/a/1/", "/b/"]);
    expect(pagerSequence(sections, (href) => pages.has(href))).toEqual(["/a/", "/a/1/", "/b/"]);
    expect(sectionFor(sections, "/a/1/")).toBe("A");
    expect(sectionFor(sections, "/b/deeper/")).toBe("B");
    expect(sectionFor(sections, "/elsewhere/")).toBeUndefined();
  });

  it("gives a page to its exact, listed or most specific section before a broad one", () => {
    const page = (href: string) => ({ title: href, href, headings: [] });
    const sections: OutlineSection[] = [
      {
        label: "Docs",
        href: "/docs/",
        external: false,
        pages: [page("/docs/a/"), page("/docs/guides/"), page("/docs/guides/x/"), page("/moved/")],
      },
      { label: "Guides", href: "/docs/guides/", external: false, pages: [page("/docs/guides/x/")] },
      {
        label: "Picked",
        href: "/data/",
        external: false,
        explicit: true,
        pages: [page("/docs/a/")],
      },
    ];
    expect(sectionFor(sections, "/docs/guides/")).toBe("Guides");
    expect(sectionFor(sections, "/docs/guides/x/")).toBe("Guides");
    expect(sectionFor(sections, "/docs/guides/y/")).toBe("Guides");
    expect(sectionFor(sections, "/docs/a/")).toBe("Picked");
    expect(sectionFor(sections, "/docs/b/")).toBe("Docs");
    expect(sectionFor(sections, "/moved/")).toBe("Docs");
  });
});

describe("the built pages", () => {
  let html: (path: string) => string;

  beforeAll(async () => {
    const out = join(tempRoot("nav-dropdowns-built-"), "site");
    const result = await buildFixture(site(NAVIGATION), out);
    expect(result.diagnostics.errors).toEqual([]);
    html = (path) => readFileSync(join(out, ...path.split("/")), "utf8");
  }, 300_000);

  it("draw a dropdown with every link, and mark the entry current inside its section", () => {
    const page = html("docs/examples/first/index.html");
    const group = page.slice(page.indexOf('class="portal-menu portal-nav-group"'));
    expect(group).toMatch(
      /class="portal-nav-item portal-nav-group-link"[^>]*href="\/docs\/examples\/"[^>]*data-active="true"/,
    );
    expect(group).toContain('aria-label="Examples pages"');
    expect(group).toMatch(/role="menu"[^>]*hidden/);
    expect(group).toMatch(/href="\/docs\/examples\/first\/"[^>]*aria-current="page"/);
    expect(group).toMatch(/href="https:\/\/example.org\/more"[^>]*target="_blank"/);
  });

  it("end a content page with its previous and next pages", () => {
    const page = html("docs/examples/second/index.html");
    expect(page).toMatch(/class="portal-pager"/);
    expect(page).toMatch(/rel="prev"[^]*?First example/);
    expect(page).toMatch(/rel="next"[^]*?Concepts/);
    expect(html("docs/loose/index.html")).not.toContain("portal-pager");
  });
});
