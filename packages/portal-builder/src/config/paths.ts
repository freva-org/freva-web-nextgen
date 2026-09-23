/**
 * The filesystem trust anchor (FP-001 D4, AR-001).
 *
 * Nothing in the builder opens a project file except through here. Containment is checked twice:
 * lexically, so a `..` that would leave the root is refused before touching the disk, and again
 * after canonicalization, so a symlink or a case-folding filesystem cannot smuggle a path back
 * out. Both are cheap, and which one is sufficient differs by platform.
 */

import { lstatSync, realpathSync, existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep, dirname } from "node:path";
import { collapseSeparators, decodeSafePath, rawCollisionKey, rawPathReason } from "./raw-path.js";

export class PathViolation extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "PathViolation";
  }
}

/** POSIX form with `/` separators, for manifests, globs and messages. */
export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** NFC is the only accepted normalization form for a project path name. */
export function assertNfc(p: string): void {
  if (p.normalize("NFC") !== p) {
    throw new PathViolation(
      "FP1004",
      `Path name is not Unicode NFC: ${JSON.stringify(p)}. Rename the file; two different byte sequences that display identically would produce two different routes.`,
      p,
    );
  }
}

/**
 * The canonical trusted source root, resolved exactly once per invocation because every later
 * containment check compares against this string.
 */
export function canonicalizeRoot(sourceRoot: string): string {
  const abs = resolve(sourceRoot);
  if (!existsSync(abs)) {
    throw new PathViolation("FP1006", `--source-root does not exist: ${abs}`, abs);
  }
  const real = realpathSync.native(abs);
  if (!lstatSync(real).isDirectory()) {
    throw new PathViolation("FP1006", `--source-root is not a directory: ${abs}`, abs);
  }
  return real;
}

/**
 * Map a path into the one canonical namespace the trusted root lives in.
 *
 * `canonicalizeRoot` resolves the source root through `realpath`, so on any platform whose
 * temporary or home directory is reached through a symlink - macOS reaches `/var/folders/...`
 * through `/var` -> `/private/var`, and a `$HOME` on an automounted volume behaves the same way -
 * the root and a configuration path derived from the *same* directory are two different strings
 * for one directory, and comparing them lexically reports an escape for a file that never left.
 *
 * The mapping is one-directional and stops at the root:
 *
 * - a path already inside the canonical root is returned untouched, so nothing below the root is
 *   resolved through `realpath` here and the segment walk in {@link assertNoSymlinkBelow} keeps
 *   the last word on links in consumer sources;
 * - otherwise the deepest existing ancestor is canonicalized and the remaining segments are
 *   re-attached; if that lands inside the root, the canonical spelling is returned;
 * - if it does not, the original absolute path is returned unchanged, so a real escape is still
 *   an escape.
 */
export function canonicalizeInRoot(root: string, p: string): string {
  const abs = resolve(p);
  if (contains(root, abs)) return abs;
  let current = abs;
  const tail: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      let real: string;
      try {
        real = realpathSync.native(current);
      } catch {
        return abs;
      }
      const rejoined = tail.length > 0 ? join(real, ...tail.reverse()) : real;
      return contains(root, rejoined) ? rejoined : abs;
    }
    const parent = dirname(current);
    if (parent === current) return abs;
    tail.push(current.slice(parent.length + 1));
    current = parent;
  }
}

/** True when `child` is `parent` or lies underneath it. Never a string prefix test. */
export function contains(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Either path containing or equalling the other. The check AR-001 asks for. */
export function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a);
}

/**
 * Refuse a symlink anywhere between the root and the target. Walking segment by segment matters:
 * `realpath` on the whole path would follow the link and report a contained result for an input
 * that is not contained.
 */
function assertNoSymlinkBelow(root: string, target: string): void {
  let current = root;
  const rest = relative(root, target);
  if (rest === "") return;
  for (const segment of rest.split(sep)) {
    if (segment === "" || segment === ".") continue;
    current = join(current, segment);
    let st;
    try {
      st = lstatSync(current);
    } catch {
      return; // a missing file is reported by the caller as FP1006, not as a link
    }
    if (st.isSymbolicLink()) {
      throw new PathViolation(
        "FP1002",
        `Symlink in a project input: ${toPosix(relative(root, current))}. Copy the real file into the trusted source root instead.`,
        current,
      );
    }
  }
}

export interface ContainedPath {
  /** The absolute canonical path on disk. */
  absolute: string;
  /** The NFC, POSIX, source-root-relative path used by every manifest. */
  relative: string;
}

/**
 * Resolve one declared path. `declaredIn` is the absolute path of the declaring file: a declared
 * path is relative to the file that declares it, and only then contained by the root.
 */
export function resolveContained(
  root: string,
  declaredIn: string,
  declared: string,
  opts: { mustExist?: boolean } = {},
): ContainedPath {
  if (isAbsolute(declared)) {
    throw new PathViolation(
      "FP1001",
      `Absolute paths are not accepted in portal configuration: ${declared}`,
      declared,
    );
  }
  if (declared.includes("\\")) {
    throw new PathViolation(
      "FP1001",
      `Use POSIX '/' separators in configuration paths: ${declared}`,
      declared,
    );
  }
  assertNfc(declared);

  // One namespace for all three participants: the root is already canonical, and the declaring
  // file is brought into the same namespace before the path it declares is joined onto it.
  const declaringPath = canonicalizeInRoot(root, declaredIn);
  const base = lstatSync(declaringPath, { throwIfNoEntry: false })?.isDirectory()
    ? declaringPath
    : dirname(declaringPath);
  const lexical = normalize(join(base, declared));

  // Lexical containment first: a `..` that leaves the root never reaches the disk.
  if (!contains(root, lexical)) {
    throw new PathViolation("FP1001", `Path escapes the trusted source root: ${declared}`, lexical);
  }

  assertNoSymlinkBelow(root, lexical);

  if (!existsSync(lexical)) {
    if (opts.mustExist === false) {
      return { absolute: lexical, relative: toPosix(relative(root, lexical)) };
    }
    throw new PathViolation("FP1006", `Missing input file: ${declared}`, lexical);
  }

  // Canonical containment second: the filesystem gets the last word.
  const real = realpathSync.native(lexical);
  if (!contains(root, real)) {
    throw new PathViolation(
      "FP1001",
      `Path escapes the trusted source root after canonicalization: ${declared}`,
      real,
    );
  }
  const rel = toPosix(relative(root, real));
  assertNfc(rel);
  return { absolute: real, relative: rel };
}

/**
 * Canonicalize a path that does not exist yet (the output, temporary and backup trees). The
 * nearest existing ancestor is canonicalized and the remaining segments appended, so
 * {@link assertDisjointTrees} compares two real paths even before the directory is created.
 */
export function canonicalizeIntended(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(current)) return join(realpathSync.native(current), ...tail.reverse());
    const parent = dirname(current);
    if (parent === current) return resolve(p);
    tail.push(current.slice(parent.length + 1));
    current = parent;
  }
}

export interface DisjointInput {
  /** Absolute canonical path of an input file or an input root. */
  absolute: string;
  /** How it is described in the failure message. */
  label: string;
}

/**
 * AR-001: the output, temporary and backup trees must be disjoint from every transitive input in
 * *both* containment directions, settled before anything is created. An output inside a content
 * root would otherwise feed the next build its own previous output.
 */
export function assertDisjointTrees(
  outputs: { absolute: string; label: string }[],
  inputs: DisjointInput[],
): void {
  for (const out of outputs) {
    for (const inp of inputs) {
      if (overlaps(out.absolute, inp.absolute)) {
        throw new PathViolation(
          "FP1003",
          `${out.label} (${out.absolute}) overlaps ${inp.label} (${inp.absolute}). ` +
            `An output tree may not equal, contain, or be contained by any declared input.`,
          out.absolute,
        );
      }
    }
  }
}

/**
 * Site paths, checked by the one shared raw-path contract. The rules live in `raw-path.ts` so
 * that a canonical URL's pathname, a service URL's pathname, a manifest entry and a subsite
 * reference are judged identically; what is left here is the diagnostic code and site policy.
 */

export function assertSafeSitePath(raw: string, what = "site path"): void {
  const reason = rawPathReason(raw);
  if (reason !== undefined) {
    throw new PathViolation("FP1001", `${what} ${reason}: ${JSON.stringify(raw)}`, raw);
  }
}

/** Decode a site path that has already been validated. */
export function decodeSitePath(raw: string, what = "site path"): string {
  assertSafeSitePath(raw, what);
  return decodeSafePath(raw);
}

/**
 * Site-logical path normalization: always `/`-delimited, always a trailing slash. The input is
 * validated first, so this only collapses repeated separators and can never turn an unsafe
 * authored value into a safe-looking one.
 */
export function normalizeSitePath(p: string, what = "site path"): string {
  assertSafeSitePath(p, what);
  const collapsed = collapseSeparators(p);
  return collapsed.endsWith("/") ? collapsed : `${collapsed}/`;
}

/**
 * The one key two paths are compared by. Symmetric and order-independent; see `rawCollisionKey`.
 */
export function collisionKey(path: string): string {
  return rawCollisionKey(path);
}

/**
 * Case-insensitive collision detection for *filesystem* names, where percent encoding has no
 * meaning. Site paths use `collisionKey` instead.
 */
export function caseFoldKey(p: string): string {
  return p.normalize("NFC").toLowerCase();
}
