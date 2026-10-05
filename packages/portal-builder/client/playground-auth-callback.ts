// The shared sign-in callback on the notebook's origin (`/auth/callback/` there): the popup a
// notebook opened for signing in or out lands here and hands the response to the tab that opened
// it (`./auth-relay.ts`). No same-tab sign-in on this origin, so no auth client and no token
// exchange here: the notebook's tab owns the transaction and exchanges the code itself.

import { browserEnv, runCallback } from "./auth-relay.js";

export interface PlaygroundAuthCallbackConfig {
  /** The base path this origin serves the deployment under (the portal's). */
  basePath: string;
  /** Where "home" is: the notebook. */
  home: { href: string; label: string };
}

export function startPlaygroundAuthCallback(config: PlaygroundAuthCallbackConfig): Promise<void> {
  const root = document.querySelector<HTMLElement>("[data-auth-callback]");
  return runCallback(browserEnv(root), { basePath: config.basePath, home: config.home });
}
