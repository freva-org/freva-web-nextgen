// The chat UI's data, without a browser: initials, host label, conversations, context chips.
import type { IAttachment } from "@jupyter/chat";
import { Signal } from "@lumino/signaling";
import { describe, expect, it } from "vitest";

import {
  cellsAttachment,
  ContextFollower,
  InputRegistry,
  type AttachmentInput,
} from "../src/context.js";
import {
  ThreadPages,
  filterThreads,
  groupThreads,
  threadTime,
} from "../src/conversations-model.js";
import { newMessageOnly } from "../src/edit-mode.js";
import { chipTierFor, tierFor } from "../src/tiers.js";
import { avatarText, hostLabel, initials, shortName } from "../src/identity.js";

describe("identity", () => {
  it("makes two-letter initials from user names and e-mail addresses", () => {
    expect(initials("jdoe")).toBe("JD");
    expect(initials("Mo Hadizade")).toBe("MH");
    expect(initials("m.hadizade@example.org")).toBe("MH");
    expect(initials("k204221")).toBe("K2");
    // An avatar shows a person's initials, never an account id's letters and digits.
    expect(avatarText("", "k204221")).toBeNull();
    expect(avatarText("Kim Schmidt", "k204221")).toBe("KS");
    expect(avatarText(null, "jdoe")).toBe("JD");
    expect(shortName("Kim Schmidt", "k204221")).toBe("Kim");
    expect(shortName("", "k204221")).toBe("k204221");
    expect(initials("")).toBe("?");
    expect(initials(null)).toBe("?");
  });
  it("labels the host shortly, unless the operator names it", () => {
    expect(hostLabel("https://nextgems.dkrz.de")).toBe("DKRZ");
    expect(hostLabel("https://freva.example.org")).toBe("freva.example.org");
    expect(hostLabel("http://127.0.0.1:8090")).toBe("127.0.0.1");
    expect(hostLabel("http://localhost:8090")).toBe("localhost");
    expect(hostLabel("https://freva.example.org", "Levante")).toBe("Levante");
    expect(hostLabel("")).toBe("");
  });
});

describe("widths", () => {
  it("gives the composer full labels, short labels, or icons", () => {
    expect([520, 430, 429, 300, 299, 180].map(tierFor)).toEqual([
      "wide",
      "wide",
      "medium",
      "medium",
      "narrow",
      "narrow",
    ]);
  });
  it("shrinks the model chip with the header, never in the overflow popup", () => {
    expect(chipTierFor(600, false)).toBe("full");
    expect(chipTierFor(400, false)).toBe("model");
    expect(chipTierFor(250, false)).toBe("logo");
    expect(chipTierFor(120, true)).toBe("full");
  });
});

describe("conversations", () => {
  const now = new Date(2026, 9, 4, 12, 0);
  const at = (d: Date) => d.toISOString();
  const threads = [
    {
      threadId: "a",
      topic: "Temperature anomalies in Germany",
      date: at(new Date(2026, 9, 4, 8, 42)),
    },
    {
      threadId: "b",
      topic: "Find CMIP6 precipitation data",
      date: at(new Date(2026, 9, 4, 7, 16)),
    },
    { threadId: "c", topic: "ENSO analysis", date: at(new Date(2026, 9, 3, 18, 0)) },
    { threadId: "d", topic: "Compare MPI-ESM runs", date: at(new Date(2024, 8, 30, 9, 0)) },
    { threadId: "e", topic: "Undated", date: "" },
  ];

  it("groups by day: Today, Yesterday, Earlier (undated last)", () => {
    expect(
      groupThreads(threads, now).map((g) => [g.label, g.threads.map((t) => t.threadId)]),
    ).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["Earlier", ["d", "e"]],
    ]);
  });

  it("shows today's and yesterday's time, else the date", () => {
    expect(threadTime(threads[0]!.date, now, "en-GB")).toBe("Today, 08:42");
    expect(threadTime(threads[2]!.date, now, "en-GB")).toBe("Yesterday, 18:00");
    expect(threadTime(threads[3]!.date, now, "en-GB")).toBe("30 Sept 2024");
    expect(threadTime("not a date", now)).toBe("not a date");
  });

  it("searches every word of the query in the topic, in any case", () => {
    expect(filterThreads(threads, "cmip6 DATA").map((t) => t.threadId)).toEqual(["b"]);
    expect(filterThreads(threads, "  ").length).toBe(threads.length);
    expect(filterThreads(threads, "germany precipitation")).toEqual([]);
  });

  it("loads page after page, without duplicates when the list shifts", async () => {
    const pages = [threads.slice(0, 2), threads.slice(1, 4), []];
    const calls: number[] = [];
    const list = new ThreadPages(async (page) => {
      calls.push(page);
      return { threads: pages[page] ?? [], total: 4 };
    }, 2);
    expect(list.hasMore).toBe(false);
    await list.reload();
    expect(list.hasMore).toBe(true);
    await list.more();
    expect(list.threads.map((t) => t.threadId)).toEqual(["a", "b", "c", "d"]);
    expect(list.hasMore).toBe(false);
    // Reloading keeps as many pages as were shown.
    await list.reload();
    expect(calls).toEqual([0, 1, 0, 1]);
    expect(list.threads.map((t) => t.threadId)).toEqual(["a", "b", "c", "d"]);
    list.clear();
    expect([list.loaded, list.threads.length, list.hasMore]).toEqual([false, 0, false]);
  });
});

/** @jupyter/chat's input model, as far as attachments go: sending clears text, then chips. */
class FakeInput implements AttachmentInput {
  attachments: IAttachment[] = [];
  value = "draft";
  readonly attachmentsChanged = new Signal<this, IAttachment[]>(this);
  readonly valueChanged = new Signal<this, string>(this);
  addAttachment(a: IAttachment) {
    if (this.attachments.some((b) => JSON.stringify(a) === JSON.stringify(b))) return;
    if (a.type === "notebook" && a.cells) {
      const i = this.attachments.findIndex((b) => b.type === "notebook" && b.value === a.value);
      if (i !== -1) {
        const existing = this.attachments[i] as typeof a;
        const cells = a.cells.filter((c) => !existing.cells?.some((d) => d.id === c.id));
        if (!cells.length) return;
        this.attachments[i] = { ...existing, cells: [...(existing.cells ?? []), ...cells] };
        this.attachmentsChanged.emit([...this.attachments]);
        return;
      }
    }
    this.attachments.push(a);
    this.attachmentsChanged.emit([...this.attachments]);
  }
  removeAttachment(a: IAttachment) {
    const i = this.attachments.findIndex((b) => JSON.stringify(a) === JSON.stringify(b));
    if (i === -1) return;
    this.attachments.splice(i, 1);
    this.attachmentsChanged.emit([...this.attachments]);
  }
  send() {
    this.value = "";
    this.valueChanged.emit("");
    this.attachments = [];
    this.attachmentsChanged.emit([]);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ContextFollower", () => {
  const cell = (id: string) => cellsAttachment("Untitled6.ipynb", [{ id, type: "code" }]);

  it("keeps the active cell attached, moves with it, and comes back after each send", async () => {
    const input = new FakeInput();
    let active = cell("c1");
    const follower = new ContextFollower(input, () => active);
    follower.start();
    expect(input.attachments).toEqual([cell("c1")]);
    active = cell("c2");
    follower.refresh();
    expect(input.attachments).toEqual([cell("c2")]);
    input.send();
    await tick();
    expect(follower.following).toBe(true);
    expect(input.attachments).toEqual([cell("c2")]);
  });

  it("stops following when the user removes the chip", async () => {
    const input = new FakeInput();
    let changes = 0;
    const follower = new ContextFollower(
      input,
      () => cell("c1"),
      () => (changes += 1),
    );
    follower.start();
    input.removeAttachment(cell("c1"));
    await tick();
    expect(follower.following).toBe(false);
    expect(input.attachments).toEqual([]);
    expect(changes).toBe(2);
  });

  it("leaves cells the user attached to the same notebook in place when it moves", () => {
    const input = new FakeInput();
    let active = cell("c1");
    const follower = new ContextFollower(input, () => active);
    input.addAttachment(cell("u1"));
    follower.start();
    expect(input.attachments).toEqual([
      cellsAttachment("Untitled6.ipynb", [
        { id: "u1", type: "code" },
        { id: "c1", type: "code" },
      ]),
    ]);
    active = cell("c2");
    follower.refresh();
    expect(follower.following).toBe(true);
    expect(input.attachments).toEqual([
      cellsAttachment("Untitled6.ipynb", [
        { id: "u1", type: "code" },
        { id: "c2", type: "code" },
      ]),
    ]);
    follower.stop();
    expect(input.attachments).toEqual([cell("u1")]);
  });

  it("never removes cells the user attached: following one of them contributes nothing", () => {
    const input = new FakeInput();
    // The user attaches A and B; then follows the active cell, A; moves to B; stops.
    input.addAttachment(cell("A"));
    input.addAttachment(cell("B"));
    let active = cell("A");
    const follower = new ContextFollower(input, () => active);
    follower.start();
    active = cell("B");
    follower.refresh();
    follower.stop();
    expect(input.attachments).toEqual([
      cellsAttachment("Untitled6.ipynb", [
        { id: "A", type: "code" },
        { id: "B", type: "code" },
      ]),
    ]);
  });

  it("removes what following added, and only that", () => {
    const input = new FakeInput();
    input.addAttachment(cell("A"));
    let active = cell("C");
    const follower = new ContextFollower(input, () => active);
    follower.start();
    active = cell("D");
    follower.refresh();
    expect(input.attachments).toEqual([
      cellsAttachment("Untitled6.ipynb", [
        { id: "A", type: "code" },
        { id: "D", type: "code" },
      ]),
    ]);
    follower.stop();
    expect(input.attachments).toEqual([cell("A")]);
  });

  it("attaches cells, not the raw notebook file", () => {
    expect(cellsAttachment("a/b.ipynb", [{ id: "x", type: "markdown" }])).toEqual({
      type: "notebook",
      value: "a/b.ipynb",
      cells: [{ id: "x", input_type: "markdown" }],
    });
  });
});

describe("InputRegistry", () => {
  it("names each input once, finds it by that name, and forgets it", () => {
    const inputs = new InputRegistry<object>();
    const main = {};
    const edit = {};
    const a = inputs.idOf(main);
    expect(inputs.idOf(main)).toBe(a);
    expect(inputs.idOf(edit)).not.toBe(a);
    expect(inputs.get(a)).toBe(main);
    expect(inputs.get(undefined)).toBeNull();
    expect(inputs.get("input-99")).toBeNull();
    inputs.forget(main);
    expect(inputs.get(a)).toBeNull();
  });
});

describe("the composer under a message being edited", () => {
  it("draws nothing there, and the control under the next message", () => {
    const Control = (props: { edit?: boolean; label: string }) => props.label;
    const Only = newMessageOnly(Control);
    expect(Only({ edit: true, label: "Add context" })).toBeNull();
    const drawn = Only({ edit: false, label: "Add context" }) as { type: unknown; props: unknown };
    expect(drawn.type).toBe(Control);
    expect(drawn.props).toEqual({ edit: false, label: "Add context" });
    expect((Only({ label: "x" }) as { type: unknown }).type).toBe(Control);
  });
});
