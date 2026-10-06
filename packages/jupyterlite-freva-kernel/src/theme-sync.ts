// The portal theme, read from the URL or a message (no JupyterLab here: unit-testable).

export type PortalTheme = "dark" | "light";

export const LIGHT_THEME = "JupyterLab Light";
export const DARK_THEME = "JupyterLab Dark";

/** A theme from the URL (`?theme=`), or null. */
export function themeFromUrl(href: string): PortalTheme | null {
  try {
    const value = new URL(href).searchParams.get("theme");
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

/** A theme from a portal message, or null for anything else. */
export function themeFromMessage(data: unknown): PortalTheme | null {
  const message = data as { type?: unknown; mode?: unknown } | null;
  if (message?.type !== "freva-portal-theme") return null;
  return message.mode === "dark" || message.mode === "light" ? message.mode : null;
}
