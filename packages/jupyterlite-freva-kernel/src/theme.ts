// The notebook follows the portal's light or dark theme: `?theme=dark|light` when it is opened
// from the portal in a new tab, and the portal's messages when it is framed in a page (it says
// when it is ready, and the page answers with its theme, then tells every change). Only the
// framing page is listened to, and only for a theme.

import type { JupyterFrontEnd, JupyterFrontEndPlugin } from "@jupyterlab/application";
import { IThemeManager } from "@jupyterlab/apputils";

import {
  DARK_THEME,
  LIGHT_THEME,
  themeFromMessage,
  themeFromUrl,
  type PortalTheme,
} from "./theme-sync.js";
import { containScrolling } from "./framed-scroll.js";

export const themePlugin: JupyterFrontEndPlugin<void> = {
  id: "@freva-org/jupyterlite-freva-kernel:portal-theme",
  description: "Follows the Freva portal's light or dark theme.",
  autoStart: true,
  optional: [IThemeManager],
  activate: (_app: JupyterFrontEnd, themes: IThemeManager | null) => {
    if (!themes) return;
    const apply = (mode: PortalTheme) => {
      const theme = mode === "dark" ? DARK_THEME : LIGHT_THEME;
      if (themes.theme !== theme) void themes.setTheme(theme);
    };
    const initial = themeFromUrl(window.location.href);
    if (initial) apply(initial);
    if (window.parent === window) return;
    window.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const mode = themeFromMessage(event.data);
      if (mode) apply(mode);
    });
    // Ready: the page answers with its theme. Nothing private is in it, so any parent may hear it.
    window.parent.postMessage({ type: "freva-lab-ready" }, "*");
  },
};

/** In a framing page, the notebook's scrolling stays in the notebook (see framed-scroll.ts). */
export const framedScrollPlugin: JupyterFrontEndPlugin<void> = {
  id: "@freva-org/jupyterlite-freva-kernel:framed-scroll",
  description: "Keeps focus and scroll-into-view from scrolling the page that frames the notebook.",
  autoStart: true,
  activate: () => {
    if (window.parent !== window) containScrolling();
  },
};
