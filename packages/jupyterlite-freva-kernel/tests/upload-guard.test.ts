// Notebook uploads: validated as a whole before the contents store sees any of it.
import { describe, expect, it } from "vitest";
import type { Contents } from "@jupyterlab/services";

import { guardNotebookUploads } from "../src/upload-guard.js";

const NB = JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 });
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function store() {
  const files = new Map<string, string>();
  const saves: Array<{ path: string; chunk?: number }> = [];
  const contents = {
    save: async (path: string, options?: Partial<Contents.IModel> & { chunk?: number }) => {
      saves.push({ path, ...(options?.chunk !== undefined ? { chunk: options.chunk } : {}) });
      files.set(path, Buffer.from(String(options?.content), "base64").toString("utf8"));
      return { path } as Contents.IModel;
    },
    delete: async (path: string) => {
      files.delete(path);
    },
  } as unknown as Contents.IManager;
  guardNotebookUploads(contents);
  return { contents, files, saves };
}

const upload = (path: string, content: string, chunk?: number) =>
  ({
    type: "file",
    format: "base64",
    name: path,
    content: b64(content),
    ...(chunk !== undefined ? { chunk } : {}),
  }) as Partial<Contents.IModel>;

describe("guardNotebookUploads", () => {
  it("a rejected replacement upload leaves the existing notebook untouched", async () => {
    const { contents, files } = store();
    files.set("precious.ipynb", NB);
    await expect(
      contents.save("precious.ipynb", upload("precious.ipynb", "not json")),
    ).rejects.toThrow(/not a valid notebook/);
    await contents.save("precious.ipynb", upload("precious.ipynb", '{"broken": ', 1));
    await expect(
      contents.save("precious.ipynb", upload("precious.ipynb", "true", -1)),
    ).rejects.toThrow(/not a valid notebook/);
    expect(files.get("precious.ipynb")).toBe(NB);
  });

  it("stores nothing until the last chunk, then writes the whole file once", async () => {
    const { contents, files, saves } = store();
    const half = Math.floor(NB.length / 2);
    await contents.save("new.ipynb", upload("new.ipynb", NB.slice(0, half), 1));
    expect(files.has("new.ipynb")).toBe(false);
    expect(saves).toHaveLength(0);
    await contents.save("new.ipynb", upload("new.ipynb", NB.slice(half), -1));
    expect(files.get("new.ipynb")).toBe(NB);
    expect(saves).toEqual([{ path: "new.ipynb" }]);
  });

  it("an oversized upload is refused without touching the destination", async () => {
    const { contents, files } = store();
    files.set("big.ipynb", NB);
    const mib = "x".repeat(1024 * 1024);
    let error: unknown = null;
    for (let i = 1; i <= 40 && !error; i += 1) {
      await contents.save("big.ipynb", upload("big.ipynb", mib, i)).catch((e) => (error = e));
    }
    expect(String(error)).toMatch(/over 32 MiB/);
    expect(files.get("big.ipynb")).toBe(NB);
  });

  it("other files pass straight through", async () => {
    const { contents, files } = store();
    await contents.save("a.txt", { type: "file", format: "text", content: "hi" });
    expect(files.has("a.txt")).toBe(true);
  });
});
