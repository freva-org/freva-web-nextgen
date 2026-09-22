/**
 * @freva-org/browser-python - Python in the browser, in a Worker, with no backend.
 *
 * One engine per page is enough: every UI on the page can consume the same instance, because the
 * engine is a state machine with listeners rather than a component with a render.
 *
 *     import { createBrowserPython } from "@freva-org/browser-python";
 *
 *     const python = createBrowserPython({ profile: "xarray-zarr" });
 *     python.onOutput((event) => { ... });
 *     await python.start();
 *     await python.push("1 + 1");
 */

export { createBrowserPython, DEFAULT_PYODIDE_INDEX_URL } from "./browser-python.js";
export { BrowserPythonError, MAX_WORKSPACE_FILES } from "./types.js";
export {
  ArtifactTransferAborted,
  CHUNK_BYTES,
  MAX_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  toSink,
} from "./artifact-stream.js";
export {
  ADDON_CATALOGUE,
  ADDONS,
  PROFILES,
  PROFILES_NEEDING_PACKAGE_INDEX,
  addonProfiles,
  isAddon,
  profileNeedsPackageIndex,
  supportsOptional,
} from "./addons.js";
export type { AddonDescription } from "./addons.js";
export { PROTOCOL_VERSION, isDisplayMime, validateDisplay } from "./protocol.js";
export { CSP_DIRECTIVES, PACKAGE_INDEX_ORIGINS, contentSecurityPolicy } from "./csp.js";
export { isActiveMime, mimeForName, previewKind, previewRefusal } from "./artifact-mime.js";

export type {
  ArtifactData,
  ArtifactSink,
  ArtifactStreamOptions,
  ArtifactStreamResult,
  ArtifactInfo,
  ArtifactsEvent,
  ArtifactsListener,
  BrowserPython,
  BrowserPythonAddon,
  BrowserPythonOptions,
  BrowserPythonProfile,
  BrowserPythonReadyInfo,
  BrowserPythonState,
  CompletionResult,
  DisplayEvent,
  DisplayMime,
  ErrorEvent,
  ExecutionResult,
  FatalEvent,
  OutputEvent,
  OutputListener,
  PushResult,
  PyodideOptions,
  ReadyAddonInfo,
  UnavailableAddonInfo,
  ReplSyntaxState,
  StatusEvent,
  StatusListener,
  StreamEvent,
  Unsubscribe,
  UnsupportedReason,
  WorkspaceStatus,
  WorkspaceUnavailableReason,
} from "./types.js";

export type { WorkerMessage, WorkerRequest, DisplayMessage, StreamMessage } from "./protocol.js";
export type { CspOptions } from "./csp.js";
export type { PreviewKind } from "./artifact-mime.js";
