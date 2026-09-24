// Route derivation. Directory URLs are the canonical v1 form, so `guide.md` and
// `guide/index.rst` both want `/docs/guide/` - and that is a collision the build refuses
// rather than resolves, because whichever one it picked would silently drop a page somebody
// wrote.

import {
  assertSafeSitePath,
  collisionKey,
  decodeSitePath,
  normalizeSitePath,
} from "../config/paths.js";

export class RouteCollision extends Error {
  constructor(
    readonly path: string,
    readonly first: string,
    readonly second: string,
    readonly reason: "exact" | "case" | "unicode" | "percent",
  ) {
    super(
      `Two inputs produce the output path '${path}': '${first}' and '${second}'` +
        (reason === "case"
          ? " (they differ only by case, which collides on a case-insensitive filesystem)"
          : reason === "unicode"
            ? " (they differ only by Unicode normalization)"
            : reason === "percent"
              ? " (they differ only by percent-encoding)"
              : "") +
        ".",
    );
    this.name = "RouteCollision";
  }
}

/** `docs/guide/install.md` under mount `/docs/` becomes `/docs/guide/install/`. */
export function derivePageRoute(mount: string, relativeSourcePath: string): string {
  const withoutExt = relativeSourcePath.replace(/\.(md|rst)$/i, "");
  const segments = withoutExt.split("/").filter((s) => s !== "");
  if (segments[segments.length - 1] === "index") segments.pop();
  const joined = segments.join("/");
  const base = mount.endsWith("/") ? mount : `${mount}/`;
  return joined === "" ? base : `${base}${joined}/`;
}

/**
 * A frontmatter `path` override still has to live under its source's mount. Validation happens
 * on the raw value: `posix.normalize("/docs/../admin/")` is `"/admin/"`, so normalizing first
 * and looking for `..` afterwards finds nothing and accepts an escape.
 */
export function applyPathOverride(mount: string, override: string): string | undefined {
  let normalized: string;
  try {
    normalized = normalizeSitePath(override, "frontmatter path");
  } catch {
    return undefined;
  }
  return collisionKey(normalized).startsWith(collisionKey(mount)) ? normalized : undefined;
}

/**
 * Collision detection over one canonical key, derived the same way for every path, so the
 * verdict cannot depend on insertion order: registering the encoded spelling first has to give
 * the same answer as registering the decoded one first.
 */
export class RouteRegistry {
  private readonly byKey = new Map<string, { path: string; owner: string }>();

  add(path: string, owner: string): void {
    assertSafeSitePath(path, "route");
    const key = collisionKey(path);
    const existing = this.byKey.get(key);
    if (existing) {
      throw new RouteCollision(path, existing.owner, owner, classify(existing.path, path));
    }
    this.byKey.set(key, { path, owner });
  }

  has(path: string): boolean {
    return this.byKey.has(collisionKey(path));
  }

  owner(path: string): string | undefined {
    return this.byKey.get(collisionKey(path))?.owner;
  }

  get paths(): string[] {
    return [...this.byKey.values()].map((entry) => entry.path).sort();
  }
}

/** Why two paths collided, for the message only. The decision is the key. */
function classify(first: string, second: string): "exact" | "case" | "unicode" | "percent" {
  if (first === second) return "exact";
  if (decodeSitePath(first) !== first || decodeSitePath(second) !== second) return "percent";
  if (first.normalize("NFC") !== second.normalize("NFC")) return "unicode";
  return "case";
}
