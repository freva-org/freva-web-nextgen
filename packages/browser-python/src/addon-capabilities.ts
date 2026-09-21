/**
 * The small piece of add-on metadata needed by the main-thread engine.
 *
 * Keep this separate from `addons.ts`: that public catalogue reads the complete worker pin table,
 * including wheel URLs and digests. Pulling it into `createBrowserPython()` merely to validate an
 * optional add-on added roughly two KiB gzip to every consumer's application bundle.
 */
import { OPTIONAL_ADDON_IDS } from "./worker/addon-pins.generated.js";

/**
 * Whether an add-on may be declared optional without a failed preparation leaving a partly
 * modified interpreter. The generated list is derived from the authoritative add-on pin file.
 */
export function supportsOptional(id: string): boolean {
  return (OPTIONAL_ADDON_IDS as readonly string[]).includes(id);
}
