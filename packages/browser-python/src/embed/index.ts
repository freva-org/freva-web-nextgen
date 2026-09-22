/**
 * The two-origin embedding surface: a portal page, a playground on its own origin, and a bounded
 * artifact bridge between them. A separate entry point on purpose - a host that embeds nothing pays
 * nothing for this, and the headless engine's byte budget stays a budget for the engine.
 */
export {
  EMBED_CHANNEL,
  EMBED_PROTOCOL_VERSION,
  MAX_TRANSCRIPT_CHARS,
  accepted,
  basename,
  boundTranscript,
  isBridgeOp,
  isByteCount,
  isEmbeddedArtifact,
  newChallenge,
  newIdentity,
  newSessionId,
  type BridgeOp,
  type ChunkAck,
  type ChunkMessage,
  type EmbeddedArtifact,
  type HostMessage,
  type PlaygroundMessage,
} from "./protocol.js";
export {
  DEFAULT_CLEANUP_MS,
  DEFAULT_INACTIVITY_MS,
  createPlaygroundHost,
  saveFilePickerSink,
  type DownloadOptions,
  type DownloadableArtifact,
  type HostSink,
  type PlaygroundHost,
  type PlaygroundHostOptions,
} from "./host.js";
export {
  attachPlaygroundBridge,
  type PlaygroundBridge,
  type PlaygroundBridgeOptions,
} from "./playground.js";
// Re-exported here as well as from `./embed/examples`, because the bridge's own options take an
// `ExampleRegistry` and a consumer should not have to find a second import path to build one.
export {
  createExampleRegistry,
  parseExampleManifest,
  parseRegisteredExample,
  sha256Hex,
  verifyExampleManifest,
  type ExampleRefusal,
  type ExampleRegistry,
  type ExampleResolution,
  type RegisteredExample,
} from "./examples.js";
