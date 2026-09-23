/**
 * The SAME-ORIGIN loader: the window chrome and the console that runs Python in this document.
 *
 * Imported by the generated entry only when no `playgroundOrigin` was configured. See
 * `./python-chunks.ts` for why the choice is the build's rather than a branch at run time.
 */

import type { ChunkLoader, Chunks } from "./python-chunks.js";

let pending: Promise<Chunks> | null = null;

export const loadLocalChunks: ChunkLoader = () => {
  if (pending) return pending;
  pending = Promise.all([
    import("@freva-org/freva-client-terminal"),
    import("@freva-org/browser-python/console"),
  ])
    .then(([terminal, console_]) => ({
      createTerminalWindow: terminal.createTerminalWindow,
      defineBrowserPythonConsole: console_.defineBrowserPythonConsole,
    }))
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
};
