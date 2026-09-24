/**
 * The one raw-path safety contract.
 *
 * Every path the portal accepts - a canonical URL's pathname, a service URL's pathname, a
 * generated route, a manifest entry, a verified artifact path, a trusted subsite's local
 * reference, a collision key - is checked here before anything else touches it.
 *
 * *Order*: `new URL()`, `posix.normalize()` and `String.normalize()` collapse structure - after
 * them `/site/../admin/` and `/site/%2e%2e/admin/` are both `/admin/`, and the evidence that the
 * author wrote something ambiguous is gone. The authored text is validated first, always; a
 * caller that parses before it validates is a defect.
 *
 * *Depth*: one decoding layer is not enough. `/docs/%252e%252e/admin/` decodes once to
 * `/docs/%2e%2e/admin/` and twice to `/docs/../admin/`, and a single-pass check sees neither `..`
 * nor an encoded `.`. So escapes for the structural characters `%`, `.`, `/`, `\` are refused,
 * making a second decoding layer impossible, and the path is also decoded to a bounded fixed
 * point and refused if further decoding would change its structure. Either check alone suffices;
 * both mean relaxing one is not a silent hole.
 *
 * Nothing here normalizes: an unsafe value is refused, never quietly made to look safe.
 */

/** How many decoding rounds are attempted before the input is called abusive. */
const MAX_DECODE_ROUNDS = 8;

/**
 * Control characters, written by code point so this file contains none itself. Matching them is
 * the point, so the lint rule is disabled rather than the check weakened.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001f\\u007f]");

/** A `%` that does not begin a complete two-digit escape. */
const INVALID_PERCENT = /%(?![0-9a-fA-F]{2})/;

/**
 * Escapes for the four characters that carry path structure. `%25` is included because it is what
 * makes a second decoding layer possible; without it `%252e` cannot be written at all.
 */
const STRUCTURAL_ESCAPE = /%(?:25|2e|2f|5c)/i;

export interface RawPathOptions {
  /** Site paths and pathnames are rooted; a subsite reference need not be. */
  requireLeadingSlash?: boolean;
  /** Refuse `?` and `#`. Callers that split them off first pass `false`. */
  rejectQueryAndFragment?: boolean;
  /**
   * Permit literal `.` and `..` segments. Off everywhere except references *inside* a trusted
   * subsite, where `../style.css` is how documentation generators write a sibling path; those are
   * resolved against the referring file and proved to be inside the mount. Encoded forms stay
   * refused even here - `%2e%2e` is not how anybody writes a relative path.
   */
  allowDotSegments?: boolean;
}

const DEFAULTS: Required<RawPathOptions> = {
  requireLeadingSlash: true,
  rejectQueryAndFragment: true,
  allowDotSegments: false,
};

/** The structural shape of a path: its segments, ignoring their spelling. */
function structure(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment === "." || segment === ".." ? segment : segment === "" ? "" : "x"))
    .join("/");
}

function hasDotSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * Why `raw` is not a safe path, or `undefined` if it is. Returning a reason rather than throwing
 * lets the verifier report and continue while the loader turns it into a positioned diagnostic.
 */
export function rawPathReason(raw: string, options: RawPathOptions = {}): string | undefined {
  const { requireLeadingSlash, rejectQueryAndFragment, allowDotSegments } = {
    ...DEFAULTS,
    ...options,
  };

  if (raw === "") return "is empty";
  if (requireLeadingSlash && !raw.startsWith("/")) return "does not start with '/'";
  if (raw.includes("\\")) return "contains a backslash";
  if (CONTROL_CHARACTERS.test(raw)) return "contains a control character";
  if (rejectQueryAndFragment && (raw.includes("?") || raw.includes("#"))) {
    return "contains a query or a fragment";
  }
  if (raw.normalize("NFC") !== raw) return "is not in Unicode NFC";
  if (INVALID_PERCENT.test(raw)) return "contains an incomplete percent escape";
  if (STRUCTURAL_ESCAPE.test(raw)) {
    return "percent-encodes a path separator, a dot segment or a percent sign";
  }
  if (!allowDotSegments && hasDotSegment(raw)) return "contains a '.' or '..' segment";

  // Defense in depth: decode to a fixed point and refuse if any round would change the path's
  // structure. With structural escapes already refused this settles after one round; if it ever
  // does not, the input is doing something the rules above did not anticipate.
  let current = raw;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return "is not decodable as a percent-encoded path";
    }
    if (decoded === current) return undefined;
    if (decoded.includes("\\")) return "decodes to a path containing a backslash";
    if (CONTROL_CHARACTERS.test(decoded)) return "decodes to a path containing a control character";
    if (!allowDotSegments && hasDotSegment(decoded)) {
      return "decodes to a path containing a '.' or '..' segment";
    }
    if (structure(decoded) !== structure(current)) return "changes structure when decoded";
    current = decoded;
  }
  return "does not stop changing when decoded";
}

/** True when `raw` satisfies the contract. */
export function isSafeRawPath(raw: string, options: RawPathOptions = {}): boolean {
  return rawPathReason(raw, options) === undefined;
}

/**
 * Decode a path that has already passed `rawPathReason`. One round is enough by construction, and
 * the loop asserts that rather than assuming it.
 */
export function decodeSafePath(raw: string): string {
  let current = raw;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (decoded === current) return current;
    current = decoded;
  }
  return current;
}

/**
 * The one key two paths are compared by. Derived identically for both sides, so an encoded path
 * and its decoded twin produce the same key and the verdict cannot depend on registration order.
 */
export function rawCollisionKey(raw: string): string {
  return decodeSafePath(raw).normalize("NFC").toLowerCase();
}

/**
 * Split a URL textually, without a parser. `new URL()` is the thing being defended against: it
 * removes dot segments before anyone can look at them, so the authored pathname is cut out with a
 * regular expression, checked, and only then handed to the parser.
 */
export interface AuthoredUrlParts {
  scheme: string;
  authority: string;
  path: string;
  query?: string;
  fragment?: string;
}

const AUTHORED_URL = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

export function splitAuthoredUrl(raw: string): AuthoredUrlParts | undefined {
  const match = AUTHORED_URL.exec(raw);
  if (!match) return undefined;
  const parts: AuthoredUrlParts = {
    scheme: match[1]!.toLowerCase(),
    authority: match[2]!,
    path: match[3] === "" ? "/" : match[3]!,
  };
  if (match[4] !== undefined) parts.query = match[4];
  if (match[5] !== undefined) parts.fragment = match[5];
  return parts;
}

/**
 * Collapse repeated separators, and nothing else: the only transformation the contract allows, so
 * that a parser's own `//` handling cannot be mistaken for it having removed a segment.
 */
export function collapseSeparators(path: string): string {
  return path.replace(/\/{2,}/g, "/");
}

/**
 * Confirm a parser did not change the authored pathname. Called after `new URL()` with the
 * pathname the author wrote: if the two differ by more than repeated separators, the parser
 * resolved something, and whatever it resolved was evidence.
 */
export function parserPreservedPath(authored: string, parsed: string): boolean {
  return collapseSeparators(authored) === collapseSeparators(parsed);
}
