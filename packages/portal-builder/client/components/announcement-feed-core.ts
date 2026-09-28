// Reads a live-announcement feed document, with no DOM, so it tests on its own.
// `announcement-feed.ts` is the island that draws the result.

export interface FeedAnnouncement {
  id: string;
  message: string;
  level: "info" | "warning" | "critical";
  dismissible: boolean;
  endsAt: number;
  link?: { href: string; label: string };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LEVELS: Record<string, FeedAnnouncement["level"]> = {
  info: "info",
  warning: "warning",
  critical: "critical",
  // Waterpark's word for the same thing.
  outage: "critical",
};

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() !== "" && value.length <= max
    ? value.trim()
    : undefined;

function safeHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The live, well-formed entries of a feed document, soonest-ending first. Accepts
 * `{ "announcements": [...] }` or a bare array, and either field vocabulary.
 */
export function parseFeed(document: unknown, now: number): FeedAnnouncement[] {
  const items = Array.isArray(document)
    ? document
    : document &&
        typeof document === "object" &&
        Array.isArray((document as { announcements?: unknown }).announcements)
      ? (document as { announcements: unknown[] }).announcements
      : [];
  const out: FeedAnnouncement[] = [];
  for (const raw of items.slice(0, 20)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" && ID.test(item.id) ? item.id : undefined;
    const message = text(item.message ?? item.text, 500);
    const ends = Date.parse(String(item.endsAt ?? item.expires ?? ""));
    const startsRaw = item.startsAt ?? item.starts;
    const starts = startsRaw === undefined ? -Infinity : Date.parse(String(startsRaw));
    if (!id || !message || !Number.isFinite(ends) || Number.isNaN(starts)) continue;
    if (!(starts <= now && now < ends)) continue;
    const href = safeHref(item.link);
    const label = text(item.linkText ?? item.link_text, 80) ?? "More";
    out.push({
      id,
      message,
      level: LEVELS[String(item.level ?? "info")] ?? "info",
      dismissible: item.dismissible !== false,
      endsAt: ends,
      ...(href ? { link: { href, label } } : {}),
    });
  }
  return out.sort((a, b) => a.endsAt - b.endsAt);
}
