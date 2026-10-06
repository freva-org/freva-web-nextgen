import { describe, expect, it } from "vitest";

import {
  NdjsonDecoder,
  VariantMapper,
  codeFromArguments,
  fence,
  normalizeCodeOutput,
  threadToTurns,
  type StreamEvent,
} from "../src/stream.js";

const texts = (events: StreamEvent[]) =>
  events
    .filter((e): e is Extract<StreamEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");

function run(lines: unknown[], options = {}) {
  const mapper = new VariantMapper(options);
  const events = lines.flatMap((line) => mapper.map(line));
  return [...events, ...mapper.flush()];
}

describe("NdjsonDecoder", () => {
  it("joins a line split across chunks and keeps order", () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push('{"variant":"Assi')).toEqual([]);
    expect(decoder.push('stant","content":"a"}\n{"variant":"StreamEnd"')).toEqual([
      { value: { variant: "Assistant", content: "a" } },
    ]);
    expect(decoder.push(',"content":"x"}\n')).toEqual([
      { value: { variant: "StreamEnd", content: "x" } },
    ]);
  });

  it("returns a final line without a newline on flush, and reports invalid lines", () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push("not json\n\n")).toEqual([{ invalid: "not json" }]);
    decoder.push('{"a":1}');
    expect(decoder.flush()).toEqual([{ value: { a: 1 } }]);
    expect(decoder.flush()).toEqual([]);
  });

  it("handles multi-byte characters split between chunks via a streaming TextDecoder", () => {
    const bytes = new TextEncoder().encode('{"variant":"Assistant","content":"€"}\n');
    const text = new TextDecoder();
    const decoder = new NdjsonDecoder();
    const first = decoder.push(text.decode(bytes.slice(0, 36), { stream: true }));
    const second = decoder.push(text.decode(bytes.slice(36), { stream: true }));
    expect([...first, ...second]).toEqual([{ value: { variant: "Assistant", content: "€" } }]);
  });
});

describe("VariantMapper", () => {
  it("passes assistant text through", () => {
    expect(
      texts(
        run([
          { variant: "Assistant", content: "Hello " },
          { variant: "Assistant", content: "world" },
        ]),
      ),
    ).toBe("Hello world");
  });

  it("assembles streamed Code JSON per id and emits one python block when complete", () => {
    const events = run([
      { variant: "Code", content: '{"co', id: "c1" },
      { variant: "ServerHint", content: { memory: 1 } },
      { variant: "Code", content: 'de":"print(1)\\nx = ', id: "c1" },
      { variant: "Code", content: '2"}', id: "c1" },
    ]);
    expect(events.filter((e) => e.type === "code")).toEqual([
      { type: "code", id: "c1", code: "print(1)\nx = 2" },
    ]);
    expect(texts(events)).toContain("```python\nprint(1)\nx = 2\n```");
  });

  it("keeps two interleaved code ids apart", () => {
    const events = run([
      { variant: "Code", content: '{"code":"a', id: "c1" },
      { variant: "Code", content: '{"code":"b"}', id: "c2" },
      { variant: "Code", content: '"}', id: "c1" },
    ]);
    expect(
      events.filter((e) => e.type === "code").map((e) => (e as { code: string }).code),
    ).toEqual(["b", "a"]);
  });

  it("omits code from the text when Hide code is on, keeps outputs", () => {
    const events = run(
      [
        { variant: "Code", content: '{"code":"print(1)"}', id: "c1" },
        { variant: "CodeOutput", content: { stdout: "1\n" }, id: "c1" },
      ],
      { hideCode: true },
    );
    expect(texts(events)).not.toContain("print(1)");
    expect(texts(events)).toContain("1");
    expect(events.some((e) => e.type === "code")).toBe(true);
  });

  it("with code going to a notebook, reports code, output and figures as events only", () => {
    const png = Buffer.from("png").toString("base64");
    const events = run(
      [
        { variant: "Assistant", content: "Here you go." },
        { variant: "Code", content: '{"code":"print(1)"}', id: "c1" },
        { variant: "CodeOutput", content: { stdout: "1\n" }, id: "c1" },
        { variant: "Image", content: png, id: "c1_0" },
        { variant: "Assistant", content: "Done." },
      ],
      { codeToNotebook: true, hideCode: true },
    );
    expect(texts(events)).toBe("Here you go.Done.");
    expect(events.map((e) => e.type).filter((t) => t !== "text")).toEqual([
      "code",
      "output",
      "image",
    ]);
  });

  it("with code going to a notebook and shown, also shows the code in the chat", () => {
    const events = run(
      [
        { variant: "Assistant", content: "Here you go." },
        { variant: "Code", content: '{"code":"print(1)"}', id: "c1" },
        { variant: "CodeOutput", content: { stdout: "1\n" }, id: "c1" },
      ],
      { codeToNotebook: true },
    );
    expect(texts(events)).toContain("```python\nprint(1)\n```");
    expect(events.map((e) => e.type).filter((t) => t !== "text")).toEqual(["code", "output"]);
  });

  it("shows code that never parsed when its output arrives", () => {
    const events = run([
      { variant: "Code", content: "print('raw')", id: "c1" },
      { variant: "CodeOutput", content: { stdout: "raw" }, id: "c1" },
    ]);
    expect(texts(events)).toContain("print('raw')");
  });

  it("renders a CodeOutput dict: stdout, result, stderr and a marked error", () => {
    const md = texts(
      run([
        {
          variant: "CodeOutput",
          content: {
            stdout: "out",
            result_repr: "42",
            stderr: "warn",
            error: "Traceback\nZeroDivisionError: division by zero",
            display_data: [{ "text/plain": "<Figure>" }],
            created_files: [
              { path: "a.png", preview_url: "https://x.example/a.png" },
              { path: "b.nc", preview_url: "javascript:alert(1)" },
            ],
          },
          id: "c1",
        },
      ]),
    );
    expect(md).toContain("**Output**");
    expect(md).toContain("out\n42\n<Figure>");
    expect(md).toContain("**stderr**");
    expect(md).toContain("**Error**");
    expect(md).toContain("ZeroDivisionError");
    expect(md).toContain("[a.png](https://x.example/a.png)");
    expect(md).not.toContain("javascript:");
    expect(md).toContain("`b.nc`");
  });

  it("accepts legacy CodeOutput strings and JSON strings", () => {
    expect(normalizeCodeOutput("plain").stdout).toBe("plain");
    // How the run ended: known only from a structured result's error field.
    expect(normalizeCodeOutput("NameError: x").outcome).toBe("unknown");
    expect(normalizeCodeOutput({ stdout: "1" }).outcome).toBe("unknown");
    expect(normalizeCodeOutput({ stdout: "1", error: "" }).outcome).toBe("ok");
    expect(normalizeCodeOutput({ stdout: "1", error: null }).outcome).toBe("ok");
    expect(normalizeCodeOutput({ error: "NameError: x" }).outcome).toBe("error");
    expect(normalizeCodeOutput('{"stdout":"js"}').stdout).toBe("js");
    expect(normalizeCodeOutput(["listed", "id"]).stdout).toBe("listed");
  });

  it("reassembles image fragments per id and emits a data: image of the given mime", () => {
    const events = run([
      { variant: "Image", content: "iVBO", id: "c1_0" },
      { variant: "Image", content: "Rw0K", id: "c1_0" },
      { variant: "Image", content: "/9j/", id: "c1_1", mime: "image/jpeg" },
      { variant: "Assistant", content: "done" },
    ]);
    const images = events.filter((e) => e.type === "image");
    expect(images).toEqual([
      { type: "image", id: "c1_0", mime: "image/png", base64: "iVBORw0K" },
      { type: "image", id: "c1_1", mime: "image/jpeg", base64: "/9j/" },
    ]);
    expect(texts(events)).toContain("![Figure](data:image/png;base64,iVBORw0K)");
    expect(texts(events).indexOf("done")).toBeGreaterThan(texts(events).indexOf("image/jpeg"));
  });

  it("refuses a non-image mime and non-base64 content", () => {
    const events = run([
      { variant: "Image", content: "PHN2Zz4=", id: "s", mime: "image/svg+xml" },
      { variant: "Image", content: "<script>", id: "t" },
    ]);
    const images = events.filter((e) => e.type === "image") as Array<{
      mime: string;
      base64: string;
    }>;
    expect(images).toEqual([{ type: "image", id: "s", mime: "image/png", base64: "PHN2Zz4=" }]);
  });

  it("maps tool calls to short status lines", () => {
    const md = texts(
      run([
        { variant: "ToolCall", content: "{}", tool_name: "web_search", id: "t" },
        { variant: "ToolOutput", content: "lots of text", tool_name: "web_search", id: "t" },
      ]),
    );
    expect(md).toContain("_Using web search…_");
    expect(md).toContain("_web search finished._");
    expect(md).not.toContain("lots of text");
  });

  it("reads thread ids and busy hints, ignores heartbeats and unknown hints", () => {
    const events = run([
      { variant: "ServerHint", content: { thread_id: "abc123" } },
      { variant: "ServerHint", content: '{"thread_id":"def"}' },
      {
        variant: "ServerHint",
        content: { busy: true, detail: "Executing previous code blocks..." },
      },
      { variant: "ServerHint", content: { busy: false, detail: "done" } },
      { variant: "ServerHint", content: { memory: 1, cpu_usage: 2 } },
      { variant: "ServerHint", content: { something: "new" } },
      { variant: "ServerHint", content: { thread_id: "../etc" } },
      { variant: "Mystery", content: "x" },
    ]);
    expect(events).toEqual([
      { type: "thread", threadId: "abc123" },
      { type: "thread", threadId: "def" },
      { type: "status", text: "Executing previous code blocks..." },
    ]);
  });

  it("maps server and model errors to error events and StreamEnd to the end", () => {
    const mapper = new VariantMapper();
    expect(mapper.map({ variant: "ServerError", content: "boom" })).toEqual([
      { type: "error", message: "ClimateClaw reported an error: boom" },
    ]);
    expect(mapper.map({ variant: "OpenAIError", content: "quota" })).toEqual([
      { type: "error", message: "The model reported an error: quota" },
    ]);
    expect(mapper.finished).toBe(false);
    expect(mapper.map({ variant: "StreamEnd", content: "Stream ended." })).toEqual([
      { type: "end", reason: "Stream ended." },
    ]);
    expect(mapper.finished).toBe(true);
  });
});

describe("helpers", () => {
  it("fences with more backticks than the content has", () => {
    expect(fence("a ``` b", "text")).toBe("````text\na ``` b\n````");
  });
  it("reads code arguments", () => {
    expect(codeFromArguments('{"code":"x"}')).toBe("x");
    expect(codeFromArguments('{"code":"x')).toBeNull();
    expect(codeFromArguments('"just a string"')).toBe("just a string");
  });
  it("groups a stored thread into turns", () => {
    const { threadId, turns } = threadToTurns([
      { variant: "ServerHint", content: { thread_id: "t1" } },
      { variant: "User", content: "plot it" },
      { variant: "Assistant", content: "Sure." },
      { variant: "Code", content: '{"code":"1+1"}', id: "c" },
      { variant: "CodeOutput", content: { result_repr: "2" }, id: "c" },
      { variant: "Image", content: "AAAA", id: "c_0", mime: "image/png" },
      { variant: "StreamEnd", content: "Stream ended." },
      { variant: "User", content: "thanks" },
    ]);
    expect(threadId).toBe("t1");
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(turns[1]!.text).toContain("Sure.");
    expect(turns[1]!.text).toContain("```python\n1+1\n```");
    expect(turns[1]!.text).toContain("data:image/png;base64,AAAA");
  });
});
