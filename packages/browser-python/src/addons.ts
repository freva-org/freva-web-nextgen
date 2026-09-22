/**
 * The curated add-on catalogue, as data - the one description both sides read. A build tool has to
 * know whether an add-on is real and whether it works with the chosen profile, and those answers
 * belong to THIS package, which pins the artefacts. So the catalogue is exported rather than
 * mirrored, and it carries nothing but names, titles and profiles - nothing a bundler would pull a
 * Worker in for.
 */

import { ADDON_IDS, ADDON_PINS } from "./worker/addon-pins.generated.js";
import { supportsOptional } from "./addon-capabilities.js";
import type { BrowserPythonAddon, BrowserPythonProfile } from "./types.js";

export { supportsOptional } from "./addon-capabilities.js";

/** What a build tool needs to validate a configuration, and no more. */
export interface AddonDescription {
  id: BrowserPythonAddon;
  /** One line, for a diagnostic that has to name the thing in words. */
  title: string;
  /** The profiles this add-on may be combined with. */
  profiles: readonly BrowserPythonProfile[];
  /**
   * Whether this add-on's ABSENCE can be tolerated without leaving a half-changed interpreter.
   * Derived from the pin rather than declared beside it, so adding a wheel takes its optionality
   * away automatically. See `supportsOptional`.
   */
  optionalCapable: boolean;
  /** Where the data came from, when an add-on ships data this project did not author. */
  dataset?: {
    name: string;
    release: string;
    source: string;
    home: string;
    licence: string;
    attribution: string;
  };
}

/** Every curated add-on, sorted by id so two builds list them the same way. */
export const ADDONS: readonly BrowserPythonAddon[] = ADDON_IDS as readonly BrowserPythonAddon[];

/**
 * Whether an add-on may be declared OPTIONAL - a proof about preparation, not a preference.
 *
 * Preparation is: fetch every artefact, verify every digest, write the files, run the activation.
 * One that installs no wheels and loads no runtime packages does pure I/O into memory before the
 * write, so a failure anywhere leaves the interpreter exactly as it was, and the files land under
 * `/freva-addons/<id>/`, which nothing reads unless the activation points at it.
 *
 * An add-on WITH wheels cannot promise that: `micropip.install` mutates the interpreter, and three
 * wheels mean two intermediate states holding some of Dask's dependency closure and not Dask. So
 * `dask` is required or absent. `false` for an unknown id.
 */
export const ADDON_CATALOGUE: Readonly<Record<BrowserPythonAddon, AddonDescription>> =
  Object.freeze(
    Object.fromEntries(
      ADDONS.map((id) => {
        const pin = ADDON_PINS[id]!;
        return [
          id,
          Object.freeze({
            id,
            title: pin.title,
            profiles: pin.profiles as readonly BrowserPythonProfile[],
            optionalCapable: supportsOptional(id),
            ...(pin.dataset
              ? {
                  dataset: Object.freeze({
                    name: pin.dataset.name,
                    release: pin.dataset.release,
                    source: pin.dataset.source,
                    home: pin.dataset.home,
                    licence: pin.dataset.licence,
                    attribution: pin.dataset.attribution,
                  }),
                }
              : {}),
          }),
        ];
      }),
    ),
  ) as Readonly<Record<BrowserPythonAddon, AddonDescription>>;

export function isAddon(value: string): value is BrowserPythonAddon {
  return (ADDONS as readonly string[]).includes(value);
}

/** The profiles an add-on works with - stated, so an incompatible pair is a message and not a crash. */
export function addonProfiles(id: BrowserPythonAddon): readonly BrowserPythonProfile[] {
  return ADDON_CATALOGUE[id].profiles;
}

/** Every profile this package offers, for a builder that has to validate one. */
export const PROFILES: readonly BrowserPythonProfile[] = ["minimal", "xarray-zarr", "freva-client"];

/**
 * Profiles whose STARTUP reaches a public package index, so a host must permit one.
 *
 * `freva-client` installs one derived wheel with dependency resolution enabled and micropip
 * fetches the rest from PyPI, so a page serving it under a policy naming no index gets a
 * build that succeeds and an interpreter that fails at metadata lookup. Stated here rather
 * than in each host, because it is this package's install behaviour that creates the
 * requirement: a host reading this cannot be out of date with the profile it names.
 *
 * A HOST THAT PERMITS IT IS NO LONGER FULLY CURATED. The index is reachable from the page,
 * so a visitor can install anything else on it too. That is the trade the profile costs,
 * and a deployment offering this profile should say so where it describes its environment.
 */
export const PROFILES_NEEDING_PACKAGE_INDEX: readonly BrowserPythonProfile[] = ["freva-client"];

/**
 * Whether starting this profile reaches a public package index. See the list above.
 *
 * Takes a `string`, not a `BrowserPythonProfile`: a host validates a configured profile name
 * against `PROFILES` and then carries it as the string its configuration schema produced, and a
 * narrower parameter would make every such caller cast. An unknown name answers `false`, which
 * is the right answer - it is not a profile that needs an index, and naming a profile that does
 * not exist is a different diagnostic.
 */
export function profileNeedsPackageIndex(profile: string): boolean {
  return (PROFILES_NEEDING_PACKAGE_INDEX as readonly string[]).includes(profile);
}
