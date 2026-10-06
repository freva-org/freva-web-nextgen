// @vitest-environment jsdom
// The Run at DKRZ button: DKRZ's logo, still at rest and turning while the cell runs.
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const g = globalThis as { DragEvent?: unknown; MouseEvent: typeof MouseEvent };
  g.DragEvent ??= class extends g.MouseEvent {};
  // Read by JupyterLab's UI components when they load.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as never;
});

const { CommandRegistry } = await import("@lumino/commands");
const { Signal } = await import("@lumino/signaling");
const { RunAtDkrzButton } = await import("../src/run-at-dkrz.js");
const { DKRZ_LOGO_DATA_URL } = await import("../src/dkrz-logo.js");

describe("the Run at DKRZ button", () => {
  it("shows DKRZ's still logo, its animation while the cell runs, and a mark for how it ended", () => {
    let state: "idle" | "busy" | "ok" | "failed" = "idle";
    const changed = new Signal<object, void>({});
    const button = new RunAtDkrzButton({
      commands: new CommandRegistry(),
      state: () => state,
      changed,
      run: "run",
      runWithNote: "note",
      stop: "stop",
      reset: "reset",
      about: "about",
      model: "model",
      models: () => [],
      runningLogo: "https://lab.example/static/dkrz-running.webp",
    });
    const logo = button.node.querySelector<HTMLImageElement>(".jp-ClimateClaw-runAt-logo")!;
    const mark = button.node.querySelector(".jp-ClimateClaw-runAt-mark")!;
    // A play sign in front: this runs the cell (hidden while it runs; the logo turns then).
    const play = button.node.querySelector<HTMLElement>(".jp-ClimateClaw-runAt-play")!;
    expect(play.querySelector("svg")).not.toBeNull();
    expect(play.hidden).toBe(false);
    expect(logo.getAttribute("src")).toBe(DKRZ_LOGO_DATA_URL);
    expect(mark.textContent).toBe("");
    state = "busy";
    changed.emit();
    expect(logo.getAttribute("src")).toBe("https://lab.example/static/dkrz-running.webp");
    expect(play.hidden).toBe(true);
    state = "ok";
    changed.emit();
    expect(logo.getAttribute("src")).toBe(DKRZ_LOGO_DATA_URL);
    expect(mark.textContent).toBe("✓");
    button.dispose();
  });

  it("keeps the logo still while the cell runs when the reader asked for less motion", () => {
    const matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      const button = new RunAtDkrzButton({
        commands: new CommandRegistry(),
        state: () => "busy",
        changed: new Signal<object, void>({}),
        run: "run",
        runWithNote: "note",
        stop: "stop",
        reset: "reset",
        about: "about",
        model: "model",
        models: () => [],
        runningLogo: "https://lab.example/static/dkrz-running.webp",
      });
      const logo = button.node.querySelector<HTMLImageElement>(".jp-ClimateClaw-runAt-logo")!;
      expect(logo.getAttribute("src")).toBe(DKRZ_LOGO_DATA_URL);
      expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
      button.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
