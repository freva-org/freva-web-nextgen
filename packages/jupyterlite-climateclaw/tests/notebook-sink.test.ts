// @vitest-environment jsdom
// Code typed into its cell: an edit made while it was typed is kept, and the output then says
// which code ran at DKRZ - decided after the code is whole, so an edit found by that last write
// is never missed.
import { describe, expect, it } from "vitest";

import { createNotebookSink } from "../src/notebook-sink.js";
import { normalizeCodeOutput } from "../src/stream.js";

function notebook() {
  const cells: Array<{
    id: string;
    type: string;
    source: string;
    outputs: unknown[];
    sharedModel: object;
  }> = [];
  const cell = (id: string) => {
    const c = {
      id,
      type: "code",
      source: "",
      outputs: [] as unknown[],
      sharedModel: {} as object,
    };
    c.sharedModel = {
      getSource: () => c.source,
      setSource: (value: string) => void (c.source = value),
      updateSource: (start: number, end: number, value: string) =>
        void (c.source = c.source.slice(0, start) + value + c.source.slice(end)),
    };
    Object.assign(c, { outputs: Object.assign([], { add: (o: unknown) => c.outputs.push(o) }) });
    return c;
  };
  const model = {
    cells: {
      get length() {
        return cells.length;
      },
      get: (i: number) => cells[i],
    },
    sharedModel: {
      insertCell: (index: number, options: { id: string }) =>
        void cells.splice(index, 0, cell(options.id)),
      deleteCell: (index: number) => void cells.splice(index, 1),
    },
  };
  const panel = {
    isDisposed: false,
    id: "nb",
    content: { model, scrollToItem: async () => undefined },
    context: { localPath: "Chat.ipynb", path: "Chat.ipynb" },
  };
  const notebooks = {
    openFor: () => panel,
    ensure: async () => panel,
    pathOf: () => "Chat.ipynb",
    rebind: () => undefined,
  };
  return { cells, notebooks };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the notebook sink", () => {
  it("records the code that ran under a cell edited while it was typed", async () => {
    const { cells, notebooks } = notebook();
    const sink = createNotebookSink(
      { shell: { activateById: () => undefined } } as never,
      { notebooks: notebooks as never, thread: "T1", title: "Chat" },
      "m",
    );
    sink.code("c1", "x = 1\ny = 2\nprint(x + y)");
    await tick();
    const typed = cells[0]!;
    // The user edits the cell before the typist's next write.
    (typed.sharedModel as { setSource(v: string): void }).setSource("mine = True");
    sink.output("c1", normalizeCodeOutput({ stdout: "3\n" }));
    await tick();
    expect(typed.source).toBe("mine = True");
    const record = typed.outputs.find(
      (o) =>
        (o as { metadata?: { climateclaw?: { codeAsRun?: boolean } } }).metadata?.climateclaw
          ?.codeAsRun,
    ) as { data: { "text/plain": string } } | undefined;
    expect(record?.data["text/plain"]).toBe("x = 1\ny = 2\nprint(x + y)");
  });
});
