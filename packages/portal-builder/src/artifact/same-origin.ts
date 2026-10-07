// A same-origin notebook's own policies (`notebook.deployment: same-origin`). Where a host can send
// headers - `host-policy.json`, the preview - the notebook's, the relay page's and the kernel
// Workers' paths get theirs INSTEAD of the portal's, never stacked on it. With `metaPolicy` the
// documents carry them as `<meta>` tags too, for a host that sends none (GitHub Pages); what a
// meta tag cannot deliver is reported, not silently dropped.

import { createHash } from "node:crypto";
import { NOTEBOOK_PATH, underBase } from "../model/notebook.js";

/** A path's policy, as host-policy.json writes it. */
export interface PathPolicy {
  match: { prefix: string } | { path: string };
  directives: Record<string, string>;
  /** Whether the documents there also carry it as a `<meta>` tag. */
  meta: boolean;
}

export interface SameOriginPolicies {
  paths: PathPolicy[];
  headers: { match: { prefix: string }; set: Record<string, string> }[];
  /** What a host without headers does not get, one sentence each. */
  unenforcedWithoutHeaders: string[];
}

/** Directives a `<meta>` tag cannot deliver: a browser ignores them there. */
const NOT_IN_META = new Set(["frame-ancestors", "report-uri", "report-to", "sandbox"]);

/** A policy string as directive → value. */
export function directivesOf(policy: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values.join(" ");
  }
  return out;
}

/** A policy without what a meta tag cannot deliver. */
export function metaSafe(policy: string): string {
  return policy
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !NOT_IN_META.has(part.split(/\s+/)[0]!.toLowerCase()))
    .join("; ");
}

/** The hashes of a document's inline, executable scripts (a body and no `src`). */
export function inlineScriptHashes(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    if (/\bsrc\s*=/i.test(attrs) || body.trim() === "") continue;
    const type = /\btype\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]?.trim().toLowerCase() ?? "";
    if (!["", "module", "text/javascript"].includes(type)) continue;
    out.add(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return [...out].sort();
}

/**
 * The sign-in relay page's policy: its own scripts and nothing else, never framed. `header` for a
 * host that sends it, `meta` for the page's own tag.
 */
export function callbackPolicy(html: string): { header: string; meta: string } {
  const header =
    `default-src 'none'; script-src ${["'self'", ...inlineScriptHashes(html)].join(" ")}; ` +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  return { header, meta: metaSafe(header) };
}

export function sameOriginPolicies(options: {
  basePath: string;
  /** The notebook site's policy; absent when this build was not given the site. */
  notebookPolicy?: string;
  /** The callback path (base path included), its page's policy; `own`: this build emitted it. */
  callback?: { path: string; policy: string; own: boolean };
  meta: boolean;
}): SameOriginPolicies {
  const notebookPrefix = underBase(options.basePath, `${NOTEBOOK_PATH}/`);
  const paths: PathPolicy[] = options.notebookPolicy
    ? [
        {
          match: { prefix: notebookPrefix },
          directives: directivesOf(options.notebookPolicy),
          meta: options.meta,
        },
      ]
    : [];
  // The portal's own sign-in route keeps the portal's policy: it is a portal page that also
  // relays a notebook's popup.
  if (options.callback?.own) {
    paths.push({
      match: { path: options.callback.path },
      directives: directivesOf(options.callback.policy),
      meta: options.meta,
    });
  }
  const frameAncestors = directivesOf(options.notebookPolicy ?? "")["frame-ancestors"] ?? "'none'";
  const unenforced = [
    options.meta
      ? `Without headers (GitHub Pages), ${notebookPrefix} carries its policy as a <meta> tag, ` +
        `except frame-ancestors (${frameAncestors}): a meta tag cannot say who may frame it.`
      : `Without headers (GitHub Pages), ${notebookPrefix} runs with no Content-Security-Policy ` +
        "at all (set notebook.metaPolicy for a <meta> tag); host-policy.json has its policy.",
    `Without headers, the notebook's kernel Workers run with no policy: a Worker's policy comes ` +
      "only from its own response's header.",
    ...(options.callback
      ? [
          `Without headers, ${options.callback.path} is not sent Cache-Control: no-store or ` +
            "Referrer-Policy: no-referrer (the page itself says no-referrer).",
        ]
      : []),
  ];
  return {
    paths,
    headers: [
      {
        match: { prefix: notebookPrefix },
        set: {
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      },
    ],
    unenforcedWithoutHeaders: unenforced,
  };
}
