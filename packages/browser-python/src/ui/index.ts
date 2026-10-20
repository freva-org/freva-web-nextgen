/**
 * `@freva-org/browser-python/ui` - the light half of the Python playground.
 *
 * The registry a page's providers (runnable code blocks, a dataset tree) register their examples
 * with, the press functions they call, and `preparePythonPlayground`, which installs the handler and
 * decides when the heavy half is fetched. Nothing here imports the terminal, the console or an
 * interpreter: those are behind the chunk loader a page passes in - `/ui/local` for an
 * interpreter in this document, `/ui/framed` for one on a separate origin - and behind the
 * dynamic import of the window itself.
 */

export {
  registerPythonBlock,
  pythonBlocks,
  onTryPython,
  onTryPythonEdited,
  tryPython,
  tryPythonEdited,
  resetPythonBridge,
} from "./python-bridge.js";
export type {
  EditedRunRequest,
  ExampleBinder,
  ExampleSource,
  PlaygroundState,
  PythonBlock,
  PythonPlaygroundConfig,
  RegisteredExampleDigest,
  RegisteredPythonBlock,
  TryPythonRequest,
} from "./python-bridge.js";
export { preparePythonPlayground } from "./python-ready.js";
export type { ChunkLoader, Chunks, SessionChunk } from "./python-chunks.js";
export type { PythonPlayground } from "./python-playground.js";
export { notebookSeedPath } from "./notebook-paths.js";
export { portalBaseSource } from "./portal-base.js";
export { osControlsFor, type OsControls } from "./os-controls-core.js";
export { DisposedError, lazyController, type LazyController } from "./lazy-controller.js";
