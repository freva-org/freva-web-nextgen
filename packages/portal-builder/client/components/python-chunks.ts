/**
 * The shape of the two topologies' loaders, and nothing else.
 *
 * WHY A TYPE FILE. Both `import()` calls behind one `if` is correct at run time and useless as
 * evidence: a module that MENTIONS `@freva-org/browser-python/console` puts the console in the
 * bundle's graph whether the branch runs or not, and the parent of a two-origin playground then
 * serves a third of a megabyte of console, jQuery Terminal and Prism it will never use.
 *
 * So the branch lives where the build already knows the answer: `playgroundOrigin` is
 * configuration, and the generated entry imports exactly one of the two loader modules beside
 * this one. The other is not named anywhere the bundler can see, which
 * `tests/artifact/playground-origin.test.ts` checks against the emitted chunks.
 */

import type { TerminalWindowHandle, TerminalWindowOptions } from "@freva-org/freva-client-terminal";

export interface Chunks {
  createTerminalWindow: (
    mount: HTMLElement,
    options: TerminalWindowOptions,
  ) => TerminalWindowHandle;
  /** Absent in framed mode: there is no local console in that document to define. */
  defineBrowserPythonConsole?: () => void;
}

/**
 * Fetch what this topology needs. Memoised by the implementation on the PROMISE rather than the
 * result, so two presses in the same tick share one download, and cleared on failure so a visitor
 * whose network dropped can press again.
 */
export type ChunkLoader = () => Promise<Chunks>;
