// intent-mount.ts - the typed public initializer a host page uses to hand this component a search.
//
// Split from `intent.ts` so the pure serialisation half stays importable without the mounting half
// (the portal's build-time code needs the former and must not pull the widget into a Node process).
//
// The normalisation step matters: the reserved intent keys are removed from the address bar with
// `history.replaceState` BEFORE the component reads the URL, so what a visitor ends up sharing is
// this component's ordinary deep link, and reloading it reproduces the same query without the
// intent layer being involved at all.

import { mountDataBrowser } from "./index.js";
import { applySearchIntentV1, parseSearchIntentV1 } from "./intent.js";
import type { DataBrowserConfig, DataBrowserHandle } from "./types.js";

export {
  SEARCH_INTENT_VERSION,
  SEARCH_INTENT_VERSION_KEY,
  SEARCH_INTENT_TEXT_KEY,
  applySearchIntentV1,
  parseSearchIntentV1,
  serializeSearchIntentV1,
  textToFacetValue,
  type ParsedIntent,
  type SearchIntentV1,
} from "./intent.js";

export interface IntentMountOptions {
  /** Defaults to `window.location.search`. */
  search?: string;
  /** The component's uniq key; free text is mapped onto it. */
  uniqKey?: "file" | "uri";
  /** Rewrite the address bar to the normalised deep link. Default true. */
  normalizeUrl?: boolean;
}

export function mountDataBrowserFromIntent(
  target: HTMLElement,
  config: DataBrowserConfig = {},
  options: IntentMountOptions = {},
): DataBrowserHandle {
  const search = options.search ?? (typeof window !== "undefined" ? window.location.search : "");
  const parsed = parseSearchIntentV1(search, options.uniqKey ?? "file");

  if (
    options.normalizeUrl !== false &&
    typeof window !== "undefined" &&
    window.history &&
    parsed.normalizedSearch !== search.replace(/^\?/, "")
  ) {
    const url = new URL(window.location.href);
    url.search = parsed.normalizedSearch ? `?${parsed.normalizedSearch}` : "";
    window.history.replaceState(null, "", url.toString());
  }

  return mountDataBrowser(target, applySearchIntentV1(config, parsed.intent));
}
