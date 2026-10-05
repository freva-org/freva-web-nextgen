/**
 * The navigation outline the narrow-width chrome drills through.
 *
 * The header carries two levels of navigation. Site sections live in `navigation.header`; the
 * current page's own structure lives in the docs rail, which below 1024px stops being a column
 * and becomes a boxed list above the article - a full screen of contents before the first
 * sentence. Both levels are derived here as one tree, once, at build time, so the phone panel and
 * the tablet breadcrumb dropdown render the same data rather than two hand-kept copies.
 *
 * Nothing new is computed. Sections are the declared links; a section's pages are the linked
 * page's own `sectionNavigation` (the directory-based list the desktop rail draws), then any
 * deeper routes beneath the link; a page's groups are its own `toc`. See `ResolvedRoute`.
 */
import type { HeadingRef, ResolvedLink, ResolvedRoute } from "./types.js";

/** One heading in a page's outline, with the sub-headings that belong to it. */
export interface OutlineHeading {
  id: string;
  text: string;
  /** Sub-headings, which is what makes a group expandable rather than a leaf. */
  children: OutlineHeading[];
}

/** One page inside a section. */
export interface OutlinePage {
  title: string;
  href: string;
  /** The page's own headings, nested. Empty for a page with fewer than two. */
  headings: OutlineHeading[];
  external?: boolean;
}

/** One top-level site section: a header link, plus whatever sits beneath it. */
export interface OutlineSection {
  label: string;
  href: string;
  external: boolean;
  /**
   * Pages under this section. Empty means a plain destination - a component route, an external
   * link - and the narrow chrome links straight to it instead of a drill-down that leads nowhere.
   */
  pages: OutlinePage[];
  explicit?: boolean;
}

/**
 * Nest a flat heading list by depth. The rail re-levels headings to `depth - shallowest`, and
 * `route.toc` is already flat-with-depths, so anything deeper than one level below the top is
 * folded into its nearest ancestor rather than dropped: a reader should find a heading even if
 * the document nests further than the panel draws.
 */
export function nestHeadings(toc: readonly HeadingRef[]): OutlineHeading[] {
  if (toc.length === 0) return [];
  const shallowest = Math.min(...toc.map((heading) => heading.depth));
  const roots: OutlineHeading[] = [];
  let current: OutlineHeading | undefined;
  for (const heading of toc) {
    const node: OutlineHeading = { id: heading.id, text: heading.text, children: [] };
    if (heading.depth === shallowest || current === undefined) {
      roots.push(node);
      current = node;
    } else {
      current.children.push(node);
    }
  }
  return roots;
}

/** Whether a page is its directory's index, the one page that stands for the directory. */
function isSectionEntry(route: ResolvedRoute): boolean {
  return /(?:^|\/)index\.(?:md|rst)$/i.test(route.source ?? "");
}

/**
 * The base-path-aware href of a route. Header links are resolved against the site base
 * (`/portal/docs/...`), while `route.path` is site-logical (`/docs/...`); comparing the two
 * directly only works for a portal published at the domain root.
 */
function routeHref(basePath: string, route: ResolvedRoute): string {
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return `${base}${route.path}`;
}

/**
 * The whole outline: one entry per declared header link. The same tree is emitted for every page,
 * so the narrow chrome is identical markup everywhere and the build stays reproducible; which
 * entry is current is a rendering question, answered against `currentPath` in the template.
 *
 * Membership, in order:
 *
 * 1. A link to a directory's INDEX page with a `sectionNavigation`: every page of that section, in
 *    the rail's order, keyed on the source directory - so a page whose frontmatter `path` moves it
 *    outside the link's prefix stays in. The linked page itself is drawn as "<section> overview".
 *    A link to an ordinary page is a link to THAT page only: About and Contact from one directory
 *    must not share a submenu and both show active.
 * 2. Then any other content page under the link's URL, in route order (deeper directories the
 *    flat rail never lists), never twice.
 *
 * Comparisons use base-path-aware hrefs, like `currentPath`, so `/portal/` and `/` match.
 */
export function deriveNavOutline(
  links: readonly ResolvedLink[],
  routes: readonly ResolvedRoute[],
  basePath = "/",
): OutlineSection[] {
  const content = routes.filter((route) => route.kind === "content");
  const byHref = new Map(content.map((route) => [routeHref(basePath, route), route] as const));

  return links.map((link) => {
    const section: OutlineSection = {
      label: link.label,
      href: link.href,
      external: link.external,
      pages: [],
    };
    if (link.links && link.links.length > 0) {
      const listed = new Set<string>([link.href]);
      for (const child of link.links) {
        if (listed.has(child.href)) continue;
        listed.add(child.href);
        const route = child.external ? undefined : byHref.get(child.href);
        section.pages.push({
          title: child.label,
          href: child.href,
          headings: route && (route.toc?.length ?? 0) >= 2 ? nestHeadings(route.toc ?? []) : [],
          ...(child.external ? { external: true } : {}),
        });
      }
      section.explicit = true;
      return section;
    }
    if (link.external) return section;

    const seen = new Set<string>([link.href]);
    const chosen: { route: ResolvedRoute; href: string }[] = [];
    const take = (href: string): void => {
      if (seen.has(href)) return;
      const route = byHref.get(href);
      if (!route) return;
      seen.add(href);
      chosen.push({ route, href });
    };

    const target = byHref.get(link.href);
    if (target && isSectionEntry(target)) {
      for (const item of target.sectionNavigation?.items ?? []) take(item.href);
    }
    for (const route of content) {
      const href = routeHref(basePath, route);
      if (href.startsWith(link.href)) take(href);
    }

    section.pages = chosen.map(({ route, href }) => ({
      title: route.title,
      href,
      headings: (route.toc?.length ?? 0) >= 2 ? nestHeadings(route.toc ?? []) : [],
    }));
    return section;
  });
}

export function pagerSequence(
  sections: readonly OutlineSection[],
  isPage: (href: string) => boolean,
): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    for (const href of [section.href, ...section.pages.map((page) => page.href)]) {
      if (seen.has(href) || !isPage(href)) continue;
      seen.add(href);
      order.push(href);
    }
  }
  return order;
}

export function sectionFor(sections: readonly OutlineSection[], href: string): string | undefined {
  const exact = sections.find((section) => section.href === href);
  if (exact) return exact.label;
  const listed = (section: OutlineSection): boolean =>
    section.pages.some((page) => page.href === href);
  const chosen = sections.find((section) => section.explicit && listed(section));
  if (chosen) return chosen.label;
  return sections
    .filter((section) => !section.external && (href.startsWith(section.href) || listed(section)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.label;
}
