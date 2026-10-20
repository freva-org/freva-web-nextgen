export function notebookUrl(
  href: string,
  base: string,
  options: {
    theme?: "dark" | "light";
    dataset?: string | undefined;
    example?: string | undefined;
    panel?: "data";
  } = {},
): string {
  const url = new URL(href, base);
  if (options.theme) url.searchParams.set("theme", options.theme);
  if (options.dataset) url.searchParams.set("dataset", options.dataset);
  if (options.example) url.searchParams.set("example", options.example);
  if (options.panel) url.searchParams.set("panel", options.panel);
  return url.href;
}

const REQUEST_PARAMS = new Set(["dataset", "example", "panel", "theme"]);

export function notebookRequestFor(
  link: string,
  notebook: string,
): { dataset?: string; example?: string; panel?: boolean } | null {
  let url: URL;
  let target: URL;
  try {
    url = new URL(link);
    target = new URL(notebook);
  } catch {
    return null;
  }
  if (url.origin !== target.origin || url.pathname !== target.pathname || url.hash) return null;
  let other = false;
  url.searchParams.forEach((value, key) => {
    if (!REQUEST_PARAMS.has(key) || (key === "panel" && value !== "data")) other = true;
  });
  if (other) return null;
  const dataset = url.searchParams.get("dataset");
  const example = url.searchParams.get("example");
  return {
    ...(dataset ? { dataset } : {}),
    ...(example ? { example } : {}),
    ...(url.searchParams.get("panel") === "data" ? { panel: true } : {}),
  };
}
