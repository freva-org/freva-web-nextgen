export function notebookUrl(
  href: string,
  base: string,
  options: { theme?: "dark" | "light"; dataset?: string | undefined; panel?: "data" } = {},
): string {
  const url = new URL(href, base);
  if (options.theme) url.searchParams.set("theme", options.theme);
  if (options.dataset) url.searchParams.set("dataset", options.dataset);
  if (options.panel) url.searchParams.set("panel", options.panel);
  return url.href;
}
