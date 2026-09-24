/**
 * The playground's entry point: the one module the generated entry imports when a portal asked for
 * a Python playground, and the only place the heavy chunks are reachable from.
 *
 * It is deliberately small. What it owns is the AUTOSTART decision - when to fetch the rest.
 * Everything behind that decision, the terminal window, the console element, jQuery, Prism and a
 * WebAssembly interpreter, is behind a dynamic import, so a visitor who never asks downloads none
 * of it and a portal that never configured Python does not contain this module at all.
 */

import {
  onTryPython,
  pythonBlocks,
  type ExampleBinder,
  type TryPythonRequest,
} from "../python-bridge.js";
import type { ChunkLoader } from "./python-chunks.js";
import type { PythonPlayground } from "./python-playground.js";

/**
 * ONE playground per page, not one per block. The window is a place the visitor put somewhere and
 * typed into, and a second one appearing because a landing carries two dataset-tree blocks would
 * be two of the same place. Every block's examples are merged, so a press in either tree reaches
 * the same session; the build refuses a page whose blocks disagree about anything else (`FP1215`),
 * which is what makes merging their configuration safe rather than lossy.
 */
let playground: Promise<PythonPlayground | null> | null = null;
/**
 * How the heavy code is fetched, handed in by the generated entry. The topology is build
 * configuration - a `playgroundOrigin` or not - and the two loaders live in two modules so that
 * only one is ever in a build's graph. See `./python-chunks.ts`.
 */
let loadChunks: ChunkLoader | null = null;

function ensure(): Promise<PythonPlayground | null> {
  if (playground) return playground;
  const blocks = pythonBlocks();
  const first = blocks[0];
  if (!first) return Promise.resolve(null);

  const sources = new Map(first.sources);
  const digests = [...first.config.examples];
  // Binders, keyed by the example they belong to, merged the same way the sources are: one page
  // has one coordinator and it has to answer for every provider's examples. A provider with no
  // templates contributes nothing, which is why a documentation-only page carries no store binder.
  const binders = new Map<string, ExampleBinder>();
  const collect = (block: (typeof blocks)[number]): void => {
    if (!block.bind) return;
    for (const id of block.sources.keys()) binders.set(id, block.bind);
  };
  collect(first);
  for (const block of blocks.slice(1)) {
    for (const [id, source] of block.sources) sources.set(id, source);
    digests.push(...block.config.examples);
    collect(block);
  }

  playground = import("./python-playground.js")
    .then(({ createPythonPlayground }) => {
      const instance = createPythonPlayground(
        { ...first.config, examples: digests },
        sources,
        loadChunks!,
        binders,
      );
      return instance;
    })
    .catch((error: unknown) => {
      // Cleared so a visitor whose network dropped can press again; reported on the block,
      // because "nothing happened" is not an answer to a press.
      playground = null;
      const note = document.createElement("p");
      note.className = "portal-note portal-python-failed";
      note.setAttribute("role", "status");
      note.textContent =
        "The Python playground could not be loaded: " +
        (error instanceof Error ? error.message : String(error));
      first.host.after(note);
      return null;
    });
  return playground;
}

export function preparePythonPlayground(chunkLoader: ChunkLoader): void {
  loadChunks = chunkLoader;
  const first = pythonBlocks()[0];
  if (!first) return;

  onTryPython((request: TryPythonRequest) => {
    void ensure().then((instance) => instance?.run(request));
  });

  // THERE IS NO STANDING LAUNCHER, and the gap is deliberate: a page whose catalogue has nothing
  // runnable in it has no `Try in Python` anywhere, and a visitor who closes the terminal window
  // has no way back to a prompt the portal advertised. `autostart` covers a portal that wants the
  // prompt up; a portal that wants a permanent way in should ask for a control in a place that is
  // honestly the page's - the header, or a landing block of its own - rather than in a panel that
  // is about datasets.
  const autostart = first.config.autostart;
  if (autostart === "immediately") {
    // During initialisation, and it SHOWS. A portal asking for this has decided that every
    // visitor to this page wants an interpreter, including the ones who never press anything.
    void ensure().then((instance) => instance?.open());
    return;
  }
  if (autostart === "after-interactive") {
    // Warmed, not shown: the chunks are fetched and the interpreter is STARTED while the page is
    // idle, so the first press runs immediately. Constructing the coordinator alone would leave a
    // window with no interpreter behind it and a first press that pays the whole startup.
    const warm = (): void => {
      void ensure().then((instance) => instance?.warm().catch(() => undefined));
    };
    const idle = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
    if (typeof idle === "function") idle(warm);
    else setTimeout(warm, 1500);
  }
  // `never` starts nothing here. A `Try in Python` press brings an interpreter up, and
  // `PythonPlayground.open()` starts one because opening the prompt is asking for one.
}
