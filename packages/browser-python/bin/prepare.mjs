/**
 * The preparation surface, for a build tool that owns a portal's configuration.
 *
 * `@freva-org/portal-builder` has to answer a question this package cannot: given one
 * `portal.yaml`, WHICH runtime, wheels and add-on artefacts does that deployment need? Resolving a
 * portal is the builder's job and pinning artefacts is this package's, so with only a shell command
 * line as shared vocabulary a portal ends up preparing add-ons from an environment variable while
 * its YAML says something else.
 *
 * So this exports what a planner needs and nothing more: `plannedAddons`, `plannedWheelhouse`, the
 * verifiers (`verifyAddons`, `verifyWheelhouse`, `verifyPreparedRuntime`) and the two
 * network-enabled preparers - as re-exports, because a planner that computed the artefact list
 * itself would be a second copy of the pin file.
 *
 * NOTHING HERE RUNS IN A BROWSER: build-time Node modules reading `node:fs`. What a running
 * interpreter enforces is the digests compiled into the worker bundle from the same pin file.
 */

export {
  ADDON_MANIFEST,
  ADDON_PINS,
  addonFootprint,
  plannedAddons,
  plannedArtifacts,
  prepareAddons,
  verifyAddons,
} from "./freva-addons.mjs";

export {
  WHEELHOUSE_MANIFEST,
  plannedWheelhouse,
  plannedWheels,
  prepareFrevaWheelhouse,
  verifyWheelhouse,
} from "./freva-wheelhouse.mjs";

export {
  RUNTIME_STAMP,
  coreOf,
  recordedRelease,
  verifyPreparedRuntime,
} from "./runtime-verify.mjs";
