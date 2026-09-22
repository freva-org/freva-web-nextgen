/** Types for the build-time preparation surface. See `prepare.mjs` for what it is for. */
export {
  ADDON_MANIFEST,
  ADDON_PINS,
  addonFootprint,
  plannedAddons,
  plannedArtifacts,
  prepareAddons,
  verifyAddons,
  type AddonArtifactPlan,
} from "./freva-addons.d.mts";

export {
  WHEELHOUSE_MANIFEST,
  plannedWheelhouse,
  plannedWheels,
  prepareFrevaWheelhouse,
  verifyWheelhouse,
} from "./freva-wheelhouse.d.mts";

export {
  RUNTIME_STAMP,
  coreOf,
  recordedRelease,
  verifyPreparedRuntime,
  type RuntimeRelease,
} from "./runtime-verify.d.mts";
