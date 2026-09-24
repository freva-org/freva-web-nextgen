/**
 * Publishing the Freva footer badge into an artifact.
 *
 * The badge is a package - `@freva-org/freva-badge` - and this file is the only thing in the
 * builder that knows it exists. It copies the package's `dist/` into the artifact, works out the
 * two URLs the runtime needs, and hands back a record for the footer template and the island. It
 * does not read the badge's JavaScript, process an image, or know what the badge draws.
 *
 * `chrome.footer.badge.enabled: false`, or a disabled footer, returns `undefined`: nothing is
 * copied, linked or emitted. A portal that switched the badge off must not contain one byte of
 * it - the same rule every optional component follows, and the same rule its tests check.
 */

import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { DiagnosticBag } from "../diagnostics.js";
import { sha256 } from "../util/package.js";
import type { ResolvedFooterBadge } from "./types.js";

/** Where the badge lands in the artifact. Underscored, like `_portal`. */
const ROOT = "_badge";

/** The configuration as written, where every property is an override. */
export interface BadgeRequest {
  enabled?: boolean;
  kind?: "freva";
  quality?: "auto" | "standard";
}

/** The decision, with nothing left to default. */
export interface BadgeChoice {
  kind: "freva";
  quality: "auto" | "standard";
}

/**
 * Whether this footer has a badge, and which one.
 *
 * A footer *is* the credit line and the badge is what it looks like, so it is on by default and a
 * consumer writes `badge:` only to change that. Two questions switch it off - the badge was
 * turned off, or there is no footer to put it in - and both answer `undefined` here, the single
 * place the rest of the build asks.
 *
 * `kind` is optional and defaults to the only value it accepts; it stays in the schema because
 * deployments write it, and a valid configuration must not stop being valid to gain a default.
 */
export function decideFooterBadge(
  footerEnabled: boolean,
  request: BadgeRequest | undefined,
): BadgeChoice | undefined {
  if (!footerEnabled) return undefined;
  if (request?.enabled === false) return undefined;
  return { kind: request?.kind ?? "freva", quality: request?.quality ?? "standard" };
}

export interface BadgePublication {
  badge: ResolvedFooterBadge;
  /**
   * Published bytes by artifact-relative path: plain artifact files, like the compiled shell's own
   * scripts and stylesheets, not consumer assets. They are portal-owned runtime, checksummed with
   * everything else, and never pass the asset MIME allowlist, which polices what a *consumer*
   * mounts.
   */
  contents: Map<string, Buffer>;
  /** One input-manifest row per published file, so the build stays auditable. */
  inputs: { path: string; role: string; digest: string; bytes: number }[];
}

function walk(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Whether a motion chunk can ever be requested at this quality. `standard` pins the runtime to
 * the 1x set, so the 2x chunks are about 4.6 MB of dead weight. Omitting them is not an
 * optimization: an artifact carrying a file nothing can ask for has contents that do not describe
 * its behaviour, and the enablement tests read the contents.
 */
function reachable(file: string, quality: "auto" | "standard"): boolean {
  if (quality !== "standard") return true;
  return !/@2x/.test(file) || file.startsWith("assets/story");
}

export function publishFooterBadge(
  choice: BadgeChoice | undefined,
  basePath: string,
  bag: DiagnosticBag,
  /**
   * Where the badge package lives. Injectable so the two failures below can be tested: a resolver
   * that throws and a package with no runtime in it are not states a suite can produce by writing
   * YAML.
   */
  resolvePackageDir: () => string = () =>
    dirname(createRequire(import.meta.url).resolve("@freva-org/freva-badge/package.json")),
): BadgePublication | undefined {
  if (!choice) return undefined;

  const quality = choice.quality;

  // Two failures, told apart, because they have different answers. The second has a remedy the
  // first does not suggest: `@freva-org/freva-badge/dist` is vendored, not built. The package's
  // build script is deliberately a no-op, so `npm run build` cannot regenerate it, and a tree
  // that arrived without that directory - an export that filtered `dist/` out, say - has to be
  // restored rather than rebuilt.
  let packageDir: string;
  try {
    packageDir = resolvePackageDir();
  } catch {
    bag.error(
      "FP1213",
      "chrome.footer.badge is configured but '@freva-org/freva-badge' is not installed.",
      { pointer: "/chrome/footer/badge" },
    );
    return undefined;
  }

  const distDir = join(packageDir, "dist");
  try {
    statSync(distDir);
  } catch {
    bag.error(
      "FP1214",
      "'@freva-org/freva-badge' is installed but has no dist/. That directory is vendored rather " +
        "than built - the package's build script is a deliberate no-op - so 'npm run build' " +
        "cannot regenerate it. Restore it from the package source or reinstall the workspace.",
      { pointer: "/chrome/footer/badge" },
    );
    return undefined;
  }

  const contents = new Map<string, Buffer>();
  const inputs: BadgePublication["inputs"] = [];

  for (const rel of walk(distDir)) {
    if (!reachable(rel, quality)) continue;
    const bytes = readFileSync(join(distDir, rel));
    const file = posix.join(ROOT, rel);
    contents.set(file, bytes);
    const digest = sha256(bytes);
    inputs.push({
      path: `@freva-org/freva-badge/dist/${rel}`,
      role: "asset",
      digest,
      bytes: bytes.byteLength,
    });
  }

  if (contents.size === 0) {
    bag.error(
      "FP1214",
      `'@freva-org/freva-badge' has a dist/, but nothing in it is publishable at quality ` +
        `'${quality}'. The directory is vendored; a partial copy is the usual cause.`,
      { pointer: "/chrome/footer/badge" },
    );
    return undefined;
  }

  return {
    badge: {
      kind: choice.kind,
      quality,
      styleUrl: `${basePath}${ROOT}/freva-badge.css`,
      // The runtime joins this with its own relative names; the trailing slash is load-bearing.
      assetBase: `${basePath}${ROOT}/assets/`,
    },
    contents,
    inputs,
  };
}
