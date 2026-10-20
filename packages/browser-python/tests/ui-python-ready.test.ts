// Two trees on one page register the same recipe ids, each with a binder of its own. A press is
// bound by the binder of the tree it came from, not by whichever tree registered last.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExampleBinder, ExampleSource, TryPythonRequest } from "../src/ui/python-bridge.js";

const seen: { binders?: ReadonlyMap<string, ExampleBinder> } = {};

vi.mock("../src/ui/python-playground.js", () => ({
  createPythonPlayground: (
    _config: unknown,
    sources: ReadonlyMap<string, ExampleSource>,
    _chunks: unknown,
    binders: ReadonlyMap<string, ExampleBinder>,
  ) => {
    seen.binders = binders;
    return {
      run: (request: TryPythonRequest) => {
        const bind = binders.get(request.exampleId)!;
        return Promise.resolve(void (seen as Record<string, unknown>).last).then(() => {
          (seen as Record<string, unknown>).last = bind(request, sources.get(request.exampleId)!);
        });
      },
    };
  },
}));

const { registerPythonBlock, resetPythonBridge, tryPython } =
  await import("../src/ui/python-bridge.js");
const { preparePythonPlayground } = await import("../src/ui/python-ready.js");

const config = { examples: [], autostart: "never" } as never;
const host = {} as HTMLElement;
const template: ExampleSource = { title: "Open", source: "open({store})" };
const tree = (dataset: string) =>
  registerPythonBlock({
    host,
    config,
    sources: new Map([["recipe:http", template]]),
    bind: (request, example) => ({
      ...example,
      source: request.datasetId ?? "",
      notebookDataset: dataset,
    }),
  });

afterEach(() => resetPythonBridge());

describe("the playground's binders, with two trees on a page", () => {
  it("binds a press with the binder of the tree that was pressed", async () => {
    const first = tree("first");
    const second = tree("second");
    preparePythonPlayground({} as never);
    const last = () => (seen as { last?: ExampleSource }).last;

    await first.tryPython({
      exampleId: "recipe:http",
      digest: "0".repeat(64),
      datasetId: "s3://a/x",
    });
    expect(last()?.notebookDataset).toBe("first");
    await second.tryPython({
      exampleId: "recipe:http",
      digest: "0".repeat(64),
      datasetId: "s3://b/y",
    });
    expect(last()?.notebookDataset).toBe("second");
    // A press that names no tree (the plain `tryPython`) keeps the single-tree behaviour.
    await tryPython({ exampleId: "recipe:http", digest: "0".repeat(64), datasetId: "s3://a/x" });
    expect(last()?.notebookDataset).toBe("second");
  });
});
