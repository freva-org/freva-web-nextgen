/**
 * Sessions: per-session setup choices, live-interpreter slots, resource telemetry and manual
 * sleep. A separate entry point; a host with one fixed interpreter never imports it.
 */
export {
  canonicalJson,
  describeSetup,
  policyFingerprint,
  sameSetup,
  starterApplies,
  validateSetup,
  type SessionFrontend,
  type SessionPolicy,
  type SessionSetup,
  type SetupCheck,
} from "./policy.js";
export {
  MAX_LIVE_INTERPRETERS,
  createSlotBroker,
  type Slot,
  type SlotBroker,
  type SlotBrokerOptions,
  type SlotHolder,
} from "./slots.js";
export {
  CHECKPOINT_FORMAT,
  CHECKPOINT_ROOT,
  CheckpointError,
  DEFAULT_CHECKPOINT_LIMITS,
  openCheckpointStore,
  parseManifest,
  type CheckpointFile,
  type CheckpointLimits,
  type CheckpointManifest,
  type CheckpointStore,
  type CheckpointStoreOptions,
  type CheckpointWriter,
  type DirectoryHandleLike,
} from "./checkpoint.js";
export {
  RECLAIMED,
  SessionController,
  SessionError,
  type SessionControllerOptions,
  type SessionSnapshot,
  type SessionState,
} from "./controller.js";
export { describeResources, formatBytes } from "./telemetry.js";
export { Sha256, sha256Bytes } from "./sha256.js";
