// Redirects for a migrated site, so old URLs keep bookmarks and search history working.
// `redirects:` in portal.yaml declares them; each is decided here against the built site:
//
// - `from` is an OLD path, so it must not be anything this artifact publishes - a route, a mount
//   (assets, downloads, a subsite) or a framework directory - or it would shadow a live page.
// - the target resolves like a navigation link (a landing, a component, or an existing `href`):
//   a typo is an error; a disabled component is omitted with the navigation diagnostic.
// - no chains: an internal target must exist on the built site and a `from` never can, so a
//   redirect aimed at another's old path is an unknown target (`FP1201`).
//
// The artifact writer emits each three ways: in `host-policy.json` for a conforming host's
// 301/308, as a static page at the old path for a host that ignores it (meta refresh, canonical
// link, visible link, no script), and as what `host-check` probes.

import type { Diagnostic } from "../diagnostics.js";
import type { RawRedirect } from "../config/types.js";
import { collisionKey, decodeSitePath, normalizeSitePath, PathViolation } from "../config/paths.js";
import { resolveLink, type LinkContext } from "./links.js";
import type { ResolvedRedirect } from "./types.js";

export type { RedirectStatus, ResolvedRedirect } from "./types.js";

export interface RedirectContext {
  basePath: string;
  /** `routes.has`, which folds case, Unicode and percent-encoding the way route collisions do. */
  isRoute: (path: string) => boolean;
  /** Site-logical prefixes the artifact publishes under: asset, download and subsite mounts. */
  mounts: string[];
  link: Omit<LinkContext, "pointer" | "file">;
  file: string;
}

/**
 * Directories the framework itself writes at the artifact root. A redirect from under one of them
 * would put a page inside generated output; none of them was ever a page on a site being migrated.
 */
export const FRAMEWORK_PREFIXES = [
  "/_portal/",
  "/_badge/",
  "/identity/",
  "/stac/",
  "/playground-origin/",
];

export function resolveRedirects(
  raws: readonly RawRedirect[],
  ctx: RedirectContext,
): { redirects: ResolvedRedirect[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const base = ctx.basePath.replace(/\/$/, "");
  const at = (index: number, key?: string): string => `/redirects/${index}${key ? `/${key}` : ""}`;
  const fail = (index: number, key: string | undefined, message: string, hint?: string): void => {
    diagnostics.push({
      code: "FP1224",
      severity: "error",
      message,
      file: ctx.file,
      pointer: at(index, key),
      ...(hint ? { hint } : {}),
    });
  };

  const accepted: (ResolvedRedirect & { index: number })[] = [];
  const seen = new Map<string, number>();

  raws.forEach((raw, index) => {
    let from: string;
    try {
      from = normalizeSitePath(raw.from, "redirect source");
    } catch (error) {
      if (error instanceof PathViolation) {
        fail(index, "from", error.message);
        return;
      }
      throw error;
    }

    const key = collisionKey(from);
    const previous = seen.get(key);
    if (previous !== undefined) {
      fail(index, "from", `'${from}' is redirected twice, here and at /redirects/${previous}.`);
      return;
    }
    seen.set(key, index);

    if (ctx.isRoute(from)) {
      fail(
        index,
        "from",
        `'${from}' is a page of this site, so it cannot also be a redirect.`,
        "A redirect answers an OLD path. Remove it, or move the page.",
      );
      return;
    }
    const mount = [...ctx.mounts, ...FRAMEWORK_PREFIXES].find((prefix) =>
      collisionKey(from).startsWith(collisionKey(prefix)),
    );
    if (mount) {
      fail(
        index,
        "from",
        `'${from}' is under '${mount}', which this artifact publishes files under.`,
        "A redirect page there would sit inside published output. Redirect a path outside it.",
      );
      return;
    }

    const target = resolveLink(
      {
        label: from,
        ...(raw.landing !== undefined ? { landing: raw.landing } : {}),
        ...(raw.component !== undefined ? { component: raw.component } : {}),
        ...(raw.href !== undefined ? { href: raw.href } : {}),
      },
      { ...ctx.link, pointer: at(index), file: ctx.file },
    );
    diagnostics.push(...target.diagnostics);
    if (!target.link) return;
    if (target.link.href.startsWith("mailto:")) {
      fail(index, "href", `A redirect cannot go to a mailto: address ('${target.link.href}').`);
      return;
    }

    // A host, the preview and a static server all match the DECODED request path, and a static
    // server looks the fallback page up by it: `/old%20page/` arrives as `/old page/`. So the
    // policy and the fallback file carry the decoded path; `from` keeps the authored spelling for
    // messages. Decoding cannot introduce a separator or a dot segment: `from` was validated.
    const decoded = decodeSitePath(from, "redirect source");
    accepted.push({
      index,
      from,
      fromPath: `${base}${decoded}`,
      to: target.link.href,
      external: target.link.external,
      status: raw.status ?? 301,
      file: `${decoded.replace(/^\//, "")}index.html`,
    });
  });

  const redirects = accepted.map(({ index: _index, ...resolved }) => resolved);
  return { redirects, diagnostics };
}

/**
 * The `Location` a conforming host answers with: the declared target, with the request's query
 * MERGED into the target's own query and the target's fragment kept last. Concatenating the two
 * query strings is the bug this exists to avoid: `/new?fixed=1` + `?q=x` must be
 * `/new?fixed=1&q=x`, not `/new?fixed=1?q=x` (where `q` is no parameter at all), and a target
 * `…/form#top` must not receive the query inside its fragment. The target's own parameters come
 * first and are never overwritten; the request's are appended. A root-relative target stays
 * root-relative.
 */
export function redirectLocation(to: string, search: string): string {
  const relative = to.startsWith("/");
  const url = new URL(to, "http://portal.invalid");
  for (const [key, value] of new URLSearchParams(search)) url.searchParams.append(key, value);
  const query = url.searchParams.toString();
  const tail = `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
  return relative ? tail : `${url.origin}${tail}`;
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The fallback page a host that ignores `host-policy.json` serves at the old path. No script and
 * no style - it needs neither, and it runs under the portal's own Content-Security-Policy - so a
 * meta refresh moves the browser, the canonical link tells a crawler where the content is, and a
 * visible link covers a browser with refresh disabled. `noindex` keeps the stub out of an index.
 */
export function redirectPage(redirect: ResolvedRedirect, language: string, origin: string): string {
  const absolute = redirect.external ? redirect.to : `${origin}${redirect.to}`;
  const href = escapeHtml(redirect.to);
  return `<!doctype html>
<html lang="${escapeHtml(language)}">
<head>
<meta charset="utf-8">
<title>Moved</title>
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${href}">
<link rel="canonical" href="${escapeHtml(absolute)}">
</head>
<body>
<p>This page has moved to <a href="${href}">${escapeHtml(absolute)}</a>.</p>
</body>
</html>
`;
}
