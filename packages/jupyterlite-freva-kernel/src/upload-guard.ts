// The upload guard, apart from the plugin (no DOM): validates an uploaded `.ipynb` before the
// contents store sees any of it.

import type { Contents } from "@jupyterlab/services";

import { MAX_NOTEBOOK_BYTES, parseNotebook } from "./ipynb.js";

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Wrap `contents.save` so a `.ipynb` arriving as an upload (a base64 file, possibly chunked) is
 * validated before anything is stored. Chunks are held here, bounded, and reach the contents
 * store only as one complete, valid file: a rejected upload leaves whatever was at that path -
 * an earlier notebook included - exactly as it was.
 */
export function guardNotebookUploads(contents: Contents.IManager): void {
  const original = contents.save.bind(contents);
  const pending = new Map<string, Uint8Array[]>();
  contents.save = async (path: string, options?: Partial<Contents.IModel>) => {
    const isUpload =
      path.toLowerCase().endsWith(".ipynb") &&
      options?.type === "file" &&
      options.format === "base64" &&
      typeof options.content === "string";
    if (!isUpload) return original(path, options);
    const chunk = (options as { chunk?: number }).chunk;
    const bytes = decodeBase64(options.content as string);
    let whole: Uint8Array = bytes;
    if (chunk !== undefined) {
      // JupyterLab numbers chunks from 1; a 1 starts a new upload to this path.
      const parts = chunk === 1 ? [] : (pending.get(path) ?? []);
      parts.push(bytes);
      const size = parts.reduce((n, p) => n + p.byteLength, 0);
      if (size > MAX_NOTEBOOK_BYTES) {
        pending.delete(path);
        throw new Error(
          `${path} is not a notebook this site accepts: over ${MAX_NOTEBOOK_BYTES / 1048576} MiB.`,
        );
      }
      if (chunk !== -1) {
        pending.set(path, parts);
        // Nothing is stored yet; the uploader only needs an answer to send the next chunk.
        const now = new Date().toISOString();
        return {
          name: path.split("/").pop() ?? path,
          path,
          type: "file",
          format: null,
          mimetype: "application/x-ipynb+json",
          content: null,
          created: now,
          last_modified: now,
          writable: true,
          size,
        } as Contents.IModel;
      }
      pending.delete(path);
      whole = new Uint8Array(size);
      let at = 0;
      for (const part of parts) {
        whole.set(part, at);
        at += part.byteLength;
      }
    }
    try {
      parseNotebook(new TextDecoder("utf-8", { fatal: true }).decode(whole));
    } catch (error) {
      throw new Error(
        `${path} was not uploaded: it is not a valid notebook (${
          error instanceof Error ? error.message : String(error)
        }).`,
      );
    }
    // One write of the whole, validated file: the destination changes only now.
    const { chunk: _chunk, ...single } = options as Partial<Contents.IModel> & { chunk?: number };
    void _chunk;
    return original(
      path,
      chunk === undefined ? options : { ...single, content: encodeBase64(whole) },
    );
  };
}
