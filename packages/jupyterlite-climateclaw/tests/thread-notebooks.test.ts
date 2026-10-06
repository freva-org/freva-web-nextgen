// @vitest-environment jsdom
// One notebook per thread: never made over an existing file (a failed read is not "free"), never
// the same file for two threads (two tabs included), still the thread's after a fork - open or
// closed, saved or not - without ever rewriting a closed file, and found again after the user
// renamed it.
import { Signal } from "@lumino/signaling";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadNotebooks } from "../src/thread-notebooks.js";
import { FakeContents, sharedLock } from "./fake-contents.js";

const KEY = "climateclaw:thread-notebooks";

type Panel = {
  isDisposed: boolean;
  context: { ready: Promise<void>; path: string; pathChanged: Signal<object, string> };
  model: { metadata: Record<string, unknown>; setMetadata(key: string, value: unknown): void };
  disposed: Signal<object, void>;
};

/** A tab: its notebooks over a contents store, opening a notebook reads its file. */
function tab(contents: FakeContents, lock = sharedLock()) {
  const opened: string[] = [];
  const panels: Array<{ path: string; metadata: Record<string, unknown>; panel: Panel }> = [];
  const widgetAdded = new Signal<object, Panel>({});
  const app = {
    serviceManager: {
      contents,
      kernelspecs: { specs: { default: "python", kernelspecs: {} } },
    },
    commands: {
      execute: async (_: string, args: { path: string }) => {
        opened.push(args.path);
        const file = contents.files.get(args.path)!;
        const metadata = structuredClone(
          (file.content as { metadata: Record<string, unknown> }).metadata,
        );
        const panel: Panel = {
          isDisposed: false,
          context: { ready: Promise.resolve(), path: args.path, pathChanged: new Signal({}) },
          model: {
            metadata,
            setMetadata: (key: string, value: unknown) => void (metadata[key] = value),
          },
          disposed: new Signal({}),
        };
        panels.push({ path: args.path, metadata, panel });
        widgetAdded.emit(panel);
        await panel.context.ready;
        return panel;
      },
    },
  };
  // Closed again once opened (nothing stays open), unless a test says otherwise.
  const tracker = { find: () => undefined, forEach: () => undefined, widgetAdded };
  const notebooks = new ThreadNotebooks(app as never, tracker as never, lock);
  return { notebooks, opened, panels, app };
}

const notebookFor = (thread: string) => ({
  type: "notebook",
  content: { cells: [{ source: "mine" }], metadata: { climateclaw_chat: { thread } } },
});

describe("thread notebooks", () => {
  beforeEach(() => window.localStorage.clear());

  it("never makes a notebook over a file it could not look up (503 is not 'free')", async () => {
    const contents = new FakeContents();
    contents.files.set("ClimateClaw.ipynb", notebookFor("someone"));
    contents.failing.set("ClimateClaw.ipynb", 503);
    const { notebooks } = tab(contents);
    await expect(notebooks.ensure("T1", "ClimateClaw")).rejects.toThrow("503");
    expect(contents.save).not.toHaveBeenCalled();
    expect(contents.files.get("ClimateClaw.ipynb")!.content).toMatchObject({
      cells: [{ source: "mine" }],
    });
  });

  it("keeps a binding it could not check, and makes nothing in its place", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ T1: { path: "A.ipynb", given: "A.ipynb" } }));
    const contents = new FakeContents();
    contents.files.set("A.ipynb", notebookFor("T1"));
    contents.failing.set("A.ipynb", 503);
    const { notebooks } = tab(contents);
    await expect(notebooks.ensure("T1", "A")).rejects.toThrow("503");
    expect(contents.save).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(KEY)!).T1.path).toBe("A.ipynb");
  });

  it("gives two threads of the same title two files, also from two tabs", async () => {
    const contents = new FakeContents();
    contents.files.set("Same.ipynb", notebookFor("older"));
    const lock = sharedLock();
    const one = tab(contents, lock);
    const two = tab(contents, lock);
    await Promise.all([one.notebooks.ensure("T1", "Same"), two.notebooks.ensure("T2", "Same")]);
    expect(one.opened[0]).not.toBe(two.opened[0]);
    expect([one.opened[0], two.opened[0]].sort()).toEqual(["Same 2.ipynb", "Same 3.ipynb"]);
    // The file that was there is untouched; each new one names its own thread.
    expect(contents.files.get("Same.ipynb")).toEqual(notebookFor("older"));
    for (const [path, thread] of [
      [one.opened[0]!, "T1"],
      [two.opened[0]!, "T2"],
    ]) {
      expect(contents.files.get(path)!.content).toMatchObject({
        metadata: { climateclaw_chat: { thread } },
      });
    }
  });

  it("without a shared lock, picks names no other tab can pick", async () => {
    const contents = new FakeContents();
    const a = tab(contents, null as never);
    const b = tab(contents, null as never);
    await Promise.all([a.notebooks.ensure("T1", "Same"), b.notebooks.ensure("T2", "Same")]);
    expect(a.opened[0]).toMatch(/^Same \w{6}\.ipynb$/);
    expect(a.opened[0]).not.toBe(b.opened[0]);
  });

  it("after a fork, a closed notebook stays the thread's, its file never rewritten", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ T1: { path: "C.ipynb", given: "C.ipynb" } }));
    const contents = new FakeContents();
    contents.files.set("C.ipynb", notebookFor("T1"));
    const { notebooks } = tab(contents);
    notebooks.rebind("T1", "T2");
    // The user reopens it elsewhere and saves edits: nothing of ours writes over them.
    contents.files.set("C.ipynb", {
      type: "notebook",
      content: { cells: [{ source: "edited" }], metadata: { climateclaw_chat: { thread: "T1" } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(contents.save).not.toHaveBeenCalled();
    expect(contents.files.get("C.ipynb")!.content).toMatchObject({ cells: [{ source: "edited" }] });
    // Another tab (the index from storage) reopens it, and so does the earlier id: bound to the
    // new thread in the open document.
    const other = tab(contents);
    expect(await other.notebooks.reopen("T2")).not.toBeNull();
    expect(other.panels[0]!.metadata.climateclaw_chat).toEqual({ thread: "T2" });
    expect(await other.notebooks.reopen("T1")).not.toBeNull();
    expect(contents.files.size).toBe(1);
  });

  it("a notebook the user opens after a fork is bound in its document", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ T1: { path: "C.ipynb", given: "C.ipynb" } }));
    const contents = new FakeContents();
    contents.files.set("C.ipynb", notebookFor("T1"));
    const { notebooks, panels, app } = tab(contents);
    notebooks.rebind("T1", "T2");
    // Opened from the file browser, not by ClimateClaw.
    await app.commands.execute("docmanager:open", { path: "C.ipynb" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panels[0]!.metadata.climateclaw_chat).toEqual({ thread: "T2" });
    expect(contents.save).not.toHaveBeenCalled();
  });

  it("a notebook the user renamed is the one reopened after it was closed", async () => {
    const contents = new FakeContents();
    const { notebooks, panels, opened } = tab(contents);
    await notebooks.ensure("T1", "Name");
    expect(opened).toEqual(["Name.ipynb"]);
    // Renamed while open (its document follows), then closed.
    const { panel } = panels[0]!;
    await contents.rename("Name.ipynb", "Mine.ipynb");
    panel.context.path = "Mine.ipynb";
    panel.context.pathChanged.emit("Mine.ipynb");
    await notebooks.ensure("T1", "Name");
    expect(opened).toEqual(["Name.ipynb", "Mine.ipynb"]);
    expect([...contents.files.keys()]).toEqual(["Mine.ipynb"]);
    // ... and the chat's own renames leave the user's name alone.
    await notebooks.rename("T1", "Other");
    expect([...contents.files.keys()]).toEqual(["Mine.ipynb"]);
  });

  it("two tabs already open: one notebook for a chat, whichever tab asks first", async () => {
    const contents = new FakeContents();
    const lock = sharedLock();
    // Both tabs exist before either writes the index.
    const one = tab(contents, lock);
    const two = tab(contents, lock);
    await one.notebooks.ensure("T1", "Chat");
    await two.notebooks.ensure("T1", "Chat");
    expect(two.opened).toEqual(["Chat.ipynb"]);
    // At the same moment too: the second finds the first's under the lock.
    await Promise.all([one.notebooks.ensure("T2", "Other"), two.notebooks.ensure("T2", "Other")]);
    expect([...contents.files.keys()].sort()).toEqual(["Chat.ipynb", "Other.ipynb"]);
  });

  it("two tabs' bindings for different chats both stay", async () => {
    const contents = new FakeContents();
    const lock = sharedLock();
    const one = tab(contents, lock);
    const two = tab(contents, lock);
    await one.notebooks.ensure("T1", "One");
    await two.notebooks.ensure("T2", "Two");
    await one.notebooks.rename("T1", "One renamed");
    const index = JSON.parse(window.localStorage.getItem(KEY)!);
    expect(index.T1.path).toBe("One renamed.ipynb");
    expect(index.T2.path).toBe("Two.ipynb");
    // A reload finds each chat's own notebook.
    const reloaded = tab(contents, lock);
    expect(reloaded.notebooks.pathOf("T1")).toBe("One renamed.ipynb");
    expect(reloaded.notebooks.pathOf("T2")).toBe("Two.ipynb");
  });

  it("two quick renames: the notebook takes the last name", async () => {
    const contents = new FakeContents();
    const { notebooks } = tab(contents);
    await notebooks.ensure("T1", "First");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await Promise.all([notebooks.rename("T1", "Second"), notebooks.rename("T1", "Third")]);
    expect([...contents.files.keys()]).toEqual(["Third.ipynb"]);
    expect(notebooks.pathOf("T1")).toBe("Third.ipynb");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a notebook closed without saving after a fork still reopens, bound to the new thread", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ T1: { path: "C.ipynb", given: "C.ipynb" } }));
    const contents = new FakeContents();
    contents.files.set("C.ipynb", notebookFor("T1"));
    // The file could not be updated: only the index knows.
    contents.save.mockRejectedValueOnce(new Error("offline"));
    const { notebooks, panels } = tab(contents);
    notebooks.rebind("T1", "T2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await notebooks.reopen("T2")).not.toBeNull();
    expect(panels[0]!.metadata.climateclaw_chat).toEqual({ thread: "T2" });
  });

  it("never opens or rewrites a notebook another thread owns", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ T1: { path: "C.ipynb", given: "C.ipynb" } }));
    const contents = new FakeContents();
    contents.files.set("C.ipynb", notebookFor("someone-else"));
    const { notebooks } = tab(contents);
    notebooks.rebind("T1", "T2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await notebooks.reopen("T2")).toBeNull();
    expect(contents.save).not.toHaveBeenCalled();
  });
});
