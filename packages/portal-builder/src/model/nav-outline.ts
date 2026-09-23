/**
 * The navigation outline the narrow-width chrome drills through.
 *
 * The header carries two levels of navigation. Site sections live in `navigation.header`; the
 * current page's own structure lives in the docs rail, which below 1024px stops being a column
 * and becomes a boxed list above the article - a full screen of contents before the first
 * sentence. Both levels are derived here as one tree, once, at build time, so the phone panel and
 * the tablet breadcrumb dropdown render the same data rather than two hand-kept copies.
 *
 * Nothing new is computed. Sections are the declared links; a section's pages are the routes
 * beneath it, ordered by `deriveSectionNavigation` where it applies; a page's groups are its own
 * `toc`. The model already carries all three - see `ResolvedRoute`.
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

/** Routes that belong under `href`, in the order the site publishes them. */
function pagesUnder(href: string, routes: readonly ResolvedRoute[]): ResolvedRoute[] {
  return routes.filter(
    (route) => route.kind === "content" && route.path !== href && route.path.startsWith(href),
  );
}

/**
 * The whole outline: one entry per declared header link. The same tree is emitted for every page,
 * so the narrow chrome is identical markup everywhere and the build stays reproducible; which
 * entry is current is a rendering question, answered against `currentPath` in the template.
 */
export function deriveNavOutline(
  links: readonly ResolvedLink[],
  routes: readonly ResolvedRoute[],
): OutlineSection[] {
  return links.map((link) => {
    const section: OutlineSection = {
      label: link.label,
      href: link.href,
      external: link.external,
      pages: [],
    };
    if (link.external) return section;

    // A section index has a `sectionNavigation` covering its own directory, and that ordering -
    // index first, then `navOrder`, then filename - is what the docs rail shows. Reusing it keeps
    // the phone panel and the rail in the same order.
    const index = routes.find((route) => route.path === link.href);
    const ordered = index?.sectionNavigation?.items;
    const under = pagesUnder(link.href, routes);
    const byPath = new Map(under.map((route) => [route.path, route] as const));

    const chosen: ResolvedRoute[] = [];
    if (ordered) {
      for (const item of ordered) {
        const route = byPath.get(item.href);
        if (route) {
          chosen.push(route);
          byPath.delete(item.href);
        }
      }
    }
    // Anything the section ordering did not name - a deeper page, a directory of its own - keeps
    // its route order rather than disappearing from the panel.
    for (const route of under) if (byPath.has(route.path)) chosen.push(route);

    section.pages = chosen.map((route) => ({
      title: route.title,
      href: route.path,
      headings: (route.toc?.length ?? 0) >= 2 ? nestHeadings(route.toc ?? []) : [],
    }));
    return section;
  });
}
