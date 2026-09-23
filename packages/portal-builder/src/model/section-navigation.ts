/**
 * Section navigation, derived from the source tree.
 *
 * A documentation directory with several pages in it is a section, and a reader on any one of
 * them should be able to see the others. `ResolvedRoute` carries only a route, a title and the
 * page's own headings, and on a short section-introduction page the in-page contents list is
 * suppressed for having fewer than two headings - exactly where a sibling list helps most.
 *
 * 1. The file tree is the authority, not the URL. Membership keys on the declared content source
 *    and the source-relative directory, both carried down from discovery. Deriving it from the
 *    final route would be wrong in four ways that all look like one bug: `guide.md` and
 *    `guide/index.md` give one URL from two source relationships; frontmatter can move a page's
 *    public path anywhere under its mount while the file stays put; two declared roots can hold
 *    directories of the same name; two overlapping mounts would merge into one section.
 *
 * 2. Nothing is configured: no section tree in `portal.yaml`, no sidebar file, no requirement
 *    that a consumer restate their content structure. The one optional key is `navOrder`, which
 *    orders siblings and does nothing else.
 *
 * 3. The current page is not marked here. One frozen `ResolvedSectionNavigation` is shared by
 *    every route in its section; marking the current page would fork it into one
 *    differently-shaped copy per page. The template compares each item's `source` with the
 *    route's own, an identity check on a file rather than a comparison of two URLs.
 */

import type { RenderedPage } from "../rendering/content.js";
import type {
  ResolvedLink,
  ResolvedSectionNavigation,
  ResolvedSectionNavigationItem,
} from "./types.js";
import { compareCodePoints } from "../util/order.js";
import { siteHref } from "./urls.js";

/** How many pages a directory needs before a list of them says anything. */
const MINIMUM_SECTION_PAGES = 2;

/** What the deriver needs to know about one published page. */
export interface SectionCandidate {
  /** Source-root-relative source path. Identity. */
  source: string;
  /** Source-root-relative content root, e.g. `content`. The declared source's identity. */
  contentRoot: string;
  /** Directory of the file relative to its content root; `""` at the root. */
  directory: string;
  /** Whether the file is its directory's `index.md` / `index.rst`. */
  isIndex: boolean;
  /** Site-logical mount of the declared source, e.g. `/docs/`. */
  mount: string;
  /** The page's resolved public route. */
  route: string;
  /** The page's resolved human-facing title. */
  title: string;
  /** The page's declared sibling order, if it stated one. */
  navOrder?: number;
  /** Filename within its directory, for the deterministic tie-break. */
  filename: string;
}

/** Turn resolved content pages into the shape this module reasons about. */
export function candidatesFrom(
  pages: readonly RenderedPage[],
  titleOf: (page: RenderedPage) => string,
): SectionCandidate[] {
  return pages.map((page) => {
    const slash = page.doc.relative.lastIndexOf("/");
    return {
      source: page.doc.source,
      contentRoot: page.doc.contentRoot,
      directory: page.doc.directory,
      isIndex: page.doc.isIndex,
      mount: page.doc.mount,
      route: page.route,
      title: titleOf(page),
      ...(typeof page.navOrder === "number" ? { navOrder: page.navOrder } : {}),
      filename: slash < 0 ? page.doc.relative : page.doc.relative.slice(slash + 1),
    };
  });
}

/**
 * Humanize a directory or mount segment: `storage-concepts` becomes `Storage Concepts`.
 *
 * Separators become spaces and each word is title-cased at its first character. Deliberately
 * unclever - no dictionary of small words, no acronym list, no locale - because a rule a reader
 * can predict beats one that is right slightly more often; where it is wrong, rename the
 * directory. `toLocaleUpperCase` is avoided for the same reason `localeCompare` is: it depends
 * on the build machine's locale, and `i` uppercases to `İ` under a Turkish one.
 */
export function humanizeSegment(segment: string): string {
  const words = segment
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  return words
    .map((word) => {
      const first = [...word][0]!;
      return first.toUpperCase() + word.slice(first.length);
    })
    .join(" ");
}

/**
 * A section's label, by a fixed fallback order.
 *
 * 1. a portal-navigation link already pointing at this section's index route: a name a deployment
 *    put in its header or footer is the one its readers have learned, and a second name for the
 *    same place is how a site ends up calling one section two things.
 * 2. the humanized directory name - the common case, and why no configuration is needed.
 * 3. for the content root's own directory, which has no name, the humanized mount.
 * 4. the index page's title, last: a section introduction is usually titled as a document
 *    ("HEALPix in Zarr on S3"), and a heading repeating the first link under it reads as a mistake.
 */
export function deriveSectionTitle(
  directory: string,
  mount: string,
  indexHref: string | undefined,
  indexTitle: string | undefined,
  navigationLinks: readonly ResolvedLink[],
): string {
  if (indexHref) {
    const named = navigationLinks.find((link) => !link.external && sameRoute(link.href, indexHref));
    if (named?.label) return named.label;
  }
  if (directory !== "") {
    const last = directory.slice(directory.lastIndexOf("/") + 1);
    const humanized = humanizeSegment(last);
    if (humanized) return humanized;
  } else {
    const segments = mount.split("/").filter((segment) => segment.length > 0);
    const humanized = humanizeSegment(segments[segments.length - 1] ?? "");
    if (humanized) return humanized;
  }
  return indexTitle ?? "";
}

/**
 * Whether a navigation href names the same page. Both sides are base-path-aware hrefs by now, so
 * only a trailing slash has to be forgiven; anything with a scheme, query or fragment is not a
 * plain route and is refused rather than normalized into one.
 */
function sameRoute(href: string, other: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.includes("?") || href.includes("#")) return false;
  const normalize = (value: string): string => `/${value.replace(/^\/+|\/+$/g, "")}/`;
  return normalize(href) === normalize(other);
}

/**
 * Order the pages of one section: index page first as the section's front door, then declared
 * `navOrder` low to high, then - for ties and pages that declared nothing - the source filename
 * by code point, the repository's existing comparison and the same everywhere.
 *
 * Never filesystem enumeration order: `readdir` is not stable across filesystems, so an archive
 * extracted on another machine could make the artifact non-reproducible for no site-related
 * reason.
 */
export function orderSection(pages: readonly SectionCandidate[]): SectionCandidate[] {
  return [...pages].sort((a, b) => {
    if (a.isIndex !== b.isIndex) return a.isIndex ? -1 : 1;
    const left = a.navOrder ?? Number.POSITIVE_INFINITY;
    const right = b.navOrder ?? Number.POSITIVE_INFINITY;
    if (left !== right) return left < right ? -1 : 1;
    return compareCodePoints(a.filename, b.filename);
  });
}

/**
 * Derive one navigation per qualifying directory: a map from a page's source path to its section.
 * Every page in one directory gets the same frozen object, so N routes cost one list, not N.
 */
export function deriveSectionNavigation(
  candidates: readonly SectionCandidate[],
  navigationLinks: readonly ResolvedLink[],
  basePath: string,
): Map<string, ResolvedSectionNavigation> {
  // Grouped by content root AND directory: two declared sources that both contain a
  // `storage-concepts/` are two sections that must never merge, which is why the content root is
  // carried down from discovery instead of inferred from a mount. A nested directory is its own
  // group by construction - `guide` and `guide/advanced` are different keys - so a child
  // directory never appears in its parent's flat list.
  interface Group {
    contentRoot: string;
    directory: string;
    pages: SectionCandidate[];
  }
  const groups = new Map<string, Group>();
  for (const page of candidates) {
    // The separator is a character a path cannot contain, so a content root called `a` with a
    // directory `b/c` and one called `a/b` with a directory `c` cannot collide into one section.
    const key = `${page.contentRoot}\u0000${page.directory}`;
    const group = groups.get(key);
    if (group) group.pages.push(page);
    else {
      groups.set(key, {
        contentRoot: page.contentRoot,
        directory: page.directory,
        pages: [page],
      });
    }
  }

  const bySource = new Map<string, ResolvedSectionNavigation>();
  for (const group of groups.values()) {
    if (group.pages.length < MINIMUM_SECTION_PAGES) continue;
    const ordered = orderSection(group.pages);
    const index = ordered.find((page) => page.isIndex);

    const items: ResolvedSectionNavigationItem[] = ordered.map((page) =>
      Object.freeze({
        title: page.title,
        // The repository's own base-path-aware resolver, so a portal published under `/portal/`
        // links to `/portal/docs/...` rather than to a path that only works at a domain root.
        href: siteHref(basePath, page.route),
        source: page.source,
      }),
    );

    const section: ResolvedSectionNavigation = Object.freeze({
      title: deriveSectionTitle(
        group.directory,
        group.pages[0]!.mount,
        index ? siteHref(basePath, index.route) : undefined,
        index?.title,
        navigationLinks,
      ),
      sourceDirectory:
        group.directory === "" ? group.contentRoot : `${group.contentRoot}/${group.directory}`,
      items: Object.freeze(items),
    });

    for (const page of group.pages) bySource.set(page.source, section);
  }
  return bySource;
}
