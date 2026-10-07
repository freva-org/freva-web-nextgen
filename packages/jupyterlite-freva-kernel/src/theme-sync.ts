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

/** What `followTheme` needs of JupyterLab's theme manager. */
export interface ThemeTarget {
  readonly theme: string | null;
  setTheme(name: string): Promise<void>;
  readonly themeChanged: {
    connect(slot: (sender: unknown, args: { newValue: unknown }) => void): unknown;
  };
}

/** How long a switch may take to load before the next request may start another. */
export const THEME_SWITCH_LIMIT_MS = 10_000;

/**
 * Applies requested themes one switch at a time. A request for the theme being switched to is
 * dropped (a second switch would only show the splash again); any other is checked against the
 * app's theme once the switch has loaded or failed, so a repeat still applies after a failed
 * switch or a change made in the notebook.
 */
export function followTheme(target: ThemeTarget): (theme: string) => void {
  let wanted: string | null = null;
  let switching: { theme: string; done: () => void } | null = null;
  target.themeChanged.connect((_, args) => {
    if (switching && args.newValue === switching.theme) switching.done();
  });
  const reconcile = (): void => {
    if (switching || wanted === null || target.theme === wanted) return;
    const theme = wanted;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (switching?.done !== done) return;
      clearTimeout(timer);
      switching = null;
      if (wanted !== theme) reconcile();
    };
    switching = { theme, done };
    // Saved is not loaded: the switch is over when the theme changes, or it failed.
    target.setTheme(theme).then(() => {
      if (switching?.done === done) timer = setTimeout(done, THEME_SWITCH_LIMIT_MS);
    }, done);
  };
  return (theme) => {
    wanted = theme;
    reconcile();
  };
}
