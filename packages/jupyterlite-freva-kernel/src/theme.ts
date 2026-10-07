// The notebook follows the portal's light or dark theme: `?theme=dark|light` when it is opened
// from the portal in a new tab, and the portal's messages when it is framed in a page (it says
// when it is ready, and the page answers with its theme, then tells every change). Only the
// framing page is listened to, and only for a theme.

import type { JupyterFrontEnd, JupyterFrontEndPlugin } from "@jupyterlab/application";
import { IThemeManager } from "@jupyterlab/apputils";

import {
  DARK_THEME,
  LIGHT_THEME,
  followTheme,
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
  activate: (app: JupyterFrontEnd, themes: IThemeManager | null) => {
    if (!themes) return;
    // The page tells its theme on the frame's load AND when the notebook says it is ready.
    const follow = followTheme(themes);
    const apply = (mode: PortalTheme) => follow(mode === "dark" ? DARK_THEME : LIGHT_THEME);
    // A new tab's theme, while the app is still starting (under its own splash).
    const initial = themeFromUrl(window.location.href);
    if (initial) apply(initial);
    if (window.parent === window) return;
    // A framing page's, once the app has started and its splash is gone: JupyterLab removes the
    // splash 200 ms after hiding it, and a switch that shows it again inside that window makes the
    // second removal throw (`removeChild` on a node already removed).
    const settled = app.restored.then(async () => {
      for (let i = 0; i < 40 && document.getElementById("jupyterlab-splash"); i += 1) {
        await new Promise((done) => setTimeout(done, 50));
      }
    });
    window.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const mode = themeFromMessage(event.data);
      if (mode) void settled.then(() => apply(mode));
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
