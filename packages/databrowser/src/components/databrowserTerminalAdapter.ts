// components/databrowserTerminalAdapter.ts - the thin seam between the data browser and the
// reusable @freva-org/freva-client-terminal package.
//
// The package owns the WINDOW: chrome, tabs, focus, drag/resize/minimize, the completion menu, the
// highlighting surface, copy feedback, the settings menu and the keyboard-escape contract. It has
// no idea what a facet is.
//
// This file owns the MEANING: facet/time/bbox state, the REST query, the CLI and python command
// builders, which keys and values may be completed, and what a commit does. It supplies those as
// two generic TerminalTab models.
//
// The package must never learn about AppContext, state.ts, the API or the databrowser icons - that
// coupling is exactly what this seam exists to keep out.

import type {
  TerminalCompletion,
  TerminalCompletionItem,
  TerminalHandle,
  TerminalSegment,
  TerminalTab,
} from "@freva-org/freva-client-terminal";
import { createTerminal } from "@freva-org/freva-client-terminal";

import type { AppContext } from "../context.js";
import { makeDebounce } from "../dom.js";
import { ICONS } from "../icons.js";
import { SHELLS, defaultShellFor, detectOS, type ShellId } from "../shell.js";
import { cliCommand } from "../commands.js";
import { loadTermAlpha, loadTermTheme, saveTermAlpha, saveTermTheme } from "../theme.js";
import {
  ADDITIONAL_FACET_FALLBACK,
  CONTROL_KEYS,
  PRIMARY_FACET_FALLBACK,
  SELECT_MODES,
  baseFacetKey,
  baseScopePairs,
  closedValueSet,
  facetQueryStringExcluding,
  filterCommittable,
  isGatedKey,
  knownFacetKeys,
  negativeKey,
  parseFacetKey,
  parseFacetTokens,
  parseSolrFacetArray,
  parsePyConfig,
  pyEditableLines,
  pyFixedLines,
  pythonCommand,
  shellQuote,
  terminalTokens,
  tokenizeRich,
  type TokenSegment,
} from "../state.js";

const ENRICH_DEBOUNCE_MS = 160;
const PY_COMMIT_DEBOUNCE_MS = 200;
const MAX_MENU_ITEMS = 60;

export interface TerminalController {
  render(): void;
  toggle(): void;
  isShown(): boolean;
  destroy(): void;
}

/** Guidance for keys whose values can't be enumerated - they're typed, not chosen. */
const CONTROL_HINT: Record<string, string> = {
  bbox: "bbox=minLon,maxLon,minLat,maxLat - e.g. bbox=-10,10,35,60 · add bbox_select (defaults to flexible)",
  time: 'time="2000 TO 2010" - e.g. time="2000-01 TO 2010-12" · add time_select (defaults to flexible)',
};

/** The *_select modes are a closed set; bbox/time values are free text. */
function controlValues(key: string): string[] | null {
  if (key === "bbox_select" || key === "time_select") return [...SELECT_MODES];
  return null;
}

/** A typed key that is asking for the negative form: `…_n`, `…_no`, `…_not`, `…_not_`. */
const WANTS_NEGATION = /_n(?:o(?:t_?)?)?$/;

export function createDatabrowserTerminal(ctx: AppContext): TerminalController {
  const enrichDebounce = makeDebounce(ctx.dis);
  const pyDebounce = makeDebounce(ctx.dis);
  /** facet -> fuller value list from metadata-search (the sampled list is only the first page). */
  const enrichedValues = new Map<string, string[]>();
  let lastEnrichVersion = -1;

  const os = ctx.cfg.terminal.os ?? detectOS();
  const shellId: ShellId = ctx.cfg.terminal.shell ?? defaultShellFor(os);

  // shared domain helpers
  /** Valid keys for the highlighter AND the commit guard - one set, so they cannot disagree. */
  function knownKeys(): Set<string> {
    const k = new Set(knownFacetKeys(ctx.state));
    if (k.size) for (const c of CONTROL_KEYS) k.add(c);
    return k;
  }
  /** The BASE facet keys offerable in the terminal (the locked scope owns its own key). */
  function baseKeysForAutocomplete(): string[] {
    const k = knownKeys();
    const base = k.size ? [...k] : [...PRIMARY_FACET_FALLBACK, ...ADDITIONAL_FACET_FALLBACK];
    const all = [...new Set([...base, ...CONTROL_KEYS])];
    return all.filter((key) => !isGatedKey(ctx.state, key));
  }
  /**
   * Key candidates for a typed prefix. Negative (`_not_`) keys are surfaced only once what the user
   * has typed indicates negation - doubling every default list would bury the ordinary keys behind
   * their own negations - but a fully-typed negative key always completes and validates.
   */
  function keyCandidates(typed: string): string[] {
    const q = typed.toLowerCase();
    const base = baseKeysForAutocomplete();
    if (!WANTS_NEGATION.test(q)) return base.filter((k) => k.startsWith(q));
    const negatable = base.filter((k) => !CONTROL_KEYS.has(k));
    return [
      ...negatable.map(negativeKey).filter((k) => k.startsWith(q)),
      ...base.filter((k) => k.startsWith(q)),
    ];
  }
  function sampleValues(key: string): TerminalCompletionItem[] {
    const facet = ctx.state.facets.find((f) => f.key === baseFacetKey(key));
    if (!facet) return [];
    return facet.values.map((v) => ({ value: v.value, count: v.count }));
  }
  /** Values offerable for a key - suffix-aware, because `project_not_` completes `project`'s values. */
  function candidateValues(key: string): string[] {
    const base = baseFacetKey(key);
    const cached = enrichedValues.get(base);
    return cached && cached.length ? cached : sampleValues(base).map((it) => it.value);
  }
  /** Refine a facet's value list via metadata-search, then re-render so the ghost/list catches up. */
  async function enrich(key: string): Promise<void> {
    const base = baseFacetKey(key);
    if (isGatedKey(ctx.state, base)) return; // the scope key is never completed -> never queried
    try {
      const signal = ctx.api.channelSignal("autocomplete");
      const res = await ctx.api.metadataSearch(
        ctx.state.flavour,
        ctx.state.uniqKey,
        facetQueryStringExcluding(ctx.state, base),
        signal,
      );
      const pairs = parseSolrFacetArray(res.facets[base] ?? []);
      if (pairs.length) {
        enrichedValues.set(
          base,
          pairs.map(([value]) => value),
        );
        handle?.render();
      }
    } catch {
      /* slow / failed / aborted - the sampled list stays */
    }
  }

  // CLI tab
  /** The token segment the caret is touching (inside or at either edge), or null on whitespace. */
  function caretSegment(text: string, caret: number): TokenSegment | null {
    for (const seg of tokenizeRich(text)) {
      if (seg.kind !== "tok") continue;
      if (caret >= seg.start && caret <= seg.end) return seg;
    }
    return null;
  }
  function tokenBounds(text: string, caret: number): { start: number; typed: string } {
    const seg = caretSegment(text, caret);
    if (!seg) return { start: caret, typed: "" };
    // `typed` is the COOKED prefix up to the caret (quotes only appear on values with whitespace,
    // where the raw prefix still prefix-matches correctly).
    return { start: seg.start, typed: text.slice(seg.start, caret).replace(/"/g, "") };
  }
  function tokenEndAt(text: string, start: number): number {
    for (const seg of tokenizeRich(text)) {
      if (seg.kind === "tok" && seg.start === start) return seg.end;
    }
    return start;
  }
  /** Insert an accepted key/value, exactly as the ghost and the menu both must. */
  function applyCli(text: string, start: number, choice: string): { text: string; caret: number } {
    const end = tokenEndAt(text, start);
    const isKey = !text.slice(start, end).includes("=");
    if (isKey) {
      const insert = `${choice}=`;
      return {
        text: text.slice(0, start) + insert + text.slice(end),
        caret: start + insert.length,
      };
    }
    const eq = text.indexOf("=", start);
    const key = text.slice(start, eq);
    // Quote values containing whitespace (the real `not set`) so the tokenizer round-trips them
    // back into ONE token rather than `key=not` plus a stray `set`.
    const tok = `${key}=${shellQuote(choice)} `;
    return { text: text.slice(0, start) + tok + text.slice(end), caret: start + tok.length };
  }

  function cliPrefix(): TerminalSegment[] {
    const sh = SHELLS[shellId];
    const segs: TerminalSegment[] = [
      { text: sh.prompt, kind: "prompt" },
      { text: " " },
      { text: "freva-client databrowser data-search", kind: "fixed" },
    ];
    // --host is intentionally omitted: freva-client resolves the instance from its own config.
    if (ctx.state.flavour !== "freva") {
      segs.push({ text: " " }, { text: "--flavour", kind: "fixed" });
      segs.push({ text: " " }, { text: ctx.state.flavour, kind: "accent" });
    }
    // The base scope is invisible in the typed tokens but IS part of the query, so print it
    // (dimmed, read-only) - a command copied into a real shell must reproduce the SAME scoped
    // results the widget shows rather than silently querying the whole archive.
    for (const [k, v] of baseScopePairs(ctx.state)) {
      segs.push({ text: " " }, { text: `${k}=${sh.quote(v)}`, kind: "muted" });
    }
    return segs;
  }

  function cliHighlight(text: string): { segments: TerminalSegment[]; warning?: string } {
    const k = knownKeys();
    const canValidateKeys = k.size > 0;
    const segments: TerminalSegment[] = [];
    let warning = "";
    for (const seg of tokenizeRich(text)) {
      if (seg.kind === "ws") {
        segments.push({ text: seg.raw });
        continue;
      }
      const eq = seg.value.indexOf("=");
      if (eq < 0) {
        const ok =
          !canValidateKeys ||
          k.has(baseFacetKey(seg.value.toLowerCase())) ||
          [...k].some((key) => key.startsWith(baseFacetKey(seg.value.toLowerCase())));
        segments.push({ text: seg.raw, kind: ok ? "key" : "bad" });
        if (!ok && !warning) warning = `“${seg.value}” is not a facet`;
        continue;
      }
      const key = seg.value.slice(0, eq);
      const val = seg.value.slice(eq + 1);
      // Split the RAW at its first '=': keys never contain quotes, so raw and cooked agree on the
      // key side, and everything after that '=' is the value's raw form.
      const rawEq = seg.raw.indexOf("=");
      const keyRaw = rawEq < 0 ? seg.raw : seg.raw.slice(0, rawEq);
      const valRaw = rawEq < 0 ? "" : seg.raw.slice(rawEq + 1);
      // Validate the UNDERLYING positive key: `project_not_` is a facet exactly when `project` is.
      const { baseKey } = parseFacetKey(key.toLowerCase());
      const keyOk = !canValidateKeys || k.has(baseKey);
      segments.push({ text: keyRaw, kind: keyOk ? "key" : "bad" });
      if (rawEq >= 0) segments.push({ text: "=", kind: "eq" });
      if (!keyOk && !warning) warning = `“${key}” is not a facet`;
      let valBad = false;
      if (keyOk && val) {
        const vs = closedValueSet(ctx.state, key.toLowerCase());
        if (vs && !vs.has(val)) {
          valBad = true;
          if (!warning) warning = `“${val}” isn’t a ${key} value`;
        }
      }
      segments.push({ text: valRaw, kind: valBad ? "bad" : "value" });
    }
    return { segments, warning };
  }

  function cliComplete(text: string, caret: number): TerminalCompletion | null {
    const { start, typed } = tokenBounds(text, caret);
    const atEnd = caret === text.length;
    const apply = (value: string): { text: string; caret: number } => applyCli(text, start, value);
    const eq = typed.indexOf("=");
    if (eq < 0) {
      const q = typed.toLowerCase();
      const cands = keyCandidates(q);
      const best = cands.filter((c) => c.length > q.length).sort((a, b) => a.length - b.length)[0];
      return {
        items: cands.slice(0, MAX_MENU_ITEMS).map((value) => ({ value, count: null })),
        ghost: atEnd && typed && best ? best.slice(typed.length) : "",
        ghostValue: best,
        apply,
      };
    }
    const key = typed.slice(0, eq).toLowerCase();
    const rawQ = typed.slice(eq + 1);
    const q = rawQ.toLowerCase();
    // bbox/time have no listable values - say HOW to type them instead of showing an empty list.
    const hint = CONTROL_HINT[key];
    if (hint) return { items: [], message: hint, apply };
    const modes = controlValues(key);
    if (modes) {
      const cands = modes.filter((v) => v.startsWith(q));
      const best = cands.filter((c) => c.length > rawQ.length)[0];
      return {
        items: cands.map((value) => ({ value, count: null })),
        ghost: atEnd && best ? best.slice(rawQ.length) : "",
        ghostValue: best,
        apply,
      };
    }
    enrichDebounce(() => void enrich(key), ENRICH_DEBOUNCE_MS);
    const counts = new Map(sampleValues(key).map((it) => [it.value, it.count ?? null]));
    const cands = candidateValues(key).filter((v) => v.toLowerCase().startsWith(q));
    const best = cands.filter((c) => c.length > rawQ.length).sort((a, b) => a.length - b.length)[0];
    return {
      items: cands.slice(0, MAX_MENU_ITEMS).map((value) => ({
        value,
        count: counts.get(value) ?? null,
      })),
      ghost: atEnd && best ? best.slice(rawQ.length) : "",
      ghostValue: best,
      apply,
    };
  }

  /** The committable portion: every token except (unless final) the in-progress one at the caret. */
  function committedText(text: string, caret: number, final: boolean): string {
    if (final) return text;
    const seg = caretSegment(text, caret);
    if (!seg) return text;
    return text.slice(0, seg.start) + text.slice(seg.end);
  }

  /**
   * Drop `time` / `time_select` / `bbox` / `bbox_select` before asking the facet guard about a
   * buffer.
   *
   * These are CONTROL tokens, not facets: `applyTerminalDraft` pulls them out first and routes them
   * to `state.time` / `state.bbox`, where the mode lives INSIDE its parent object. The guard has
   * never heard of them, so handing them over unfiltered means every one of them comes back
   * "rejected", and rejected text is text the resync retains. That is how removing the BBox chip
   * would leave `bbox_select=strict` sitting in the buffer with nothing to qualify - an orphan the
   * next commit puts back on the wire. The control state is rebuilt from `state` by `text()`, so
   * there is never anything about it worth retaining.
   */
  function withoutControlTokens(parsed: Record<string, string[]>): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const key of Object.keys(parsed)) {
      if (!CONTROL_KEYS.has(key.toLowerCase())) out[key] = parsed[key];
    }
    return out;
  }

  /**
   * The parts of the buffer the STATE does not represent: tokens the guard rejected, plus the
   * in-progress token being typed. These are what must survive an external re-sync.
   */
  function uncommittedText(text: string): string {
    const { rejected } = filterCommittable(ctx.state, withoutControlTokens(parseFacetTokens(text)));
    const keep = [...rejected];
    // A control token with a VALUE is settled - `state.time` / `state.bbox` say everything there is
    // to say about it, including whether the user just removed it. One with an EMPTY value is being
    // typed (`time=`), and dropping that would delete the user's keystrokes mid-word.
    for (const seg of tokenizeRich(text)) {
      if (seg.kind !== "tok") continue;
      const raw = text.slice(seg.start, seg.end);
      const eq = raw.indexOf("=");
      if (eq < 0) continue;
      const key = raw.slice(0, eq).toLowerCase();
      if (CONTROL_KEYS.has(key) && raw.slice(eq + 1).trim() === "" && !keep.includes(raw)) {
        keep.push(raw);
      }
    }
    const trailing = /\S+$/.exec(text)?.[0] ?? "";
    if (trailing && !keep.includes(trailing)) {
      const parsedTrailing = withoutControlTokens(parseFacetTokens(trailing));
      const settledControl = Object.keys(parseFacetTokens(trailing)).every((k) =>
        CONTROL_KEYS.has(k.toLowerCase()),
      );
      const committed =
        Object.keys(parsedTrailing).length &&
        !filterCommittable(ctx.state, parsedTrailing).rejected.length &&
        Object.values(parsedTrailing).every((vs) => vs.every(Boolean));
      if (!committed && !settledControl) keep.push(trailing);
    }
    return [...new Set(keep)].join(" ");
  }

  const cliTab: TerminalTab = {
    id: "cli",
    // `te` is the historical class prefix for the shell editor in the freva stylesheet
    // (`.te-input`, `.te-hl`, `.te-menu`), while the TAB is still identified as `cli`.
    cssPrefix: "te",
    label: SHELLS[shellId].label,
    icon: ICONS.bashTab,
    multiline: false,
    placeholder: "project=cmip6 variable=tas",
    ariaLabel: "Command facets",
    prefix: cliPrefix,
    text: () => terminalTokens(ctx.state),
    highlight: cliHighlight,
    complete: cliComplete,
    commit(text, caret, final) {
      const commit = committedText(text, caret, final);
      const rejected = ctx.applyTerminalDraft(commit);
      // A malformed bbox/time says exactly WHY (4 numbers, lat ≤ 90, needs a TO range) rather than
      // silently committing nothing.
      const controlErrs = ctx.terminalDraftErrors(commit);
      const hlWarn = cliHighlight(text).warning ?? "";
      const warning = hlWarn || controlErrs[0] || "";
      const withheld = commit !== text;
      // A token the parser drops silently (a bare key, or `project=` with no value) is also an
      // incomplete draft: it must survive an external re-render rather than be overwritten.
      const hasIncompleteToken = tokenizeRich(commit).some((seg) => {
        if (seg.kind !== "tok") return false;
        const eq = seg.value.indexOf("=");
        return eq < 1 || seg.value.slice(eq + 1) === "";
      });
      return {
        dirty: rejected > 0 || withheld || warning !== "" || hasIncompleteToken,
        warning: controlErrs[0],
      };
    },
    copyText: () => cliCommand(ctx.state, { shell: shellId }),
    revision: () => ctx.state.externalEdits,
    retain: uncommittedText,
  };

  // Python tab
  /** The text after the LAST top-level comma (quote/bracket aware) - the kwarg being typed. */
  function lastKwargSegment(before: string): string {
    let depth = 0;
    let quote = "";
    let cut = 0;
    for (let i = 0; i < before.length; i++) {
      const ch = before[i];
      if (quote) {
        if (ch === "\\") {
          i++;
          continue;
        }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "[" || ch === "{" || ch === "(") depth++;
      else if (ch === "]" || ch === "}" || ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) cut = i + 1;
    }
    return before.slice(cut);
  }
  /** The completion token at the caret. A line may carry SEVERAL kwargs, so look at the last one. */
  function pyToken(
    text: string,
    caret: number,
  ): { word: string; isValue: boolean; key: string } | null {
    const next = text[caret];
    if (next !== undefined && next !== "\n" && next !== ",") return null; // mid-word - don't complete
    const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
    const seg = lastKwargSegment(text.slice(lineStart, caret));
    const eq = seg.indexOf("=");
    if (eq < 0) {
      const m = seg.match(/([\w-]*)$/);
      return { word: m ? m[1] : "", isValue: false, key: "" };
    }
    const key = seg.slice(0, eq).trim().replace(/["']/g, "");
    const m = seg.slice(eq + 1).match(/([^\s,"'[\]]*)$/);
    return { word: m ? m[1] : "", isValue: true, key };
  }
  /**
   * Insert a python completion, writing REAL python either way:
   *   key   -> `project=`     (ready for the value)
   *   value -> `"cordex",`    (quoted + comma, absorbing a quote already typed)
   */
  function applyPy(
    text: string,
    caret: number,
    wordLen: number,
    isValue: boolean,
    value: string,
  ): { text: string; caret: number } {
    let start = caret - wordLen;
    let insert: string;
    if (!isValue) insert = `${value}=`;
    else {
      if (text[start - 1] === '"' || text[start - 1] === "'") start--; // absorb the opening quote
      insert = `${JSON.stringify(value)},`;
    }
    const next = text.slice(0, start) + insert + text.slice(caret);
    return { text: next, caret: start + insert.length };
  }

  /**
   * One read-only python line. `muted` marks the echoed scope/flavour lines, which are also the
   * CONTINUATION lines - their `...` gutter is quiet, while a real `>>>` keeps the prompt colour.
   * Saying so here rather than in CSS is what lets the two be told apart at all: both arrive as
   * painted segments rather than as distinguishable markup.
   */
  function pyLine(prompt: string, code: string, muted = false): TerminalSegment[] {
    return [
      { text: prompt, kind: muted ? "contprompt" : "prompt" },
      { text: code, kind: muted ? "muted" : "fixed" },
    ];
  }

  const pyTab: TerminalTab = {
    id: "py",
    label: "python",
    icon: ICONS.pySnake,
    multiline: true,
    placeholder: 'project="cordex"',
    ariaLabel: "databrowser keyword arguments",
    // Python's prompt geometry is the `>>>`/`...` gutter, not an inline prefix, so the editable
    // line carries no prefix of its own.
    prefix: () => [],
    headerLines: () => {
      const lines: TerminalSegment[][] = [
        pyLine(">>> ", "from freva_client import databrowser"),
        pyLine(">>> ", "databrowser("),
      ];
      // flavour + base scope are read-only continuation lines and always come FIRST.
      for (const line of pyFixedLines(ctx.state)) lines.push(pyLine("... ", `    ${line},`, true));
      return lines;
    },
    // The closing `)` is CODE (key-coloured, like `databrowser(`), but its `...` gutter is a
    // continuation, so the two halves of this line are deliberately not styled alike.
    footerLines: () => [
      [
        { text: "... ", kind: "contprompt" },
        { text: ")", kind: "fixed" },
      ],
    ],
    text: () => pyEditableLines(ctx.state),
    highlight: (text) => ({ segments: [{ text }] }),
    complete(text, caret) {
      const tok = pyToken(text, caret);
      if (!tok) return null;
      const q = tok.word.toLowerCase();
      const apply = (value: string): { text: string; caret: number } =>
        applyPy(text, caret, tok.word.length, tok.isValue, value);
      if (tok.isValue && CONTROL_HINT[tok.key]) {
        return { items: [], message: CONTROL_HINT[tok.key], apply };
      }
      const modes = tok.isValue ? controlValues(tok.key) : null;
      const cands = modes
        ? modes.filter((v) => v.startsWith(q))
        : tok.isValue
          ? candidateValues(tok.key).filter((v) => v.toLowerCase().startsWith(q))
          : keyCandidates(q);
      if (tok.isValue && tok.key && !modes) {
        enrichDebounce(() => void enrich(tok.key), ENRICH_DEBOUNCE_MS);
      }
      const best = cands
        .filter((c) => c.toLowerCase().startsWith(q) && c.length > tok.word.length)
        .sort((a, b) => a.length - b.length)[0];
      return {
        items: cands.slice(0, MAX_MENU_ITEMS).map((value) => ({ value, count: null })),
        ghost: tok.word && best ? best.slice(tok.word.length) : "",
        ghostValue: best,
        apply,
      };
    },
    commit(text, _caret, final) {
      // Unlike the CLI tab this one is intentionally laxer: no per-token warning line and no
      // withheld caret token. The debounce plus the shared commit guard absorb partial edits.
      const run = (): void => {
        ctx.applyTerminalDraft(parsePyConfig(text));
      };
      if (final) run();
      else pyDebounce(run, PY_COMMIT_DEBOUNCE_MS);
      return { dirty: false };
    },
    copyText: () => pythonCommand(ctx.state),
    revision: () => ctx.state.externalEdits,
  };

  const handle: TerminalHandle = createTerminal(ctx.roots.app, {
    tabs: [cliTab, pyTab],
    activeTab: ctx.state.terminalTab,
    os: os === "unknown" ? "mac" : os,
    bounds: () => ctx.roots.app,
    // The data browser renders its own immediate, styled tooltips from `data-tip` (see
    // components/tooltip.ts). Leaving the terminal on the native `title` would give every control
    // in the window two tooltips - ours and the browser's slow, unstyled one.
    tooltipAttribute: "data-tip",
    storage: {
      getTheme: () => loadTermTheme(),
      setTheme: (id) => saveTermTheme(id),
      getAlpha: () => loadTermAlpha(),
      setAlpha: (a) => saveTermAlpha(a),
    },
    fallback: () =>
      ctx.roots.app.dataset.terminalFallback === "true" ||
      (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches),
    menuItems: [
      { label: "How to install freva-client", onSelect: () => ctx.openHelp() },
      { label: "Documentation ↗", href: "https://freva-org.github.io/freva-nextgen/" },
    ],
    onTabChange: (id) => {
      ctx.state.terminalTab = id === "py" ? "py" : "cli";
    },
    onFocusChange: (focused) => {
      ctx.state.terminalFocused = focused;
    },
    onClose: () => {
      ctx.state.terminalFocused = false;
      (
        ctx.roots.app.querySelector('[aria-label="Command terminal"]') as HTMLElement | null
      )?.focus();
    },
    onCopyFailed: (message) => ctx.toast("error", message),
  });
  ctx.dis.add(() => handle.destroy());

  return {
    render(): void {
      // The result set changed since we last enriched -> the fuller value lists are stale (they
      // could suggest values that now return nothing). Drop them; they re-enrich on demand.
      if (ctx.state.facetsVersion !== lastEnrichVersion) {
        lastEnrichVersion = ctx.state.facetsVersion;
        enrichedValues.clear();
      }
      handle.render();
    },
    toggle(): void {
      handle.toggle();
    },
    isShown(): boolean {
      return handle.isShown();
    },
    destroy(): void {
      handle.destroy();
    },
  };
}
