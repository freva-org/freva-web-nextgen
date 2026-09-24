/**
 * The SEPARATE-ORIGIN loader: the window chrome, and that is the whole list. The interpreter, the
 * console, jQuery Terminal, Prism, the Worker and the Pyodide runtime all live in the child
 * document on the other origin, and a parent that fetched them would carry the code the two-origin
 * arrangement exists to keep out of it - silently, because nothing about the page would look
 * different.
 *
 * `@freva-org/browser-python/embed` is NOT here: it is the bridge, it is small, it contains no
 * engine, and the framed session imports it where it uses it.
 */

import type { ChunkLoader, Chunks } from "./python-chunks.js";

let pending: Promise<Chunks> | null = null;

export const loadFramedChunks: ChunkLoader = () => {
  if (pending) return pending;
  pending = import("@freva-org/freva-client-terminal")
    .then((terminal) => ({ createTerminalWindow: terminal.createTerminalWindow }) as Chunks)
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
};
