// `PORTAL_BASE_URL` for an interpreter: the build's `portalBaseUrl`, resolved against the page, as
// code the interpreter runs unseen at every start (its `startupSource`). The starter then runs, and
// shows in the console and its history, exactly as the deployment wrote it.

/** The startup code, or undefined when the deployment's starter does not name it. */
export function portalBaseSource(
  portalBaseUrl: string | undefined,
  page: string,
): string | undefined {
  if (!portalBaseUrl) return undefined;
  const href = new URL(portalBaseUrl, page).href;
  // A serialised URL is printable ASCII, so its JSON string is a Python literal of the same text.
  return `PORTAL_BASE_URL = ${JSON.stringify(href)}`;
}
