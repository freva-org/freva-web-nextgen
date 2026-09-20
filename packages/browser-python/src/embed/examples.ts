/**
 * The registered-example manifest: the only way a name becomes runnable Python.
 *
 * A portal wants a "Try in Python" button beside a code sample, and the obvious implementation -
 * send the source to the interpreter - is a remote code execution surface. So the source never
 * travels: an `id` and a `sha256` do, and this module is the other end, a table built when the
 * portal was BUILT of the snippets that page may run. A request names one; it cannot describe one.
 *
 * The digest is NOT a signature - anyone who can send `{id, digest}` can read it out of the page
 * that renders the button. It is an INTEGRITY check between two halves of one build: a stale
 * portal asking a freshly-deployed playground for `dataset-open` means the two disagree about what
 * that name runs. `verifyManifest` closes the other half, refusing at load a manifest whose
 * `sha256` does not match its own `source`. Nothing here knows about datasets, catalogs or
 * portals: an example is an id, a title and a source.
 */

/** One snippet a build registered. */
export interface RegisteredExample {
  /** Stable identity. What a request names. */
  id: string;
  /** The dataset the example belongs to, when it belongs to one. Carried, never interpreted. */
  datasetId?: string;
  /** Human title, used for the divider the console prints before the source. */
  title: string;
  /** The Python. */
  source: string;
  /** Lowercase hex SHA-256 of `source`. */
  sha256: string;
}

/** Why a resolution failed. Distinguished so a caller can say something true about it. */
export type ExampleRefusal =
  | { ok: false; reason: "unknown"; message: string }
  | { ok: false; reason: "digest"; message: string }
  | { ok: false; reason: "malformed"; message: string };

export type ExampleResolution = { ok: true; example: RegisteredExample } | ExampleRefusal;

export interface ExampleRegistry {
  readonly size: number;
  /** Every registered id, sorted. For diagnostics; never for enumeration by a peer. */
  ids(): string[];
  /**
   * Resolve a request. BOTH halves must match: the id has to be registered, and the digest has to
   * be the one this build registered it under.
   */
  resolve(id: unknown, digest: unknown): ExampleResolution;
}

const DIGEST = /^[0-9a-f]{64}$/;

/** A lowercase hex SHA-256, or `null` for anything that is not one. */
function normalizeDigest(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return DIGEST.test(trimmed) ? trimmed : null;
}

/**
 * Validate one manifest entry. Every field is checked here rather than where it is used: a
 * manifest is loaded from JSON a build wrote, and an entry with a numeric `source` or a `sha256`
 * of `"true"` is a bug that should stop the page rather than become a `TypeError` inside the
 * interpreter three interactions later.
 */
export function parseRegisteredExample(value: unknown): RegisteredExample {
  if (!value || typeof value !== "object") {
    throw new TypeError("a registered example must be an object");
  }
  const raw = value as Record<string, unknown>;
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("a registered example needs a non-empty string id");
  }
  if (typeof raw.title !== "string" || raw.title.length === 0) {
    throw new TypeError(`registered example "${id}" needs a non-empty title`);
  }
  if (typeof raw.source !== "string" || raw.source.length === 0) {
    throw new TypeError(`registered example "${id}" needs a non-empty source`);
  }
  const sha256 = normalizeDigest(raw.sha256);
  if (!sha256) {
    throw new TypeError(
      `registered example "${id}" needs a lowercase hex SHA-256; got ${JSON.stringify(raw.sha256)}`,
    );
  }
  if (raw.datasetId !== undefined && typeof raw.datasetId !== "string") {
    throw new TypeError(`registered example "${id}" has a datasetId that is not a string`);
  }
  return {
    id,
    title: raw.title,
    source: raw.source,
    sha256,
    ...(typeof raw.datasetId === "string" ? { datasetId: raw.datasetId } : {}),
  };
}

/**
 * Parse a whole manifest. Duplicate ids are an ERROR rather than a last-one-wins merge: two
 * entries for one name means the build cannot say what that name runs, and picking either would
 * let the digest check decide it by accident.
 */
export function parseExampleManifest(value: unknown): RegisteredExample[] {
  if (!Array.isArray(value)) {
    throw new TypeError("an example manifest is an array of registered examples");
  }
  const seen = new Set<string>();
  const out: RegisteredExample[] = [];
  for (const entry of value) {
    const example = parseRegisteredExample(entry);
    if (seen.has(example.id)) {
      throw new TypeError(`the example manifest registers "${example.id}" twice`);
    }
    seen.add(example.id);
    out.push(example);
  }
  return out;
}

/** Lowercase hex SHA-256 of a string, through the platform's own digest. */
export async function sha256Hex(source: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Registered examples need crypto.subtle to verify their digests, and this context has " +
        "none. That means a insecure context: serve the page over HTTPS or from localhost.",
    );
  }
  const bytes = await subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Check that every entry's `sha256` really is the digest of its own `source`. Without this the
 * digest is decorative: a manifest could register any source under any digest and the check on
 * the wire would compare one made-up number to another. Run once at load, and the whole manifest
 * is refused if any entry disagrees.
 */
export async function verifyExampleManifest(examples: readonly RegisteredExample[]): Promise<void> {
  for (const example of examples) {
    const actual = await sha256Hex(example.source);
    if (actual !== example.sha256) {
      throw new Error(
        `registered example "${example.id}" does not match its own digest: the manifest says ` +
          `${example.sha256} and its source hashes to ${actual}. The manifest and the sources it ` +
          `describes came from different builds.`,
      );
    }
  }
}

/**
 * Build a registry over already-parsed entries. Synchronous and total: it never fetches, never
 * hashes and never fails at lookup time. Verifying the manifest against itself is
 * `verifyExampleManifest`, which the caller runs once, keeping the async work at load rather than
 * on the path a button press takes.
 */
export function createExampleRegistry(examples: readonly RegisteredExample[]): ExampleRegistry {
  const byId = new Map<string, RegisteredExample>();
  for (const example of examples) byId.set(example.id, example);

  return {
    get size(): number {
      return byId.size;
    },
    ids: () => [...byId.keys()].sort(),
    resolve(id: unknown, digest: unknown): ExampleResolution {
      if (typeof id !== "string" || id.length === 0) {
        return { ok: false, reason: "malformed", message: "the request carried no example id" };
      }
      const wanted = normalizeDigest(digest);
      if (!wanted) {
        return {
          ok: false,
          reason: "malformed",
          message: `the request for "${id}" carried no usable SHA-256`,
        };
      }
      const example = byId.get(id);
      if (!example) {
        // The message says the id and NOT what is registered: a peer that can ask for one name
        // and be told the other ninety-nine has been handed the catalogue. `ids()` is for a
        // developer looking at a console, not for an answer sent back over a bridge.
        return {
          ok: false,
          reason: "unknown",
          message: `no example is registered as "${id}" in this build`,
        };
      }
      if (example.sha256 !== wanted) {
        return {
          ok: false,
          reason: "digest",
          message:
            `the request for "${id}" carries a digest this build does not recognise, so the ` +
            `two halves of the deployment disagree about what "${id}" is`,
        };
      }
      return { ok: true, example };
    },
  };
}
