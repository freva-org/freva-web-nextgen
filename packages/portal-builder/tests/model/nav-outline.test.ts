// The narrow-width outline (phone drill-down, tablet dropdown) and the desktop section rail must
// agree on which pages belong to a section: both key it on the source directory, so a page whose
// frontmatter `path` moves it outside the header link's URL prefix is in both.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, codes, resolveFixture, tempRoot, writeSite } from "../helpers/fixture.js";
import { buildFixture } from "../helpers/site.js";

afterAll(cleanupFixtures);

const page = (title: string, extra = ""): string =>
  `---\ntitle: ${JSON.stringify(title)}\n${extra}---\n\n# ${title}\n\n## One\n\nText.\n\n## Two\n\nText.\n`;

/** The Waterpark storage-concepts shape: five files, two of them published outside the prefix. */
function storageConcepts(root: string, canonicalUrl?: string): void {
  writeSite(root, {
    ...(canonicalUrl ? { canonicalUrl } : {}),
    content: {
      "content/storage-concepts/index.md": page("HEALPix in Zarr on S3"),
      "content/storage-concepts/why-healpix.md": page("Why HEALPix?", "navOrder: 1\n"),
      "content/storage-concepts/zarr-and-s3.md": page("Why Zarr and S3?", "navOrder: 2\n"),
      "content/storage-concepts/technical-decisions.md": page(
        "Technical decisions",
        "navOrder: 3\npath: /docs/technical-decisions/\n",
      ),
      "content/storage-concepts/remapping-benchmark.md": page(
        "Remapping benchmark",
        "navOrder: 4\npath: /docs/remapping-benchmark/\n",
      ),
      "content/storage-concepts/deeper/index.md": page("Deeper"),
    },
    extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
navigation:
  header:
    - href: /docs/storage-concepts/
      label: Storage concepts
`,
  });
}

describe("nav outline membership", () => {
  it("lists every page the section rail lists, in the rail's order", async () => {
    const root = tempRoot("outline-rail-");
    storageConcepts(root);
    const { model, diagnostics } = await resolveFixture(root);
    expect(codes(diagnostics).filter((c) => !c.startsWith("FP12"))).toEqual([]);

    const index = model!.routes.find((r) => r.path === "/docs/storage-concepts/")!;
    const rail = index.sectionNavigation!.items.map((item) => item.href);
    expect(rail).toHaveLength(5);

    const section = model!.navOutline.find((s) => s.href === "/docs/storage-concepts/")!;
    const outline = section.pages.map((p) => p.href);
    // The index is the panel's "overview" row, not a page entry; everything else is the rail.
    expect(outline.slice(0, 4)).toEqual(rail.slice(1));
    expect(outline).toContain("/docs/technical-decisions/");
    expect(outline).toContain("/docs/remapping-benchmark/");
    // A deeper directory is not on the flat rail, but must stay reachable on a phone.
    expect(outline.slice(4)).toEqual(["/docs/storage-concepts/deeper/"]);
    expect(new Set(outline).size).toBe(outline.length);
  });

  it("uses base-path-aware hrefs under a non-root canonical URL", async () => {
    const root = tempRoot("outline-base-");
    storageConcepts(root, "https://portal.example.org/portal/");
    const { model } = await resolveFixture(root);
    const section = model!.navOutline.find((s) => s.href === "/portal/docs/storage-concepts/")!;
    expect(section).toBeDefined();
    expect(section.pages.map((p) => p.href)).toEqual([
      "/portal/docs/storage-concepts/why-healpix/",
      "/portal/docs/storage-concepts/zarr-and-s3/",
      "/portal/docs/technical-decisions/",
      "/portal/docs/remapping-benchmark/",
      "/portal/docs/storage-concepts/deeper/",
    ]);
  });

  it("renders the moved pages into the phone panel HTML", async () => {
    const root = tempRoot("outline-html-");
    storageConcepts(root);
    const dir = join(tempRoot("outline-html-out-"), "portal");
    const result = await buildFixture(root, dir);
    expect(result.diagnostics.items.filter((d) => d.severity === "error")).toEqual([]);
    const html = readFileSync(join(dir, "docs", "technical-decisions", "index.html"), "utf8");
    const panel = html.slice(html.indexOf('id="portal-navpanel"'));
    const start = panel.indexOf("data-portal-navpanel-section=");
    const level = panel.slice(start, panel.indexOf("</nav>", start));
    for (const href of [
      "/docs/storage-concepts/why-healpix/",
      "/docs/storage-concepts/zarr-and-s3/",
      "/docs/technical-decisions/",
      "/docs/remapping-benchmark/",
    ]) {
      expect(level).toContain(`href="${href}"`);
    }
    // The section is marked current on a page it owns but whose URL is outside its prefix.
    const row = panel.slice(0, panel.indexOf("data-portal-navpanel-drill="));
    expect(row.slice(row.lastIndexOf("<div")).includes('data-active="true"')).toBe(true);
  });

  it("gives sibling page links their own page, not their directory's list", async () => {
    // About and Contact as two tabs, backed by two files in one directory: each links to its page,
    // neither is the directory's front door, so neither is marked active for the other or gets its
    // list as a submenu.
    const root = tempRoot("outline-siblings-");
    writeSite(root, {
      content: {
        "content/site/about.md": page("About"),
        "content/site/contact.md": page("Contact"),
        "content/site/imprint.md": page("Imprint"),
      },
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
navigation:
  header:
    - href: /docs/site/about/
      label: About
    - href: /docs/site/contact/
      label: Contact
`,
    });
    const { model } = await resolveFixture(root);
    const about = model!.navOutline.find((s) => s.label === "About")!;
    const contact = model!.navOutline.find((s) => s.label === "Contact")!;
    expect(about.pages).toEqual([]);
    expect(contact.pages).toEqual([]);
    // The rail still lists the directory: that is where the siblings belong.
    const route = model!.routes.find((r) => r.path === "/docs/site/about/")!;
    expect(route.sectionNavigation?.items).toHaveLength(3);

    const dir = join(tempRoot("outline-siblings-out-"), "portal");
    const result = await buildFixture(root, dir);
    expect(result.diagnostics.items.filter((d) => d.severity === "error")).toEqual([]);
    const html = readFileSync(join(dir, "docs", "site", "about", "index.html"), "utf8");
    const nav = html.slice(
      html.indexOf('<nav class="portal-nav"'),
      html.indexOf("</nav>", html.indexOf('<nav class="portal-nav"')),
    );
    const active = [
      ...nav.matchAll(/<a class="portal-nav-item"[^>]*data-active="true"[^>]*>\s*([^<]+)/g),
    ].map((m) => m[1]!.trim());
    expect(active).toEqual(["About"]);
    // No drill-down: each is a plain destination in the phone panel.
    const panel = html.slice(html.indexOf('id="portal-navpanel"'));
    expect(panel).not.toContain('aria-label="Show pages in About"');
    expect(panel).not.toContain('aria-label="Show pages in Contact"');
  });
});
