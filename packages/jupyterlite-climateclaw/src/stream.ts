// ClimateClaw's response stream, decoded: newline-delimited JSON variants in, Markdown and
// events out. Pure - no DOM, no fetch - so every rule is unit-tested.
//
// Wire facts (ClimateClaw `services/streaming/stream_variants.py` and
// `api/chatbot/streamresponse.py`):
// - `Code` arrives as chunks of the tool call's JSON arguments, `{"code": "..."}`, per call id;
//   a local model sends the whole argument string at once.
// - `CodeOutput.content` is a dict (stdout, stderr, result_repr, display_data, error,
//   created_files), or a string from older threads.
// - `Image.content` is base64 split into 8 KiB lines that share an `id`; `mime` is only present in
//   stored threads (default image/png).
// - `ServerHint.content` is a dict or a JSON string: `{thread_id}`, `{busy, detail}`, or a
//   heartbeat (memory/cpu numbers).

import { savedFigures } from "./figures.js";
import { RunCards } from "./run-card.js";

/** Splits a byte stream's text into JSON lines; a line may span chunks. */
export class NdjsonDecoder {
  private buffer = "";

  /** Feed text; returns the complete lines' values. Unparseable lines are reported as such. */
  push(text: string): Array<{ value: unknown } | { invalid: string }> {
    this.buffer += text;
    const out: Array<{ value: unknown } | { invalid: string }> = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) out.push(parse(line));
      newline = this.buffer.indexOf("\n");
    }
    return out;
  }

  /** The last line, when the stream ends without a newline. */
  flush(): Array<{ value: unknown } | { invalid: string }> {
    const line = this.buffer.trim();
    this.buffer = "";
    return line ? [parse(line)] : [];
  }
}

function parse(line: string): { value: unknown } | { invalid: string } {
  try {
    return { value: JSON.parse(line) };
  } catch {
    return { invalid: line.slice(0, 200) };
  }
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thread"; threadId: string }
  | { type: "code"; id: string; code: string }
  /** The code so far, while its arguments still stream (only with `codeToNotebook`). */
  | { type: "code-partial"; id: string; code: string }
  /** What ClimateClaw is doing now, for a status line. */
  | { type: "activity"; phase: ActivityPhase; label: string }
  | { type: "output"; id: string; output: CodeOutput }
  | { type: "image"; id: string; mime: string; base64: string }
  | { type: "status"; text: string }
  | { type: "error"; message: string }
  | { type: "end"; reason: string };

export type ActivityPhase =
  | "thinking"
  | "writing"
  | "coding"
  | "running"
  | "figure"
  | "tool"
  | "done";

export interface CodeOutput {
  /**
   * How the execution ended, as far as the output says: a structured result names its error (or
   * none); unstructured text says nothing, so the outcome is unknown.
   */
  outcome: "ok" | "error" | "unknown";
  stdout: string;
  stderr: string;
  result: string;
  error: string;
  /** text/plain of each display item without an image. */
  display: string[];
  /** Files the code wrote: a figure saved with `savefig` is only here (it is not streamed). */
  files: Array<{ name: string; url?: string; mime?: string }>;
}

export interface MapperOptions {
  /** Omit Code blocks from the chat's text (they are still reported as `code` events). */
  hideCode?: boolean;
  /** Code, its output and figures go elsewhere (a notebook): report them as events only. */
  codeToNotebook?: boolean;
  /** Also report what ClimateClaw is doing (`activity` events), for a status line. */
  activity?: boolean;
  /** A stored thread: saved figures shown by their address (a live stream fetches them). */
  storedFigures?: boolean;
  /**
   * Runs are shown as cards (see run-card.ts), built by the caller from the `code`, `output` and
   * `image` events: none of them adds text here.
   */
  cards?: boolean;
}

const THREAD_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/=\s]*$/;

export function isThreadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_ID.test(value);
}

/** A fence longer than any backtick run in `text`. */
export function fence(text: string, info = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${info}\n${text.replace(/\n+$/, "")}\n${ticks}`;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** CodeOutput content (dict, JSON string or legacy string) in one shape. */
export function normalizeCodeOutput(content: unknown): CodeOutput {
  let value = content;
  if (Array.isArray(value)) value = value[0];
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed;
    } catch {
      // A legacy flattened string is stdout.
    }
  }
  if (typeof value === "string") {
    return {
      outcome: "unknown",
      stdout: value,
      stderr: "",
      result: "",
      error: "",
      display: [],
      files: [],
    };
  }
  const dict = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const display = Array.isArray(dict.display_data)
    ? dict.display_data
        .map((item) =>
          item && typeof item === "object"
            ? asText((item as Record<string, unknown>)["text/plain"])
            : asText(item),
        )
        .filter(Boolean)
    : [];
  const files = Array.isArray(dict.created_files)
    ? dict.created_files
        .map((f) => f as Record<string, unknown>)
        .filter((f) => f && typeof f.path === "string")
        .map((f) => {
          const url = typeof f.preview_url === "string" ? f.preview_url : "";
          const mime = typeof f.mime_type === "string" ? f.mime_type : "";
          return {
            name: String(f.path),
            ...(previewUrl(url) ? { url } : {}),
            ...(mime ? { mime } : {}),
          };
        })
    : [];
  const error = asText(dict.error);
  return {
    outcome: !("error" in dict) ? "unknown" : error ? "error" : "ok",
    stdout: asText(dict.stdout),
    stderr: asText(dict.stderr),
    result: asText(dict.result_repr),
    error,
    display,
    files,
  };
}

/** A file's preview address: HTTPS, or a loopback HTTP host (a local development server). */
export function previewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" &&
      /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** Markdown for a code output; errors are marked as such. */
export function codeOutputMarkdown(
  output: CodeOutput,
  options: { figures?: "link" | "picture" } = {},
): string {
  const parts: string[] = [];
  const out = [output.stdout, output.result, ...output.display]
    .map((s) => s.replace(/\n+$/, ""))
    .filter(Boolean)
    .join("\n");
  if (out) parts.push(`**Output**\n\n${fence(out, "text")}`);
  if (output.stderr) parts.push(`**stderr**\n\n${fence(output.stderr, "text")}`);
  if (output.error) parts.push(`**Error**\n\n${fence(output.error, "text")}`);
  if (output.files.length) {
    parts.push(
      `**Files**\n\n${output.files
        .map((f) => (f.url ? `- [${escapeLinkText(f.name)}](${f.url})` : `- \`${f.name}\``))
        .join("\n")}`,
    );
  }
  // A stored conversation shows a saved figure by its address (a live one fetches it).
  if (options.figures === "picture") {
    for (const f of output.files) {
      if (f.url && /\.(png|jpe?g)$/i.test(f.name)) {
        parts.push(`![${escapeLinkText(f.name.split("/").pop() ?? f.name)}](${f.url})`);
      }
    }
  }
  return parts.join("\n\n");
}

function escapeLinkText(text: string): string {
  return text.replace(/[[\]\\]/g, (c) => `\\${c}`);
}

/** The `code` value of a code_interpreter call's JSON arguments, or null while incomplete. */
export function codeFromArguments(args: string): string | null {
  try {
    const parsed: unknown = JSON.parse(args);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { code?: unknown }).code === "string"
    ) {
      return (parsed as { code: string }).code;
    }
    if (typeof parsed === "string") return parsed;
  } catch {
    return null;
  }
  return null;
}

/**
 * The `code` string of code_interpreter arguments that are still arriving, decoded as far as it
 * is complete (an escape cut in half waits for its other half); null before the string starts.
 */
export function partialCodeFromArguments(args: string): string | null {
  const start = /"code"\s*:\s*"/.exec(args);
  if (!start) return null;
  let out = "";
  for (let i = start.index + start[0].length; i < args.length; i += 1) {
    const c = args[i]!;
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = args[i + 1];
    if (next === undefined) return out;
    if (next === "u") {
      const hex = args.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
    out += simple[next] ?? next;
    i += 1;
  }
  return out;
}

/**
 * Turns variants into events. Stateful: code arguments and image fragments are assembled per id
 * and released when complete (code: when its JSON parses; image: when another variant arrives).
 */
export class VariantMapper {
  private codeBuffers = new Map<string, string>();
  private codeDone = new Set<string>();
  private partials = new Map<string, string>();
  private activity = "";
  private image: { id: string; mime: string; parts: string[] } | null = null;
  private ended = false;

  constructor(private readonly options: MapperOptions = {}) {}

  get finished(): boolean {
    return this.ended;
  }

  /** Map one decoded line. */
  map(value: unknown): StreamEvent[] {
    const out: StreamEvent[] = [];
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    const v = value as Record<string, unknown>;
    const variant = v.variant;
    const id = typeof v.id === "string" ? v.id : "";
    // Heartbeat hints arrive while code arguments are still streaming: they release nothing.
    if (variant !== "ServerHint") {
      if (variant !== "Image" || (this.image && this.image.id !== id)) {
        out.push(...this.flushImage());
      }
      if (variant !== "Code") {
        out.push(...this.flushCode(variant === "CodeOutput" ? id : undefined));
      }
    }
    switch (variant) {
      case "Assistant":
        if (typeof v.content === "string" && v.content) out.push({ type: "text", text: v.content });
        break;
      case "Code":
        out.push(...this.code(id, v.content));
        break;
      case "CodeOutput": {
        const output = normalizeCodeOutput(v.content);
        out.push({ type: "output", id, output });
        const md =
          this.options.codeToNotebook || this.options.cards
            ? ""
            : codeOutputMarkdown(output, {
                figures: this.options.storedFigures ? "picture" : "link",
              });
        if (md) out.push({ type: "text", text: block(md) });
        break;
      }
      case "Image": {
        const content = typeof v.content === "string" ? v.content : "";
        if (!BASE64.test(content)) break;
        const mime = typeof v.mime === "string" && IMAGE_MIME.has(v.mime) ? v.mime : "image/png";
        if (!this.image) this.image = { id, mime, parts: [] };
        this.image.parts.push(content.replace(/\s+/g, ""));
        break;
      }
      case "ToolCall":
        out.push({ type: "text", text: block(`_Using ${toolName(v)}…_`) });
        break;
      case "ToolOutput":
        out.push({ type: "text", text: block(`_${toolName(v)} finished._`) });
        break;
      case "ServerHint":
        out.push(...this.hint(v.content));
        break;
      case "ServerError":
      case "OpenAIError":
        out.push({
          type: "error",
          message: `${variant === "OpenAIError" ? "The model" : "ClimateClaw"} reported an error: ${asText(v.content) || "unknown error"}`,
        });
        break;
      case "StreamEnd":
        this.ended = true;
        out.push({ type: "end", reason: asText(v.content) });
        break;
      default:
        // User and Prompt belong to stored threads; anything else is unknown and ignored.
        break;
    }
    const doing = this.options.activity ? this.activityOf(variant, v, out) : null;
    if (doing && `${doing.phase}:${doing.label}` !== this.activity) {
      this.activity = `${doing.phase}:${doing.label}`;
      out.push({ type: "activity", ...doing });
    }
    return out;
  }

  /** What this variant says ClimateClaw is doing; null when it says nothing new. */
  private activityOf(
    variant: unknown,
    v: Record<string, unknown>,
    out: StreamEvent[],
  ): { phase: ActivityPhase; label: string } | null {
    switch (variant) {
      case "Assistant":
        return out.some((e) => e.type === "text") ? { phase: "writing", label: "Writing" } : null;
      case "Code":
        return out.some((e) => e.type === "code")
          ? { phase: "running", label: "Running code at DKRZ" }
          : { phase: "coding", label: "Writing code" };
      case "CodeOutput":
      case "ToolOutput":
        return { phase: "thinking", label: "Thinking" };
      case "Image":
        return { phase: "figure", label: "Drawing a figure" };
      case "ToolCall":
        return { phase: "tool", label: `Using ${toolName(v)}` };
      case "ServerHint":
        return out.some((e) => e.type === "status")
          ? { phase: "running", label: "Running code at DKRZ" }
          : null;
      case "StreamEnd":
        return { phase: "done", label: "" };
      default:
        return null;
    }
  }

  /** Release whatever is still assembled (end of stream). */
  flush(): StreamEvent[] {
    return [...this.flushImage(), ...this.flushCode()];
  }

  private code(id: string, content: unknown): StreamEvent[] {
    const chunk = Array.isArray(content) ? asText(content[0]) : asText(content);
    if (this.codeDone.has(id)) return [];
    const buffer = (this.codeBuffers.get(id) ?? "") + chunk;
    this.codeBuffers.set(id, buffer);
    const code = codeFromArguments(buffer);
    if (code === null && this.options.codeToNotebook) {
      // Typed into its cell as it arrives.
      const partial = partialCodeFromArguments(buffer);
      if (partial !== null && partial !== this.partials.get(id)) {
        this.partials.set(id, partial);
        return [{ type: "code-partial", id, code: partial }];
      }
      return [];
    }
    return code === null ? [] : this.releaseCode(id, code);
  }

  private releaseCode(id: string, code: string): StreamEvent[] {
    this.codeBuffers.delete(id);
    this.codeDone.add(id);
    const out: StreamEvent[] = [{ type: "code", id, code }];
    // In the chat unless hidden - also when it goes to a notebook cell too.
    if (!this.options.hideCode && !this.options.cards) {
      out.push({ type: "text", text: block(fence(code, "python")) });
    }
    return out;
  }

  /** Code that never parsed is shown as it arrived when its output (or the end) comes. */
  private flushCode(onlyId?: string): StreamEvent[] {
    const out: StreamEvent[] = [];
    for (const [id, buffer] of [...this.codeBuffers]) {
      if (onlyId !== undefined && id !== onlyId) continue;
      out.push(...this.releaseCode(id, buffer));
    }
    return out;
  }

  private flushImage(): StreamEvent[] {
    if (!this.image) return [];
    const { id, mime, parts } = this.image;
    this.image = null;
    const base64 = parts.join("");
    if (!base64) return [];
    const event: StreamEvent = { type: "image", id, mime, base64 };
    if (this.options.codeToNotebook || this.options.cards) return [event];
    return [event, { type: "text", text: block(`![Figure](data:${mime};base64,${base64})`) }];
  }

  private hint(content: unknown): StreamEvent[] {
    let value = content;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return [];
      }
    }
    if (!value || typeof value !== "object") return [];
    const hint = value as Record<string, unknown>;
    if (isThreadId(hint.thread_id)) return [{ type: "thread", threadId: hint.thread_id }];
    if (hint.busy === true && typeof hint.detail === "string" && hint.detail) {
      return [{ type: "status", text: hint.detail }];
    }
    return [];
  }
}

function toolName(v: Record<string, unknown>): string {
  const name = typeof v.tool_name === "string" ? v.tool_name.replace(/[_`*[\]]/g, " ").trim() : "";
  return name || "a tool";
}

/** A block on its own lines. */
function block(markdown: string): string {
  return `\n\n${markdown}\n\n`;
}

/** Markdown for stored thread content, grouped into turns. Used by History. */
export function threadToTurns(
  variants: unknown[],
  options: MapperOptions = {},
): {
  threadId: string | null;
  /** `user`: the User variant (from 0) the turn is, or answers; -1 before any. */
  turns: Array<{ role: "user" | "assistant"; text: string; user: number }>;
} {
  const turns: Array<{ role: "user" | "assistant"; text: string; user: number }> = [];
  let threadId: string | null = null;
  const stored = { ...options, storedFigures: true, cards: true };
  let mapper = new VariantMapper(stored);
  // Each run as a card, as a live reply shows it; saved figures by their address.
  const cards = new RunCards({ open: !options.hideCode });
  let users = -1;
  const assistant = (text: string) => {
    const last = turns[turns.length - 1];
    if (last && last.role === "assistant") last.text += text;
    else turns.push({ role: "assistant", text, user: users });
  };
  const written = () => {
    if (cards.pending) assistant(cards.flush());
  };
  const drain = (events: StreamEvent[]) => {
    for (const e of events) {
      if (e.type === "code") {
        if (cards.isNew(e.id)) written();
        cards.code(e.id, e.code);
      } else if (e.type === "output") {
        cards.output(e.id, e.output);
        for (const figure of savedFigures(e.output)) cards.figure(e.id, figure, null);
      } else if (e.type === "image") cards.image(e.id, e.mime, e.base64);
      else if (e.type === "text") {
        written();
        assistant(e.text);
      } else if (e.type === "thread" && !threadId) threadId = e.threadId;
      else if (e.type === "error") {
        written();
        assistant(`\n\n> **Error:** ${e.message}\n\n`);
      }
    }
  };
  for (const value of variants) {
    const v = value as Record<string, unknown> | null;
    if (v && v.variant === "User") {
      drain(mapper.flush());
      written();
      mapper = new VariantMapper(stored);
      users += 1;
      turns.push({ role: "user", text: asText(v.content), user: users });
      continue;
    }
    drain(mapper.map(value));
  }
  drain(mapper.flush());
  written();
  for (const t of turns) t.text = t.text.replace(/^\s+|\s+$/g, "");
  return { threadId, turns: turns.filter((t) => t.text) };
}
