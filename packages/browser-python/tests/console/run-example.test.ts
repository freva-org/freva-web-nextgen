/**
 * Registered examples, and the transcript a host can read back.
 *
 * The behaviour under test is a promise made to a portal: pressing "Try in Python" appends a
 * labelled block to the session the visitor already has, runs it ONCE as a file, and changes
 * nothing else - not the namespace, not the history, not the half-typed line at the prompt.
 */
import { describe, expect, it, vi } from "vitest";
import { ConsoleController } from "../../src/console/console-controller.js";
import { FakeSurface, MockEngine } from "./console-controller.test.js";

function build(options: ConstructorParameters<typeof ConsoleController>[2] = {}) {
  const surface = new FakeSurface();
  const controller = new ConsoleController(
    surface,
    {
      onStatus: vi.fn(),
      onSuggestion: vi.fn(),
      onCompletion: vi.fn(),
      onSearch: vi.fn(),
      onCommandChanged: vi.fn(),
    },
    { history: { persistence: "memory" }, ...options },
  );
  const engine = new MockEngine();
  controller.attach(engine);
  return { surface, controller, engine };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const frame = () => new Promise((r) => setTimeout(r, 40));

const OPEN = 'import xarray as xr\n\nds = xr.open_zarr("s3://archive/tas.zarr")\nprint(ds)\n';

describe("runExample", () => {
  it("runs the whole source ONCE, as a file", async () => {
    const { controller, engine } = build();
    await controller.runExample({ title: "Open the store", source: OPEN });
    // One call, the source byte for byte - not four lines, not a `push` per statement.
    expect(engine.runs).toEqual([OPEN]);
  });

  it("uses file semantics for a ONE-LINE example too", async () => {
    // This is the difference between `runExample` and `execute`. A pasted single line is
    // indistinguishable from a typed one and keeps the REPL's value echo; a registered example is
    // a program, and a one-liner has to behave like the twenty-liner beside it.
    const { controller, engine } = build();
    await controller.runExample({ title: "One line", source: "print(1 + 1)" });
    expect(engine.runs).toEqual(["print(1 + 1)"]);
    expect(engine.pushes).toEqual(["print(1 + 1)"]);

    // …and `execute()` deliberately does not: a single pasted line keeps the REPL's value echo.
    await controller.execute("print(1 + 1)");
    expect(engine.runs).toEqual(["print(1 + 1)"]);
  });

  // A BLANK SEPARATOR, AND NOT A TITLE. A `── Open the store ──` line above the source reads
  // well and is not Python, and a transcript is something visitors COPY, so pasting a worked
  // example back would fail on a line the console wrote into their program. The title is
  // already on the page. Something must still separate one run from the next.
  it("separates the run with a blank line carrying no prose, then echoes the source", async () => {
    const { controller, surface } = build();
    await controller.runExample({ title: "Open the store", source: "a = 1\nb = 2\n" });
    const rendered = surface.text.map((entry) => entry.text);
    expect(surface.text[0].kind).toBe("status");
    expect(rendered[0]).toBe("\n");
    expect(rendered[0]).not.toContain("Open the store");
    // Then the source, echoed the way it reads back into a prompt.
    expect(rendered.slice(1, 4)).toEqual(["a = 1", "b = 2", ""]);
    expect(surface.text[1].prompt).toBe(">>> ");
    expect(surface.text[2].prompt).toBe("... ");
  });

  // And the whole transcript of a run is valid Python, which is the property a title breaks.
  // Everything the CONSOLE says rather than Python is recorded as a comment; everything else is a
  // prompt, a program's output or a traceback.
  it("...so the transcript of a run can be pasted back into Python", async () => {
    const { controller } = build();
    await controller.runExample({ title: "Open the store", source: "a = 1\nb = 2\n" });
    for (const line of controller.transcript().split("\n")) {
      const bare = line.replace(/^(?:>>> |\.\.\. )/, "");
      if (bare.trim() === "" || bare.startsWith("#")) continue;
      expect(() => new Function(`// ${bare}`)).not.toThrow();
    }
    expect(controller.transcript()).not.toMatch(/──/);
  });

  it("normalises CRLF and nothing else", async () => {
    const { controller, engine } = build();
    await controller.runExample({ title: "t", source: "if True:\r\n\r\n    pass\r\n" });
    // Blank lines and indentation are syntax; only the carriage returns go.
    expect(engine.runs).toEqual(["if True:\n\n    pass\n"]);
  });

  it("leaves a half-typed command exactly where it was", async () => {
    const { controller, surface } = build();
    surface.setCommand("total = sum(");
    surface.setCursor(5);
    await controller.runExample({ title: "t", source: "a = 1\nb = 2\n" });
    expect(surface.getCommand()).toBe("total = sum(");
    expect(surface.clears).toBe(0);
  });

  it("appends to the transcript rather than replacing it", async () => {
    const { controller, surface } = build();
    await controller.submit("x = 1");
    const before = surface.text.length;
    await controller.runExample({ title: "t", source: "a = 1\nb = 2\n" });
    expect(surface.clears).toBe(0);
    expect(surface.text.length).toBeGreaterThan(before);
    expect(surface.text[0].text).toBe("x = 1");
  });

  it("queues behind a running block, in the order the presses arrived", async () => {
    const { controller, engine } = build();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realRun = engine.run.bind(engine);
    let first = true;
    engine.run = async (code: string) => {
      if (first) {
        first = false;
        await gate;
      }
      return realRun(code);
    };

    const one = controller.runExample({ title: "first", source: "a = 1\nb = 2\n" });
    await settle();
    const two = controller.runExample({ title: "second", source: "c = 3\nd = 4\n" });
    const three = controller.runExample({ title: "third", source: "e = 5\nf = 6\n" });
    await settle();
    (release as unknown as () => void)();
    await Promise.all([one, two, three]);

    expect(engine.runs).toEqual(["a = 1\nb = 2\n", "c = 3\nd = 4\n", "e = 5\nf = 6\n"]);
  });

  it("holds an example that arrives before the interpreter is ready, and runs it after", async () => {
    const { controller, engine } = build();
    engine.emitStatus("loading");
    // NOT awaited here: the promise settles when the queue drains, which is after `ready`.
    const pending = controller.runExample({ title: "t", source: "a = 1\nb = 2\n" });
    await settle();
    expect(engine.runs).toEqual([]);
    engine.emitStatus("ready");
    await pending;
    expect(engine.runs).toEqual(["a = 1\nb = 2\n"]);
  });

  it("records ONE history entry for the whole example", async () => {
    const { controller, engine } = build();
    await controller.runExample({ title: "t", source: OPEN });
    expect(engine.runs).toHaveLength(1);
    // ↑ recalls the program, not its last line.
    expect(controller.historyPrevious()).toBe(true);
  });
});

describe("transcript", () => {
  it("reads back what was rendered, as plain text", async () => {
    const { controller, engine } = build();
    await controller.submit("print('hi')");
    engine.emitOutput({ type: "stdout", text: "hi\n", executionId: "exec-1" });
    await frame();
    const text = controller.transcript();
    expect(text).toContain(">>> print('hi')");
    expect(text).toContain("hi\n");
  });

  it("carries no markup and no bytes - a rich display is a one-line note", async () => {
    const { controller, engine } = build();
    engine.emitOutput({
      type: "display",
      executionId: "exec-1",
      mime: "image/png",
      encoding: "base64",
      data: "iVBORw0KGgoAAAANSUhEUg",
    });
    await frame();
    const text = controller.transcript();
    expect(text).toContain("[image/png output]");
    expect(text).not.toContain("iVBORw0KGgo");
    expect(text).not.toContain("<");
  });

  it("is emptied by Clear, exactly as the visible transcript is", async () => {
    const { controller } = build();
    await controller.submit("x = 1");
    expect(controller.transcript()).not.toBe("");
    controller.clearOutput();
    expect(controller.transcript()).toBe("");
  });

  it("is bounded by the same limits the transcript is", async () => {
    const { controller, surface } = build({ output: { maxEntries: 3, maxCharacters: 1_000 } });
    for (let i = 0; i < 12; i += 1) await controller.submit(`x = ${i}`);
    expect(surface.text.length).toBeLessThanOrEqual(4);
    // The oldest are gone from both, and the newest survive in both.
    expect(controller.transcript()).not.toContain("x = 0");
    expect(controller.transcript()).toContain("x = 11");
  });
});
