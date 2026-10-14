const SHEET_PARAMS = new Set(["dataset", "example", "panel", "theme"]);

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

const decode = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) =>
    name.startsWith("#x") || name.startsWith("#X")
      ? String.fromCodePoint(parseInt(name.slice(2), 16))
      : name.startsWith("#")
        ? String.fromCodePoint(parseInt(name.slice(1), 10))
        : (ENTITIES[name.toLowerCase()] ?? whole),
  );

export function opensNotebookSheet(href: string, sheet: string, origin: string): boolean {
  let url: URL;
  let base: URL;
  try {
    base = new URL(origin);
    url = new URL(href, base);
  } catch {
    return false;
  }
  if (url.origin !== base.origin || url.pathname !== sheet || url.hash) return false;
  let other = false;
  url.searchParams.forEach((value, key) => {
    if (!SHEET_PARAMS.has(key) || (key === "panel" && value !== "data")) other = true;
  });
  return !other;
}

export function proseOpensNotebookSheet(html: string, sheet: string, origin: string): boolean {
  for (const match of html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/gi)) {
    if (opensNotebookSheet(decode(match[1]!), sheet, origin)) return true;
  }
  return false;
}
