// @vitest-environment jsdom
// The Inspect tab: closed while it loads, nothing is attached or loaded; its 3D viewer only when
// allowed.
import { describe, expect, it, vi } from "vitest";

// jsdom has no DragEvent, which Lumino's widgets refer to when they load.
(globalThis as { DragEvent?: unknown }).DragEvent ??= class extends MouseEvent {};
const { InspectorContent } = await import("../src/inspector-content.js");

function fakeModule() {
  let finishLoad!: () => void;
  const controller = {
    load: vi.fn(() => new Promise<void>((resolve) => (finishLoad = resolve))),
    detach: vi.fn(),
  };
  const module = {
    attachInspector: vi.fn(() => controller),
    scopedBearerAuth: vi.fn(() => () => ({})),
  };
  return { module, controller, finish: () => finishLoad() };
}

describe("InspectorContent", () => {
  it("closed while the inspector module loads: nothing is attached, nothing loads", async () => {
    const { module, controller } = fakeModule();
    let resolveModule!: (m: unknown) => void;
    const content = new InspectorContent(
      "https://s3.example.org/data/t.zarr/",
      null,
      () => new Promise((resolve) => (resolveModule = resolve as never)),
    );
    const started = content.start(() => undefined);
    content.dispose();
    resolveModule(module);
    await started;
    expect(module.attachInspector).not.toHaveBeenCalled();
    expect(controller.load).not.toHaveBeenCalled();
    expect(content.node.querySelector("data-inspector")).toBeNull();
  });

  it("closed during the read: the read is cancelled and the dialog never opens", async () => {
    const fake = fakeModule();
    const content = new InspectorContent(
      "https://s3.example.org/data/t.zarr/",
      null,
      async () => fake.module as never,
    );
    const started = content.start(() => undefined);
    await vi.waitFor(() => expect(fake.controller.load).toHaveBeenCalledTimes(1));
    content.dispose();
    expect(fake.controller.detach).toHaveBeenCalledTimes(1);
    fake.finish();
    await started;
    const element = content.node.querySelector("data-inspector");
    expect(element?.hasAttribute("open") ?? false).toBe(false);
  });

  /**
   * A read that ends ready, as the inspector reports it through its public API: `activeView` is
   * the viewer when `view` asks for it and nothing disabled it.
   */
  function readyRead(blocked: string | null) {
    const module = {
      attachInspector: vi.fn((element: HTMLElement) => {
        Object.defineProperty(element, "activeView", {
          get: () =>
            element.getAttribute("view") === "viewer" &&
            !element.hasAttribute("viewer-disabled") &&
            !element.hasAttribute("viewer-off")
              ? "viewer"
              : "metadata",
        });
        return {
          load: vi.fn(async () => {
            // The pipeline clears the reason at each read, then decides.
            element.removeAttribute("viewer-disabled");
            if (blocked) element.setAttribute("viewer-disabled", blocked);
            element.setAttribute("status", "ready");
          }),
          detach: vi.fn(),
        };
      }),
      scopedBearerAuth: vi.fn(() => () => ({})),
    };
    const view = (content: { node: HTMLElement }) =>
      content.node.querySelector("data-inspector")!.getAttribute("view");
    return { module, view };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("keeps the 3D viewer disabled unless the site allows it", async () => {
    const { module, view } = readyRead(null);
    const content = new InspectorContent(
      "https://s3.example.org/t.zarr/",
      null,
      async () => module as never,
    );
    await content.start(() => undefined);
    await tick();
    const element = content.node.querySelector("data-inspector")!;
    // The inspector's host policy, which its reads never clear.
    expect(element.getAttribute("viewer-off")).toBe("The 3D viewer is not enabled on this site.");
    expect(content.showViewer()).toBe("The 3D viewer is not enabled on this site.");
    expect(view(content)).toBe("metadata");
  });

  it("allowed: leaves the decision to the inspector and opens its 3D viewer", async () => {
    const { module, view } = readyRead(null);
    const content = new InspectorContent(
      "https://s3.example.org/t.zarr/",
      null,
      async () => module as never,
      true,
    );
    await content.start(() => undefined);
    await tick();
    const element = content.node.querySelector("data-inspector")!;
    expect(element.hasAttribute("viewer-disabled") || element.hasAttribute("viewer-off")).toBe(
      false,
    );
    expect(content.showViewer()).toBeNull();
    expect(view(content)).toBe("viewer");
  });

  it("is embedded in its tab, and View on globe opens on the viewer from the start", async () => {
    const { module, view } = readyRead(null);
    const content = new InspectorContent(
      "https://s3.example.org/t.zarr/",
      null,
      async () => module as never,
      true,
      true,
    );
    const started = content.start(() => undefined);
    await vi.waitFor(() => expect(content.node.querySelector("data-inspector")).not.toBeNull());
    const element = content.node.querySelector("data-inspector")!;
    expect(element.hasAttribute("embedded")).toBe(true);
    expect(view(content)).toBe("viewer");
    await started;
    // Only attributes are used: nothing inside the inspector is reached into.
    expect(element.children).toHaveLength(0);
  });

  it("allowed, but a protected store: says the inspector's reason, opens nothing", async () => {
    const why = "The 3D viewer needs a share link for this protected store.";
    const { module, view } = readyRead(why);
    const content = new InspectorContent(
      "https://freva.example.org/t.zarr/",
      null,
      async () => module as never,
      true,
    );
    await content.start(() => undefined);
    expect(content.showViewer()).toBe(why);
    expect(view(content)).toBe("metadata");
  });
});
