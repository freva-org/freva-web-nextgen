// The sign-in callback URLs a deployment must register, for the build and `prepare-notebook` to
// print: the identity provider (Keycloak: the client's "Valid redirect URIs" and "Valid post
// logout redirect URIs") and freva-rest's redirect allow-list must know each one exactly.
//
// They are printed from the configuration (`site.canonicalUrl`, `playgroundOrigin`): the pages
// themselves build the URL from the origin they are served at, so the same artifact on a
// development port or a staging host calls back to that origin - which must be registered too.

import {
  LEGACY_CALLBACK_FILE,
  NOTEBOOK_PATH,
  playgroundRoot,
  underBase,
  type AuthCallbackUrls,
} from "./notebook.js";
import type { AuthOptions, ResolvedPortalModel } from "./types.js";

export interface AuthCallbackEntry {
  /** Which consumer: "portal" (same-tab sign-in) or "notebook" (popup sign-in). */
  name: string;
  urls: AuthCallbackUrls;
}

/** The notebook's sign-in: its origin and the shared callback's path there. */
export interface NotebookCallback {
  origin: string;
  /** Site-relative (`/auth/callback/`), under `basePath`. */
  callbackPath: string;
  /** The base path the notebook's origin serves the deployment under. */
  basePath: string;
}

/**
 * Where the notebook signs in, from how it is deployed: the portal's own origin for a same-origin
 * notebook (also beside a console on a second origin), else the playground origin.
 */
export function notebookCallbackOf(
  model: Pick<ResolvedPortalModel, "playground" | "sameOriginNotebook" | "site"> | undefined,
): NotebookCallback | undefined {
  const same = model?.sameOriginNotebook;
  if (model && same) {
    return same.callbackPath
      ? {
          origin: model.site.origin,
          callbackPath: same.callbackPath,
          basePath: model.site.basePath,
        }
      : undefined;
  }
  const playground = model?.playground;
  return playground?.authCallbackPath
    ? {
        origin: playground.origin,
        callbackPath: playground.authCallbackPath,
        basePath: playground.basePath ?? "/",
      }
    : undefined;
}

/** Every sign-in callback this configuration uses. */
export function authCallbackEntries(
  model: Pick<ResolvedPortalModel, "enabledComponents"> | undefined,
  notebook: NotebookCallback | undefined,
): AuthCallbackEntry[] {
  const entries: AuthCallbackEntry[] = [];
  const auth = model?.enabledComponents.find((component) => component.kind === "auth");
  if (auth) {
    const uri = (auth.options as AuthOptions).redirectUri;
    entries.push({ name: "portal", urls: { login: uri, logout: uri } });
  }
  if (notebook?.origin) {
    const origin = notebook.origin.replace(/\/+$/, "");
    const uri = `${origin}${underBase(notebook.basePath, notebook.callbackPath)}`;
    const root = playgroundRoot(origin, notebook.basePath);
    const legacy = `${root}/${NOTEBOOK_PATH}/${LEGACY_CALLBACK_FILE}`;
    entries.push({ name: "notebook", urls: { login: uri, logout: uri, legacy } });
  }
  return entries;
}

/** The lines to print, or none. */
export function describeAuthCallbacks(entries: readonly AuthCallbackEntry[]): string[] {
  if (entries.length === 0) return [];
  const lines = [
    "sign-in callbacks: register each in the identity provider (Keycloak: Valid redirect URIs,",
    "                   Valid post logout redirect URIs) and in freva-rest's redirect allow-list",
  ];
  for (const { name, urls } of entries) {
    lines.push(`  ${name.padEnd(9)} login   ${urls.login}`);
    lines.push(`  ${"".padEnd(9)} logout  ${urls.logout}`);
    if (urls.legacy) {
      lines.push(`  ${"".padEnd(9)} legacy  ${urls.legacy} (keep during the migration)`);
    }
  }
  lines.push(
    "  served from another origin (a development port, staging): that origin, the same paths",
  );
  return lines;
}
