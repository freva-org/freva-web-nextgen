/**
 * @vitest-environment jsdom
 */
// `display()` bundles in the console: markup only through the sanitising path, the plain text as
// the fallback, and the single-type registry exactly PNG and plain text.
import { describe, expect, it, vi } from "vitest";

import { ConsoleController } from "../../src/console/console-controller.js";
import type { ConsoleDisplayOutput } from "../../src/console/console-types.js";
import {
  registeredDisplayMimes,
  renderDisplay,
  renderMarkup,
} from "../../src/console/display-renderers.js";
import { FakeSurface, MockEngine } from "./console-controller.test.js";

function build(withMarkup: boolean) {
  const surface = new FakeSurface();
  const markup: ConsoleDisplayOutput[] = [];
  if (withMarkup) {
    (surface as FakeSurface & { appendMarkup: (o: ConsoleDisplayOutput) => boolean }).appendMarkup =
      (o) => {
        markup.push(o);
        return true;
      };
  }
  const controller = new ConsoleController(
    surface,
    {
      onStatus: vi.fn(),
      onSuggestion: vi.fn(),
      onCompletion: vi.fn(),
      onSearch: vi.fn(),
      onCommandChanged: vi.fn(),
    },
    { history: { persistence: "memory" } },
  );
  const engine = new MockEngine();
  controller.attach(engine);
  return { surface, engine, markup };
}

describe("console bundles", () => {
  it("draws HTML through appendMarkup with the plain text as the fallback", () => {
    const { engine, markup, surface } = build(true);
    engine.emitOutput({
      type: "display_data",
      executionId: "e1",
      data: { "text/plain": "   a\n0  1", "text/html": "<table></table>" },
      metadata: {},
    });
    expect(markup).toEqual([
      {
        mime: "text/html",
        encoding: "utf8",
        data: "<table></table>",
        fallback: "   a\n0  1",
        executionId: "e1",
      },
    ]);
    expect(surface.displays).toHaveLength(0);
  });

  it("falls back to text on a surface that cannot sanitise, and a PNG keeps its size", () => {
    const { engine, surface } = build(false);
    engine.emitOutput({
      type: "display_data",
      executionId: "e1",
      data: { "text/plain": "svg", "image/svg+xml": "<svg/>" },
      metadata: {},
    });
    engine.emitOutput({
      type: "execute_result",
      executionId: "e2",
      data: { "text/plain": "fig", "image/png": "iVBORw0KGgo=" },
      metadata: { "image/png": { width: 4, height: 3 } },
      executionCount: 1,
    });
    expect(surface.displays[0]).toMatchObject({ mime: "text/plain", data: "svg" });
    expect(surface.displays[1]).toMatchObject({
      mime: "image/png",
      metadata: { width: 4, height: 3 },
    });
  });

  it("keeps the single-type registry to PNG and plain text", () => {
    expect(registeredDisplayMimes()).toEqual(["image/png", "text/plain"]);
    const ctx = { document, track: () => undefined };
    expect(
      renderDisplay({ mime: "text/html", encoding: "utf8", data: "<b>x</b>" }, ctx),
    ).toBeNull();
    expect(renderMarkup({ mime: "text/plain", encoding: "utf8", data: "x" }, ctx)).toBeNull();
  });

  it("renderMarkup shows the plain text at once and the sanitised markup once loaded", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const node = renderMarkup(
      {
        mime: "text/html",
        encoding: "utf8",
        data: "<b id=x>bold</b><script>1</script>",
        fallback: "plain",
      },
      { document, track: () => undefined },
    );
    expect(node?.textContent).toBe("plain");
    host.append(node!);
    await vi.waitFor(() => expect(node?.querySelector("b")).not.toBeNull());
    expect(node?.querySelector("script")).toBeNull();
    expect(node?.querySelector("b")?.id).toMatch(/^fv.+-x$/);
  });
});
