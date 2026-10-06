/**
 * @freva-org/browser-python/display - rich output at the DOM boundary. Every `text/html` and
 * `image/svg+xml` a visitor's Python publishes goes through here: the console uses it for
 * `display()` bundles and the "Freva Python" notebook kernel for every cell output.
 */

export {
  PNG_MAX_PIXELS,
  PNG_MAX_SIDE,
  adoptDisplayStyles,
  adoptStyles,
  pngDimensions,
  renderBundle,
  renderHtml,
  renderNotice,
  renderPng,
  renderSvg,
} from "./render.js";
export type { RenderContext } from "./render.js";
export { sanitizeHtml, sanitizeSvg } from "./sanitize.js";
export { DISPLAY_STYLES, NOTICE_CARD_STYLES } from "./styles.generated.js";
export { NOTICE_MIME } from "../types.js";
export type { BundleMetadata, BundleMime, MimeBundle } from "../types.js";
