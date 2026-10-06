import { describe, expect, it } from "vitest";

import { acceptRelayMessage } from "../src/auth-relay.js";
import { exampleCommandName, readConfig } from "../src/config.js";
import { chatNameFor, threadToChat } from "../src/history.js";
import { reconcileModels, servedModel, startModelSync } from "../src/models.js";
import {
  RUN_AND_FIX_TEMPLATE,
  RunAndFixCollector,
  importedModules,
  installCellSource,
  missingFromError,
  moduleCheckCode,
  packageFor,
  parseModuleCheck,
  runVerdict,
  fixDiffers,
  lineDiff,
  normalizeCode,
  runAndFixInput,
} from "../src/runfix.js";
import { normalizeCodeOutput, VariantMapper } from "../src/stream.js";
import {
  ThreadTable,
  latestUserText,
  markedThread,
  stripMarkers,
  threadMarker,
  turnOf,
} from "../src/threads.js";
import { ExamplesCommandProvider } from "../src/examples.js";

const PAGE = "https://play.example.org/notebook/lab/index.html";

describe("config", () => {
  it("derives every URL from the host", () => {
    const c = readConfig(
      { host: "https://freva.example.org/" },
      PAGE,
      "../extensions/x/static/cb.html",
    );
    expect(c.host).toBe("https://freva.example.org");
    expect(c.authBaseUrl).toBe("https://freva.example.org/api/freva-nextgen/auth/v2");
    expect(c.apiBase).toBe("https://freva.example.org/api/chatbot");
    expect(c.callbackUrl).toBe("https://play.example.org/notebook/extensions/x/static/cb.html");
    // Saved figures come from the host unless another origin is named.
    expect(c.previewOrigin).toBe("https://freva.example.org");
    const other = readConfig(
      { host: "https://freva.example.org", previewOrigin: "https://web.example.org/static" },
      PAGE,
      "cb.html",
    );
    expect(other.previewOrigin).toBe("https://web.example.org");
  });
  it("resolves an origin-relative callback against this page's origin", () => {
    const c = readConfig(
      { host: "https://freva.example.org", callbackPath: "/auth/callback/" },
      "http://localhost:4322/notebook/lab/index.html",
      "cb.html",
    );
    expect(c.callbackUrl).toBe("http://localhost:4322/auth/callback/");
  });
  it("refuses a callback on another origin and non-http hosts", () => {
    const c = readConfig(
      { host: "javascript:alert(1)", callbackPath: "https://evil.example/cb.html" },
      PAGE,
      "cb.html",
    );
    expect(c.host).toBe("");
    expect(c.callbackUrl).toBe("");
  });
  it("defaults the Run & fix model to the default model and drops empty examples", () => {
    const c = readConfig(
      {
        defaultModel: "m1",
        examples: [
          { title: "A", prompt: "p" },
          { title: "", prompt: "q" },
        ],
      },
      PAGE,
      "cb.html",
    );
    expect(c.runAndFixModel).toBe("m1");
    expect(c.examples).toEqual([{ title: "A", prompt: "p" }]);
  });
  it("names slash commands uniquely", () => {
    const taken = new Set<string>();
    expect(exampleCommandName({ title: "Plot ERA5 temperature!", prompt: "" }, taken)).toBe(
      "plot-era5-temperature",
    );
    expect(exampleCommandName({ title: "Plot ERA5 temperature", prompt: "" }, taken)).toBe(
      "plot-era5-temperature-2",
    );
  });
});

describe("slash commands", () => {
  const provider = new ExamplesCommandProvider([
    { title: "Global mean", prompt: "Compute the global mean." },
    { title: "Plot map", prompt: "Plot a map." },
  ]);
  const input = (value: string, currentWord: string | null = value) =>
    ({ value, currentWord }) as never;

  it("offers one command per example, replacing the word with the prompt", async () => {
    expect(provider.names).toEqual(["/global-mean", "/plot-map"]);
    const list = await provider.listCommandCompletions(input("/pl"));
    expect(list).toEqual([
      expect.objectContaining({
        name: "/plot-map",
        replaceWith: "Plot a map.",
        description: "Plot map",
      }),
    ]);
    expect(await provider.listCommandCompletions(input("hello"))).toEqual([]);
  });
  it("expands a bare command on submit", async () => {
    const model = { value: " /global-mean " } as { value: string };
    await provider.onSubmit(model as never);
    expect(model.value).toBe("Compute the global mean.");
    const other = { value: "/global-mean please" };
    await provider.onSubmit(other as never);
    expect(other.value).toBe("/global-mean please");
  });
});

describe("threads", () => {
  it("reads the latest marker from assistant messages only", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: threadMarker("USER") }] },
      { role: "assistant", content: [{ type: "text", text: `${threadMarker("A")}\nx` }] },
      { role: "assistant", content: `${threadMarker("B")}` },
    ];
    expect(markedThread(prompt)).toBe("B");
    expect(stripMarkers(`${threadMarker("A")}\nhello`)).toBe("hello");
  });
  it("resets for a new or cleared chat", () => {
    const table = new ThreadTable();
    const one = [{ role: "user", content: "q" }];
    table.remember(one, "T");
    expect(table.resolve(one)).toBeNull();
    expect(table.resolve([...one, { role: "user", content: "next" }])).toBe("T");
  });
  it("takes the newest user message", () => {
    expect(
      latestUserText([
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: [{ type: "text", text: " c " }, { type: "file" }] },
      ]),
    ).toBe("c");
  });
});

describe("auth callback messages", () => {
  const cb = "https://play.example.org/auth/callback/";
  const attempt = "0123456789abcdef0123456789abcdef";
  const message = (url: string, extra: Record<string, unknown> = {}) => ({
    type: "freva-auth-callback",
    v: 1,
    attempt,
    purpose: "login",
    outcome: "response",
    url,
    ...extra,
  });
  it("accepts only our callback page's URL, for our attempt", () => {
    expect(acceptRelayMessage(message(`${cb}?code=1&state=2`), attempt, "login", cb)?.url).toBe(
      `${cb}?code=1&state=2`,
    );
    expect(
      acceptRelayMessage(
        message("https://evil.example/auth/callback/?code=1"),
        attempt,
        "login",
        cb,
      ),
    ).toBeNull();
    expect(
      acceptRelayMessage(message("https://play.example.org/other?code=1"), attempt, "login", cb),
    ).toBeNull();
    expect(acceptRelayMessage({ type: "other", url: cb }, attempt, "login", cb)).toBeNull();
    expect(acceptRelayMessage("string", attempt, "login", cb)).toBeNull();
    expect(
      acceptRelayMessage(
        message(`${cb}?code=1`, { attempt: "f".repeat(32) }),
        attempt,
        "login",
        cb,
      ),
    ).toBeNull();
    expect(acceptRelayMessage(message(`${cb}?code=1`), attempt, "logout", cb)).toBeNull();
    expect(
      acceptRelayMessage(message(`${cb}?code=${"x".repeat(9000)}`), attempt, "login", cb),
    ).toBeNull();
  });
});

describe("models", () => {
  const configured = [
    { id: "climateclaw", name: "ClimateClaw (Freva)", provider: "climateclaw", model: "m1" },
    { id: "other", name: "Other", provider: "openai", model: "x" },
  ];
  it("adds one entry per further model and keeps the default and other providers", () => {
    const next = reconcileModels(configured, ["m1", "m2"], "m1", "ClimateClaw (Freva)");
    expect(next?.map((p) => p.id)).toEqual(["other", "climateclaw", "climateclaw:m2"]);
    expect(reconcileModels(next!, ["m1", "m2"], "m1", "ClimateClaw (Freva)")).toBeNull();
  });
  it("moves the default entry to a served model when the configured one is not served", () => {
    const configured = [
      {
        id: "climateclaw",
        name: "ClimateClaw (Freva)",
        provider: "climateclaw",
        model: "gpt-test",
      },
    ];
    const next = reconcileModels(configured, ["gpt-4.1", "gemma4:31b"], "gpt-test", "x");
    expect(next?.map((p) => [p.id, p.model])).toEqual([
      ["climateclaw", "gpt-4.1"],
      ["climateclaw:gemma4:31b", "gemma4:31b"],
    ]);
    expect(reconcileModels(next!, ["gpt-4.1", "gemma4:31b"], "gpt-test", "x")).toBeNull();
    expect(servedModel("fast", ["a", "b"], "a")).toBe("a");
    expect(servedModel("b", ["a", "b"], "a")).toBe("b");
    expect(servedModel("fast", [], "a")).toBe("fast");
  });
  it("creates the default entry when none is configured", () => {
    expect(reconcileModels([], ["a", "b"], "", "ClimateClaw (Freva)")?.map((p) => p.id)).toEqual([
      "climateclaw",
      "climateclaw:b",
    ]);
  });
});

describe("history", () => {
  it("puts the thread marker into the first reply and attributes turns", () => {
    const chat = threadToChat(
      [
        { variant: "ServerHint", content: { thread_id: "T" } },
        { variant: "User", content: "q" },
        { variant: "Assistant", content: "a" },
      ],
      { threadId: "T", topic: "Topic", provider: "climateclaw", hideCode: false, now: 1 },
    );
    expect(chat.messages.map((m) => m.sender)).toEqual(["user", "jupyternaut-frontend"]);
    expect(chat.messages[1]!.body.startsWith(threadMarker("T"))).toBe(true);
    expect(chat.metadata).toEqual({ provider: "climateclaw", autosave: false, title: "Topic" });
    // Where the server stored the reply: thread and user message, for rating and editing.
    expect(turnOf(chat.messages[1]!.body)).toEqual({ thread: "T", index: 0 });
    // The name is the thread's, never its topic: a title never names a backup file.
    expect(chatNameFor("abc-123/def")).toBe("ClimateClaw abc-123def");
  });

  it("numbers each reply by its user message, as the server counts them", () => {
    const chat = threadToChat(
      [
        { variant: "User", content: "q1" },
        { variant: "Assistant", content: "a1" },
        { variant: "User", content: "q2" },
        { variant: "Code", content: '{"code": "1"}' },
        { variant: "Assistant", content: "a2" },
      ],
      { threadId: "T", topic: "t", provider: "climateclaw", hideCode: false, autosave: true },
    );
    const replies = chat.messages.filter((m) => m.sender !== "user").map((m) => turnOf(m.body));
    expect(replies).toEqual([
      { thread: "T", index: 0 },
      { thread: "T", index: 1 },
    ]);
    expect(chat.metadata.autosave).toBe(true);
  });

  it("an empty branch stays empty when asked (no placeholder reply)", () => {
    const opts = { threadId: "T", topic: "t", provider: "climateclaw", hideCode: false };
    expect(threadToChat([], { ...opts, allowEmpty: true }).messages).toEqual([]);
    expect(threadToChat([], opts).messages).toHaveLength(1);
  });
});

describe("Run & fix", () => {
  it("sends the fixed template with the cell source in a fenced block", () => {
    expect(runAndFixInput("print(1)")).toBe(
      `${RUN_AND_FIX_TEMPLATE}\n\n\`\`\`python\nprint(1)\n\`\`\``,
    );
  });
  it("detects a fix, ignoring whitespace-only differences", () => {
    expect(fixDiffers("x = 1\n", "x = 1   \n\n")).toBe(false);
    expect(fixDiffers("x = 1", null)).toBe(false);
    expect(fixDiffers("1/0", "1/1")).toBe(true);
    expect(normalizeCode("a\r\nb  \n\n")).toBe("a\nb");
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toBe(" a\n-b\n+B\n c");
  });
  it("whitespace that is part of the program counts: in a string across lines, after a backslash", () => {
    // `"""a   \nb"""` and `"""a\nb"""` are different values.
    const cell = 's = """a   \nb"""\nprint(len(s))';
    expect(fixDiffers(cell, 's = """a\nb"""\nprint(len(s))')).toBe(true);
    expect(fixDiffers("s = '''x \n'''", "s = '''x\n'''")).toBe(true);
    // An escaped quote does not end the string.
    expect(fixDiffers('s = """\\""" \nx"""', 's = """\\"""\nx"""')).toBe(true);
    // A single-quoted string goes on only after a backslash; ended, its line's spaces do not count.
    expect(fixDiffers("s = 'a\\\nb' \nx = 1", "s = 'a\\\nb'\nx = 1")).toBe(false);
    // `\ ` then a newline is a syntax error, `\` a continuation.
    expect(fixDiffers("x = 1 + \\ \n2", "x = 1 + \\\n2")).toBe(true);
    // After a closed string and in comments, trailing spaces still do not count.
    expect(fixDiffers('s = """a"""   \n# """ \nx = 1  ', 's = """a"""\n# """\nx = 1')).toBe(false);
  });
  it("a run whose string changed is a fix: its output is never the cell's", () => {
    const cell = 's = """a   \nb"""\nprint(len(s))';
    const collector = new RunAndFixCollector(null, cell);
    collector.add([
      { type: "code", id: "a", code: 's = """a\nb"""\nprint(len(s))' },
      { type: "output", id: "a", output: normalizeCodeOutput({ stdout: "3\n", error: "" }) },
    ]);
    expect(collector.outputs.some((o) => o.output_type === "stream")).toBe(false);
    expect(collector.runs[0]!.outputs.map((o) => o.output_type)).toEqual(["stream"]);
  });
  it("puts the cell's own run in the cell, a line per fix attempt, and each fix's output with it", () => {
    const mapper = new VariantMapper({ hideCode: true });
    const collector = new RunAndFixCollector();
    for (const v of [
      { variant: "Code", content: '{"code":"1/0"}', id: "a" },
      { variant: "CodeOutput", content: { error: "ZeroDivisionError: division by zero" }, id: "a" },
      { variant: "Code", content: '{"code":"1/1"}', id: "b" },
      { variant: "CodeOutput", content: { stdout: "ok", result_repr: "1.0", error: "" }, id: "b" },
      { variant: "Image", content: "iVBO", id: "b_0" },
      { variant: "StreamEnd", content: "" },
    ]) {
      collector.add(mapper.map(v));
    }
    collector.add(mapper.flush());
    expect(collector.executed).toBe("1/1");
    expect(collector.ended).toBe(true);
    expect(collector.outputs.map((o) => o.output_type)).toEqual([
      "error",
      "display_data",
      "display_data",
    ]);
    expect(collector.outputs[1]).toMatchObject({
      data: { "text/plain": expect.stringMatching(/trying a fix \(run 2/) },
    });
    expect(collector.outputs[2]).toMatchObject({
      data: { "text/plain": "Run 2 ran without an error." },
    });
    expect(collector.runs[1]!.outputs.map((o) => o.output_type)).toEqual([
      "stream",
      "display_data",
      "display_data",
    ]);
    expect(collector.runs[1]!.outputs[2]).toMatchObject({ data: { "image/png": "iVBO" } });
  });

  it("checks the cell's imports first; the check never reaches the cell", () => {
    const source =
      "import numpy as np, xarray\nfrom healpix_geo import nested\nimport os\nfrom . import x";
    const modules = importedModules(source);
    expect(modules).toEqual(["numpy", "xarray", "healpix_geo"]);
    const check = moduleCheckCode(modules);
    expect(runAndFixInput(source, "", modules)).toContain(check);
    const collector = new RunAndFixCollector(check);
    collector.add([
      { type: "code", id: "c", code: check },
      {
        type: "output",
        id: "c",
        output: normalizeCodeOutput({ stdout: "climateclaw-missing: healpix_geo\n", error: "" }),
      },
    ]);
    expect(collector.missing).toEqual(["healpix_geo"]);
    expect(collector.outputs).toEqual([]);
    expect(collector.runs).toEqual([]);
    expect(parseModuleCheck("climateclaw-missing: \n")).toEqual([]);
  });

  it("reads ClimateClaw's verdicts and maps modules to what micropip installs", () => {
    expect(runVerdict("Fixed it.\nMISSING: healpix_geo, `cartopy`")).toEqual({
      missing: ["healpix_geo", "cartopy"],
    });
    expect(runVerdict("GAVE UP: the store has no 'tas'")).toEqual({
      gaveUp: "the store has no 'tas'",
    });
    expect(missingFromError("ModuleNotFoundError: No module named 'healpix_geo'")).toBe(
      "healpix_geo",
    );
    expect(packageFor("healpix_geo")).toBe("healpix-geo");
    expect(packageFor("sklearn")).toBe("scikit-learn");
    expect(installCellSource(["healpix_geo", "yaml"])).toContain(
      'await micropip.install(["healpix-geo","pyyaml"])',
    );
  });
});

describe("startModelSync", () => {
  it("syncs a sign-in that was restored before it started, without waiting for a change", async () => {
    const listeners: Array<() => void> = [];
    const auth = {
      signedIn: true,
      changed: {
        connect: (fn: () => void) => listeners.push(fn),
        disconnect: () => undefined,
      },
    };
    let providers = [
      {
        id: "climateclaw",
        name: "ClimateClaw (Freva)",
        provider: "climateclaw",
        model: "gpt-test",
      },
    ];
    let fetched = 0;
    startModelSync({
      auth,
      fetchModels: async () => {
        fetched += 1;
        return ["gpt-4.1", "gemma4:31b"];
      },
      defaultModel: "gpt-test",
      name: "ClimateClaw (Freva)",
      settings: {
        providers: () => providers,
        hasDefaultProvider: () => true,
        update: async (next) => {
          providers = next as typeof providers;
        },
        activate: async () => undefined,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetched).toBe(1);
    expect(providers.map((p) => p.model)).toEqual(["gpt-4.1", "gemma4:31b"]);
    expect(listeners).toHaveLength(1);
  });

  it("an older request never overwrites a newer sign-in's models", async () => {
    const listeners: Array<() => void> = [];
    const auth = {
      signedIn: true,
      changed: {
        connect: (fn: () => void) => listeners.push(fn),
        disconnect: () => undefined,
      },
    };
    let providers: Array<{ id: string; name: string; provider: string; model: string }> = [];
    const answers: Array<(models: string[]) => void> = [];
    const published: string[][] = [];
    startModelSync({
      auth,
      fetchModels: () => new Promise((resolve) => answers.push(resolve)),
      defaultModel: "",
      name: "ClimateClaw",
      publish: (models) => published.push(models),
      settings: {
        providers: () => providers,
        hasDefaultProvider: () => false,
        update: async (next) => {
          providers = next as typeof providers;
        },
        activate: async () => undefined,
      },
    });
    // Another sign-in starts a second request; the first answers last.
    listeners[0]!();
    answers[1]!(["new-model"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    answers[0]!(["old-model"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(providers.map((p) => p.model)).toEqual(["new-model"]);
    expect(published).toEqual([["new-model"]]);
  });

  it("a request still open at sign-out changes nothing, and the list is cleared", async () => {
    const listeners: Array<() => void> = [];
    const auth = {
      signedIn: true,
      changed: {
        connect: (fn: () => void) => listeners.push(fn),
        disconnect: () => undefined,
      },
    };
    let updates = 0;
    let answer!: (models: string[]) => void;
    const published: string[][] = [];
    startModelSync({
      auth,
      fetchModels: () => new Promise((resolve) => (answer = resolve)),
      defaultModel: "",
      name: "ClimateClaw",
      publish: (models) => published.push(models),
      settings: {
        providers: () => [],
        hasDefaultProvider: () => false,
        update: async () => void (updates += 1),
        activate: async () => undefined,
      },
    });
    auth.signedIn = false;
    listeners[0]!();
    answer(["m"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates).toBe(0);
    expect(published).toEqual([[]]);
  });
});
