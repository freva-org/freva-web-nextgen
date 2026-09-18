// format.ts - the two value formatters the view needs, kept pure so they can be tested without a
// DOM and reused by a consumer that renders its own summary line.

/** Binary unit steps. Object stores report bytes, and 1.4 GB of Zarr is 1.4 GiB of disk. */
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB", "EB"] as const;

/**
 * Bytes as a short human string: `842 B`, `1.4 GB`, `320 MB`. Whole numbers for bytes and for
 * anything at or above 100, one decimal below that - the precision rule a file manager uses,
 * because `1.43871 GB` is noise in a row that is mostly name. Returns `null` for anything that is
 * not a finite, non-negative number, so a malformed `size` renders as nothing rather than as `NaN`.
 */
export function formatBytes(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || size >= 100 ? String(Math.round(size)) : size.toFixed(1);
  return `${rounded} ${UNITS[unit]}`;
}

/**
 * An ISO-8601 instant as `YYYY-MM-DD HH:MM UTC`. Always UTC, never the visitor's locale: a
 * modification time is a fact about the archive, and two people comparing notes across time zones
 * should read the same string. An unparseable value is returned verbatim - hiding what the source
 * said would be worse than showing something odd - but only if it is short enough to be a
 * timestamp rather than prose.
 */
export function formatTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.length <= 40 ? value : null;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())}` +
    ` ${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())} UTC`
  );
}

/**
 * Thousands separators for counts inside metadata chips. A thin space (U+2009), not a comma and not
 * a period: those two mean opposite things either side of the Channel, and a dimension length is
 * read by people on both sides of it. Locale-independent, so the same catalog renders the same
 * digits everywhere.
 */
export function formatCount(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
}
