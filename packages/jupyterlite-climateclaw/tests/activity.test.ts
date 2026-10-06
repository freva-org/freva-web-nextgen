// Code typed into its cell as it streams, what ClimateClaw is doing, and its name and face.
import { readFileSync } from "node:fs";

import { Signal } from "@lumino/signaling";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityStore, elapsed } from "../src/activity.js";
import { DKRZ_LOGO_DATA_URL } from "../src/dkrz-logo.js";
import { LOGO_DATA_URL } from "../src/logo.js";
import { cellPointer, chipCellId, chipText, outcomeChip } from "../src/notebook-sink.js";
import {
  CLIMATECLAW_PERSONA,
  PERSONA_USERNAME,
  doingText,
  presentAsClimateClaw,
} from "../src/persona.js";
import {
  VariantMapper,
  partialCodeFromArguments,
  type CodeOutput,
  type StreamEvent,
} from "../src/stream.js";
import { Typist } from "../src/typist.js";

describe("partial code", () => {
  it("decodes the code argument so far, escapes included, stopping before a cut escape", () => {
    expect(partialCodeFromArguments('{"co')).toBeNull();
    expect(partialCodeFromArguments('{"code": "import xarray as xr\\nds = xr.open')).toBe(
      "import xarray as xr\nds = xr.open",
    );
    expect(partialCodeFromArguments('{"code":"print(\\"h\\u00e9')).toBe('print("hé');
    expect(partialCodeFromArguments('{"code":"a\\')).toBe("a");
    expect(partialCodeFromArguments('{"code":"a\\u00')).toBe("a");
    expect(partialCodeFromArguments('{"code":"done", "x": 1')).toBe("done");
  });

  it("streams code to a notebook as partial events, then the whole code once", () => {
    const mapper = new VariantMapper({ codeToNotebook: true, hideCode: true });
    const events = ['{"code": "x = ', "1\\ny", ' = 2"}'].flatMap((chunk) =>
      mapper.map({ variant: "Code", content: chunk, id: "c1" }),
    );
    expect(events).toEqual([
      { type: "code-partial", id: "c1", code: "x = " },
      { type: "code-partial", id: "c1", code: "x = 1\ny" },
      { type: "code", id: "c1", code: "x = 1\ny = 2" },
    ]);
  });

  it("keeps code in the chat whole: no partial events without a notebook", () => {
    const mapper = new VariantMapper();
    const events = mapper.map({ variant: "Code", content: '{"code": "x = ', id: "c1" });
    expect(events).toEqual([]);
  });
});

describe("activity", () => {
  const phases = (events: StreamEvent[]) =>
    events.flatMap((e) => (e.type === "activity" ? [`${e.phase}:${e.label}`] : []));

  it("names each phase once, as the reply moves through them (only when asked)", () => {
    const lines = [
      { variant: "Assistant", content: "Let me look." },
      { variant: "Assistant", content: " More." },
      { variant: "Code", content: '{"code": "x', id: "c1" },
      { variant: "Code", content: ' = 1"}', id: "c1" },
      { variant: "ServerHint", content: '{"busy": true, "detail": "Running at DKRZ"}' },
      { variant: "CodeOutput", content: { stdout: "" }, id: "c1" },
      { variant: "ToolCall", tool_name: "search_data", id: "t1" },
      { variant: "Image", content: "iVBORw0KGgo=", id: "c1_0" },
      { variant: "StreamEnd", content: "" },
    ];
    const asked = new VariantMapper({ codeToNotebook: true, activity: true });
    expect(phases(lines.flatMap((l) => asked.map(l)))).toEqual([
      "writing:Writing",
      "coding:Writing code",
      "running:Running code at DKRZ",
      "thinking:Thinking",
      "tool:Using search data",
      "figure:Drawing a figure",
      "done:",
    ]);
    const quiet = new VariantMapper({ codeToNotebook: true });
    expect(phases(lines.flatMap((l) => quiet.map(l)))).toEqual([]);
  });

  it("keeps each thread's phase, its start, and the cells its reply wrote", () => {
    let now = 1_000;
    const store = new ActivityStore(() => now);
    const changed: string[] = [];
    store.changed.connect((_, thread) => changed.push(thread));
    store.addCell("t1", { notebook: "old.ipynb", number: 1, jump: () => undefined });
    store.start("t1");
    expect(store.cells("t1")).toEqual([]);
    now = 4_000;
    store.set("t1", "coding", "Writing code");
    store.set("t1", "coding", "Writing code");
    const jump = vi.fn();
    store.addCell("t1", { notebook: "a.ipynb", number: 3, jump });
    expect(store.activity("t1")).toEqual({
      phase: "coding",
      label: "Writing code",
      since: 4_000,
      started: 1_000,
    });
    expect(store.activity("t2")).toBeNull();
    store.set("t1", "done", "");
    expect(store.activity("t1")).toBeNull();
    store.cells("t1")[0]!.jump();
    expect(jump).toHaveBeenCalledTimes(1);
    expect(changed).toEqual(["t1", "t1", "t1", "t1", "t1"]);
  });

  it("shows elapsed time in seconds, then minutes", () => {
    expect([0, 999, 12_400, 60_000, 65_000, -5].map(elapsed)).toEqual([
      "0s",
      "0s",
      "12s",
      "1m 00s",
      "1m 05s",
      "0s",
    ]);
  });
});

describe("Typist", () => {
  afterEach(() => vi.useRealTimers());

  it("types a growing text out in steps, appending, and flushes at once", () => {
    vi.useFakeTimers();
    const writes: Array<[string, number | null]> = [];
    const typist = new Typist(20);
    typist.update("x".repeat(100));
    typist.attach((text, from) => writes.push([text, from]));
    vi.advanceTimersByTime(20);
    expect(writes).toEqual([["x".repeat(10), 0]]);
    vi.advanceTimersByTime(20);
    expect(typist.typed.length).toBe(19);
    typist.update("x".repeat(100) + "y", true);
    expect(typist.finished).toBe(false);
    typist.flush();
    expect(writes.at(-1)).toEqual(["x".repeat(100) + "y", 19]);
    expect(typist.finished).toBe(true);
    // Every write only appended to what was shown.
    for (const [text, from] of writes) {
      expect(from).not.toBeNull();
      expect(text.length).toBeGreaterThan(from!);
    }
  });

  it("never splits a surrogate pair, and starts over when the text is not a continuation", () => {
    vi.useFakeTimers();
    const writes: Array<[string, number | null]> = [];
    const typist = new Typist(10);
    typist.attach((text, from) => writes.push([text, from]));
    typist.update("ab🌍cd");
    vi.advanceTimersByTime(10);
    expect(writes[0]![0]).toBe("ab🌍");
    typist.update("zz");
    expect(writes.at(-1)).toEqual(["", null]);
    vi.advanceTimersByTime(10);
    expect(typist.typed).toBe("zz");
    typist.dispose();
  });
});

describe("ClimateClaw's name and face", () => {
  const jupyternaut = { username: PERSONA_USERNAME, display_name: "Jupyternaut", bot: true };

  /** The chat model's messages and writers, as far as the rename uses them. */
  function fakeChat() {
    const messagesUpdated = new Signal<unknown, void>({});
    const writersChanged = new Signal<unknown, unknown[]>({});
    const messages: Array<{
      id: string;
      sender: Record<string, unknown>;
      update: (u: object) => void;
    }> = [];
    const add = (id: string, sender: Record<string, unknown>) => {
      const message = {
        id,
        sender,
        update(u: object) {
          Object.assign(message, u);
        },
      };
      messages.push(message);
      messagesUpdated.emit();
      return message;
    };
    const writers: unknown[][] = [];
    const model = {
      messages,
      messagesUpdated,
      writersChanged,
      writers: [] as unknown[],
      updateWriters: (w: unknown[]) => {
        writers.push(w);
        model.writers = w;
        writersChanged.emit(w);
      },
    };
    return { model, add, writers, writersChanged };
  }

  it("renames the persona's replies in a ClimateClaw chat, once each, and its writer", async () => {
    let ours = true;
    const chat = fakeChat();
    const stop = presentAsClimateClaw(chat.model as never, () => ours);
    const user = chat.add("u1", { username: "me", display_name: "Me" });
    const reply = chat.add("r1", { ...jupyternaut });
    expect(reply.sender).toBe(CLIMATECLAW_PERSONA);
    expect(user.sender.display_name).toBe("Me");
    // An update resetting the sender is undone.
    reply.sender = { ...jupyternaut };
    chat.add("u2", { username: "me" });
    expect(reply.sender.display_name).toBe("ClimateClaw");
    // Renamed after the emission that brought the persona, so every listener ends on the name.
    const seen: unknown[] = [];
    chat.writersChanged.connect((_, w) => seen.push(w));
    chat.model.updateWriters([{ user: { ...jupyternaut } }, { user: { username: "me" } }]);
    await Promise.resolve();
    expect(chat.writers.at(-1)).toEqual([
      { user: CLIMATECLAW_PERSONA },
      { user: { username: "me" } },
    ]);
    expect(seen.at(-1)).toEqual(chat.writers.at(-1));
    expect(chat.writers.length).toBe(2);
    // Another provider's replies keep their persona, and earlier ones stay ClimateClaw's.
    ours = false;
    const other = chat.add("r2", { ...jupyternaut });
    expect(other.sender.display_name).toBe("Jupyternaut");
    expect(reply.sender.display_name).toBe("ClimateClaw");
    ours = true;
    chat.add("u3", { username: "me" });
    expect(other.sender.display_name).toBe("Jupyternaut");
    stop();
    const late = chat.add("r3", { ...jupyternaut });
    expect(late.sender.display_name).toBe("Jupyternaut");
  });

  it("its writer line says what it is doing, as that changes", async () => {
    const chat = fakeChat();
    const changed = new Signal<unknown, void>({});
    let phase: string | null = "thinking";
    const stop = presentAsClimateClaw(chat.model as never, () => true, {
      text: () => doingText(phase),
      changed,
    });
    chat.model.updateWriters([{ user: { ...jupyternaut } }]);
    await Promise.resolve();
    expect(chat.writers.at(-1)).toEqual([
      { user: CLIMATECLAW_PERSONA, typingIndicator: "is thinking…" },
    ]);
    phase = "running";
    changed.emit();
    await Promise.resolve();
    expect(chat.writers.at(-1)).toEqual([
      { user: CLIMATECLAW_PERSONA, typingIndicator: "is running code at DKRZ…" },
    ]);
    const count = chat.writers.length;
    changed.emit();
    await Promise.resolve();
    expect(chat.writers.length).toBe(count);
    expect(doingText("coding")).toBe("is writing code…");
    expect(doingText("tool", "Using web search")).toBe("is using web search…");
    stop();
  });

  it("has a logo: the transparent WebP, as a data URL", () => {
    const webp = readFileSync(new URL("../style/logo/climateclaw.webp", import.meta.url));
    expect(LOGO_DATA_URL).toBe(`data:image/webp;base64,${webp.toString("base64")}`);
    // DKRZ's still logo, likewise, is the shipped PNG's bytes.
    const png = readFileSync(new URL("../style/logo/dkrz.png", import.meta.url));
    expect(DKRZ_LOGO_DATA_URL).toBe(`data:image/png;base64,${png.toString("base64")}`);
    expect(webp.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(webp.subarray(8, 12).toString("latin1")).toBe("WEBP");
    expect(CLIMATECLAW_PERSONA.avatar_url).toBe(LOGO_DATA_URL);
  });
});

describe("the chat's chips for code that ran at DKRZ", () => {
  const output = (o: Partial<CodeOutput>): CodeOutput => ({
    outcome: "ok",
    stdout: "",
    stderr: "",
    result: "",
    error: "",
    display: [],
    files: [],
    ...o,
  });

  it("names where it ran, the cell and the notebook, as inline HTML on one line", () => {
    const chip = cellPointer(4, "work/my_run*1.ipynb", "gpt-test");
    expect(chip.startsWith('\n\n<span class="jp-ClimateClaw-ran"')).toBe(true);
    expect(chip.slice(2)).not.toContain("\n");
    expect(chip).toContain('<span class="jp-ClimateClaw-ran-at">DKRZ</span>');
    expect(chip).toContain('<span class="jp-ClimateClaw-ran-cell">Cell 4</span>');
    // The name is neither markup nor Markdown; the tooltip has the whole path and the model.
    expect(chip).toContain('<span class="jp-ClimateClaw-ran-nb">my&#95;run&#42;1.ipynb</span>');
    expect(chip).toMatch(/title="Ran at DKRZ by ClimateClaw \(gpt-test\)[^"]*work\/my&#95;run/);
    expect(cellPointer(null, null)).toContain("Chat notebook");
    expect(cellPointer(null, null)).not.toContain("ran-nb");
  });

  it("carries the cell's id in a class, which the chat's sanitiser keeps", () => {
    const chip = cellPointer(2, "a.ipynb", "", "0f3c-9a_b");
    expect(chip).toContain('class="jp-ClimateClaw-ran jp-ClimateClaw-cell-0f3c-9a_b"');
    expect(chipCellId(["jp-ClimateClaw-ran", "jp-ClimateClaw-cell-0f3c-9a_b"])).toBe("0f3c-9a_b");
    expect(chipCellId(["jp-ClimateClaw-ran"])).toBeNull();
    // Anything else is not put in the markup.
    expect(cellPointer(2, "a.ipynb", "", 'x" onclick="y')).toContain('class="jp-ClimateClaw-ran"');
  });

  it("says how the run ended: an error by its name, else that it ran and showed output", () => {
    const failed = outcomeChip(
      output({
        outcome: "error",
        error: "Traceback (most recent call last):\nZeroDivisionError: division by zero",
      }),
    );
    expect(failed).toContain("jp-mod-error");
    expect(failed).toContain("✗ ZeroDivisionError</span>");
    expect(failed).toContain('title="ZeroDivisionError: division by zero"');
    expect(outcomeChip(output({ stdout: "2.0\n" }))).toContain("✓ ran · output</span>");
    expect(outcomeChip(output({}))).toContain("✓ ran</span>");
    const unknown = outcomeChip(output({ outcome: "unknown", stdout: "x" }));
    expect(unknown).not.toContain("jp-mod-ok");
    expect(unknown).toContain(">ran · output</span>");
    expect(outcomeChip(output({ outcome: "error", error: "<b>bad</b>" }))).not.toContain("<b>");
  });

  it("escapes everything that could be markup or Markdown", () => {
    expect(chipText(`<a href="x">_*\`[]\\~&'`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#95;&#42;&#96;&#91;&#93;&#92;&#126;&amp;&#39;",
    );
  });
});

describe("DKRZ's running logo", () => {
  it("turns briskly: a short rest, then the turn at 20 frames a second or more", () => {
    const webp = readFileSync(new URL("../style/logo/dkrz-running.webp", import.meta.url));
    const durations: number[] = [];
    for (let i = 12; i < webp.length; ) {
      const size = webp.readUInt32LE(i + 4);
      if (webp.toString("latin1", i, i + 4) === "ANMF") durations.push(webp.readUIntLE(i + 20, 3));
      i += 8 + size + (size & 1);
    }
    expect(durations).toHaveLength(40);
    expect(durations.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2500);
    expect(Math.max(...durations.slice(1))).toBeLessThanOrEqual(60);
  });
});
