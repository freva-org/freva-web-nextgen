// describe.ts - one (key, value) -> description lookup, and nothing else.
//
// A leaf module on purpose. The search bar reaches it through `state.ts`, the picker through the
// same, and the portal's landing box through the `@freva-org/databrowser/metadata` subpath; giving
// it a home of its own is what keeps `state.ts` and `metadata.ts` from importing each other.

import type { MetadataMap } from "./types.js";

/**
 * One (key, value) description, looked up the way every consumer must look it up.
 *
 * The subtlety this exists to hold in one place: with server-side translation on, `key` arrives in
 * the CURRENT FLAVOUR's naming (`source_id`, `mip_era`, ...) while the metadata is keyed by the
 * NATIVE freva key (`model`, `project`, ...). `backward` is the flavour's flavour->freva table;
 * pass `undefined` when the keys are already native. The native key is tried first and the given
 * key second, so a deployment that describes a flavour key directly still works.
 *
 * A consumer that gets this wrong shows no description rather than failing, which is exactly the
 * kind of bug that survives review - hence one function, used by the search bar, the picker and
 * the portal's landing box alike.
 */
export function describeMetadataValue(
  metadata: MetadataMap,
  backward: Record<string, string> | undefined,
  key: string,
  value: string,
): string | null {
  const nativeKey = backward?.[key] ?? key;
  const block = metadata[nativeKey] ?? metadata[key];
  const desc = block ? block[value] : undefined;
  return typeof desc === "string" && desc.length > 0 ? desc : null;
}
