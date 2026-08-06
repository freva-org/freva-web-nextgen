// components/terminal.ts - the smart CLI terminal. The token parser and copy are the load-bearing
// core; the highlight overlay and autocomplete are progressive enhancements that degrade to a plain
// textarea when forced via data-terminal-fallback or on a narrow viewport. Every token is escaped
// through escapeHtml before it reaches the overlay's innerHTML - the single sanctioned
// data->innerHTML path. Python is read-only.

import type { AppContext } from "../context.js";
import { el, escapeHtml, makeDebounce, replaceChildren, svgIcon } from "../dom.js";
import { ICONS, type IconName } from "../icons.js";
import {
  ADDITIONAL_FACET_FALLBACK,
  PRIMARY_FACET_FALLBACK,
  cliCommand,
  closedValueSet,
  filterCommittable,
  parseFacetTokens,
  terminalTokens,
  parsePyConfig,
  pyEditableLines,
  CONTROL_KEYS,
  SELECT_MODES,
  baseScopePairs,
  facetQueryStringExcluding,
  isGatedKey,
  knownFacetKeys,
  parseSolrFacetArray,
  pyFixedLines,
  pythonCommand,
  shellQuote,
  tokenizeRich,
  type TokenSegment,
} from "../state.js";
import { type AcItem } from "./autocomplete.js";
import { SHELLS, defaultShellFor, detectOS, type ShellId } from "../shell.js";
import { loadTermAlpha, loadTermTheme, saveTermAlpha, saveTermTheme } from "../theme.js";

const ENRICH_DEBOUNCE_MS = 160;

export interface TerminalController {
  render(): void;
  toggle(): void;
  isShown(): boolean;
}

interface Refs {
  cliLine: HTMLElement;
  input: HTMLTextAreaElement;
  hl: HTMLElement;
  extra: HTMLElement;
  warn: HTMLElement;
  py: HTMLElement;
  pyInput: HTMLTextAreaElement;
  pyHl: HTMLElement;
  pyGutter: HTMLElement;
  pyFixed: HTMLElement;
  cliView: HTMLElement;
  teMenu: HTMLElement;
  pyMenu: HTMLElement;
  menu: HTMLElement;
  bgPanel: HTMLElement;
  copy: HTMLButtonElement;
}

/** Clipboard fallback for plain-HTTP contexts (no async Clipboard API). Returns whether it copied,
 *  so the caller only reports success when the text really made it to the clipboard. */
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  try {
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    // document.execCommand('copy') is deprecated but kept as the fallback path.
    return typeof document.execCommand === "function" && !!document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove(); // never leave the scratch node (or its focus) behind
  }
}

/** A single keycap for the terminal hint (styled to look like a real key). */
function kbd(label: string): HTMLElement {
  return el("kbd", { text: label });
}
/** The keyboard hint as text + <kbd> keycaps, so the keys read as keys. Two states: the default
 *  guidance and the "armed" message shown after Esc (Tab will then leave - WCAG 2.1.2). */
function hintNodes(armed: boolean): (Node | string)[] {
  return armed
    ? [kbd("Tab \u21e5"), " now leaves the terminal \u00b7 type to keep completing"]
    : [
        kbd("Tab \u21e5"),
        " completes \u00b7 ",
        kbd("\u2193"),
        " lists all options \u00b7 ",
        kbd("Esc"),
        " then ",
        kbd("Tab \u21e5"),
        " to leave",
      ];
}

function known(ctx: AppContext): Set<string> {
  // (control keys are added below - they're valid tokens, just not facets)
  // Use the SAME key set the commit guard uses (knownFacetKeys - facets + attributeKeys
  // + primaryFacets, lowercased), so a key the guard would accept is never flagged "not a
  // facet" by the highlighter, and vice-versa.
  const k = new Set(knownFacetKeys(ctx.state));
  if (k.size) for (const c of CONTROL_KEYS) k.add(c);
  return k;
}

function allKeysForAutocomplete(ctx: AppContext): string[] {
  const k = known(ctx);
  const base = k.size ? [...k] : [...PRIMARY_FACET_FALLBACK, ...ADDITIONAL_FACET_FALLBACK];
  // time/bbox (+ their *_select modes) are first-class tokens, so they belong in the key list.
  const all = [...new Set([...base, ...CONTROL_KEYS])];
  // The base scope owns its key - it can't be typed, completed, or queried in the terminal.
  return all.filter((key) => !isGatedKey(ctx.state, key));
}

/** Guidance for the keys whose values can't be enumerated (they're typed, not chosen). */
const CONTROL_HINT: Record<string, string> = {
  bbox: "bbox=minLon,maxLon,minLat,maxLat - e.g. bbox=-10,10,35,60 · add bbox_select (defaults to flexible)",
  time: 'time="2000 TO 2010" - e.g. time="2000-01 TO 2010-12" · add time_select (defaults to flexible)',
};

/** The candidate VALUES for a control key: the *_select modes are a closed set; bbox/time are free. */
function controlValues(key: string): string[] | null {
  if (key === "bbox_select" || key === "time_select") return [...SELECT_MODES];
  return null;
}

function sampleValues(ctx: AppContext, key: string): AcItem[] {
  const facet = ctx.state.facets.find((f) => f.key === key);
  if (!facet) return [];
  return facet.values.map((v) => ({ value: v.value, count: v.count }));
}

export function createTerminal(ctx: AppContext): TerminalController {
  const dis = ctx.dis;
  const root = ctx.roots.cmdStrip; // the .cmd container
  buildSkeleton(root);

  const refs: Refs = {
    cliLine: must(root, ".cli-line"),
    input: must<HTMLTextAreaElement>(root, ".te-input"),
    hl: must(root, ".te-hl"),
    extra: must(root, ".te-extra"),
    warn: must(root, ".te-warn"),
    py: must(root, ".py-view"),
    pyInput: must<HTMLTextAreaElement>(root, ".py-input"),
    pyHl: must(root, ".py-hl"),
    pyGutter: must(root, ".py-gutter"),
    pyFixed: must(root, ".py-fixed"),
    cliView: must(root, ".cli-view"),
    teMenu: must(root, ".te-menu"),
    pyMenu: must(root, ".py-menu"),
    menu: must(root, ".term-menu"),
    bgPanel: must(root, ".term-bg-panel"),
    copy: must<HTMLButtonElement>(root, ".copy-btn"),
  };

  const enrichDebounce = makeDebounce(dis);
  let composing = false;

  // Tab belongs to the TERMINAL
  // In a real shell Tab always completes; it never throws you across the room. So while an input is
  // focused, Tab is ours - even when there's nothing to complete (it simply does nothing, rather
  // than teleporting focus somewhere else mid-typing).
  //
  // That must not become a keyboard trap (WCAG 2.1.2), so there are TWO keyboard-only ways out,
  // and the hint under the prompt advertises them (which is exactly what 2.1.2 requires):
  //   • Esc, then Tab   - Esc closes the menu/ghost and "arms" the exit; the next Tab leaves.
  //   • Shift+Tab       - always moves focus back, unconditionally.
  let tabArmed = false;
  const disarm = (): void => {
    tabArmed = false;
  };
  /** true -> this Tab keystroke should be allowed to move focus out. */
  function tabLeaves(ke: KeyboardEvent): boolean {
    if (ke.shiftKey) return true; // unconditional escape route
    if (tabArmed) {
      tabArmed = false;
      return true;
    } // Esc armed it
    return false;
  }
  function armTabExit(): void {
    tabArmed = true;
    setHint(true);
  }
  function setHint(armed: boolean): void {
    for (const h of root.querySelectorAll(".te-hint"))
      replaceChildren(h as HTMLElement, ...hintNodes(armed));
  }

  // in-terminal completion menu (shell-style, rendered INSIDE the window)
  // A real completion menu under the prompt - not a floating popover, which stacks behind the
  // fixed terminal window. Navigable, scrollable, and it grows the window instead of hiding.
  let menuItems: AcItem[] = [];
  let menuIndex = 0;
  let menuAccept: ((v: string) => void) | null = null;
  let menuHost: HTMLElement | null = null;
  const menuOpen = (): boolean => menuHost !== null && menuItems.length > 0;
  function renderMenu(): void {
    if (!menuHost) return;
    replaceChildren(menuHost);
    menuItems.forEach((it, i) => {
      const row = el(
        "div",
        { class: `tm-item${i === menuIndex ? " hl" : ""}`, role: "option", "data-i": String(i) },
        [
          el("span", { class: "tm-val", text: it.value }),
          it.count !== null
            ? el("span", { class: "tm-cnt", text: it.count.toLocaleString("en-US") })
            : false,
        ],
      );
      menuHost!.append(row);
    });
  }
  /** No candidates -> say so, rather than silently doing nothing (which reads as "broken"). */
  function showEmptyMenu(host: HTMLElement, msg: string): void {
    menuItems = [];
    menuIndex = 0;
    menuAccept = null;
    menuHost = host;
    replaceChildren(host, el("div", { class: "tm-item tm-empty", text: msg }));
    host.classList.add("show");
    placeMenu(host);
  }
  /**
   * Size and place an open menu. The terminal lives in the bottom-right corner, so a list rendered
   * below the caret is often off the bottom of the (scrolling) body and effectively invisible.
   * So: cap the list to the space actually available, and if that space is too small, FLIP it
   * above the prompt - which is what a real shell does when it completes at the bottom of a
   * screen. Then scroll it into view.
   */
  function placeMenu(host: HTMLElement): void {
    const body = must<HTMLElement>(root, ".term-body");
    const view = host.parentElement;
    const input = host === refs.pyMenu ? refs.pyInput : refs.input;
    const bodyBox = body.getBoundingClientRect();
    if (!view || bodyBox.height === 0) return; // not laid out (hidden / jsdom) - leave the default
    const inputBox = input.getBoundingClientRect();
    const below = bodyBox.bottom - inputBox.bottom - 10;
    const above = inputBox.top - bodyBox.top - 10;
    const MIN = 96;
    const flip = below < MIN && above > below; // no room under the caret, but there is room over it
    view.classList.toggle("menu-above", flip);
    const room = Math.max(MIN, Math.floor(flip ? above : below));
    host.style.maxHeight = `${Math.min(220, room)}px`;
    host.scrollIntoView?.({ block: "nearest" });
  }

  function showMenu(host: HTMLElement, items: AcItem[], onAccept: (v: string) => void): void {
    if (!items.length) {
      hideMenu();
      return;
    }
    // Preserve the highlighted VALUE across refreshes. A slow metadata-search (enrich) can land
    // mid-navigation and re-open the list; without this the index resets to 0, the selection
    // snaps back to the first row and ArrowDown appears broken.
    const prev = menuHost === host ? (menuItems[menuIndex]?.value ?? null) : null;
    menuItems = items;
    const at = prev === null ? -1 : items.findIndex((it) => it.value === prev);
    menuIndex = at >= 0 ? at : 0;
    menuAccept = onAccept;
    menuHost = host;
    renderMenu();
    host.classList.add("show");
    placeMenu(host);
  }
  function hideMenu(): void {
    if (menuHost) {
      menuHost.parentElement?.classList.remove("menu-above");
      menuHost.style.maxHeight = "";
      menuHost.classList.remove("show");
      replaceChildren(menuHost);
    }
    menuItems = [];
    menuIndex = 0;
    menuAccept = null;
    menuHost = null;
  }
  function moveMenu(d: number): void {
    if (!menuItems.length) return;
    menuIndex = (menuIndex + d + menuItems.length) % menuItems.length;
    renderMenu();
    const row = menuHost?.children[menuIndex] as HTMLElement | undefined;
    row?.scrollIntoView?.({ block: "nearest" }); // absent in jsdom/minimal DOMs
  }
  function acceptMenu(): void {
    const it = menuItems[menuIndex];
    const cb = menuAccept;
    hideMenu();
    if (it && cb) cb(it.value);
  }
  // click-to-pick (delegated once per host; mousedown so it beats the input blur)
  for (const host of [must(root, ".te-menu"), must(root, ".py-menu")]) {
    dis.listen(host, "mousedown", (e) => {
      const row = (e.target as HTMLElement).closest(".tm-item") as HTMLElement | null;
      if (!row) return;
      e.preventDefault();
      menuIndex = Number(row.dataset.i ?? "0");
      acceptMenu();
    });
  }

  // inline ghost autocomplete (unix-style, no dropdown)
  // As you type a token, the rest of the best match shows as dimmed "ghost" text right after the
  // caret (in the highlight overlay). Tab / -> / End accept it; typing more narrows it. Reuses the
  // same candidate logic (keys, sampled values, debounced metadata refinement) - just inline.
  let ghostChoice = "";
  let ghostSuffix = "";
  let ghostStart = -1;
  const enrichedValues = new Map<string, string[]>(); // facet -> fuller value list from metadata-search
  let lastEnrichVersion = -1; // the facetsVersion the enriched lists reflect; a change invalidates them

  // shell / OS / host
  // The command targets --host <api>, so it runs on the user's LOCAL machine -> the browser OS
  // picks the shell dialect. One shell per OS (PowerShell on Windows, bash otherwise); it's
  // display-only, so there's no switcher. An embedder can still pin it via config.terminal.shell.
  const os = ctx.cfg.terminal.os ?? detectOS();
  const shellId: ShellId = ctx.cfg.terminal.shell ?? defaultShellFor(os);
  // window controls follow the OS (macOS dots / Windows buttons / Linux symbolic)
  root.setAttribute("data-os", os === "unknown" ? "mac" : os);

  function renderCliLine(): void {
    const sh = SHELLS[shellId];
    replaceChildren(refs.cliLine);
    // separator spaces go BETWEEN spans, never after the last one - a trailing space plus the
    // indent pad adds up to a two-character gap before the first typed token.
    const push = (cls: string, text: string): void => {
      if (refs.cliLine.childNodes.length) refs.cliLine.append(document.createTextNode(" "));
      refs.cliLine.append(el("span", { class: cls, text }));
    };
    push("prompt", sh.prompt);
    push("fixed", "freva-client databrowser data-search");
    // --host is intentionally omitted: freva-client resolves the instance from its own config
    // (~/.config/freva/freva.toml) - see the info panel.
    if (ctx.state.flavour !== "freva") {
      push("fixed", "--flavour");
      push("term-flav", ctx.state.flavour);
    }
    // The base scope is invisible in the typed tokens, but it IS part of the query. Print it (dimmed,
    // read-only) so a user who copies this command into a real shell gets the SAME scoped results the
    // widget shows - rather than silently querying the whole archive.
    for (const [k, v] of baseScopePairs(ctx.state)) push("term-scope", `${k}=${sh.quote(v)}`);
    // no line-continuation glyph: the editable input continues this same line.
  }

  /**
   * Indent the input's first line past the painted prefix. If the prefix would eat most of the
   * width (long bbox + flavour on a narrow window), fall back to putting the input on its own
   * line rather than squeezing it into a sliver.
   */
  function syncIndent(): void {
    const row = must<HTMLElement>(root, ".cli-row");
    const prefix = must<HTMLElement>(root, ".cli-prefix");
    const rowW = row.clientWidth || 0;
    if (rowW === 0) return;
    // Measure the prefix's INTRINSIC width, not its laid-out width. In prefix-block mode the prefix
    // is display:block, so getBoundingClientRect would report the full row width - `tooWide` could
    // then never become false again and the input would stay stuck on its own line after enlarging.
    // Drop the class for the measurement (absolute + nowrap -> true text width), then decide.
    const wasBlock = row.classList.contains("prefix-block");
    if (wasBlock) row.classList.remove("prefix-block");
    const w = prefix.getBoundingClientRect().width;
    // A hidden view measures 0 (e.g. the python tab is active, or the terminal is closed). Writing
    // an indent of ~0 then would make the typed text overlap the painted prompt the next time bash
    // is shown - so keep the last good value and re-measure when the view is actually visible.
    if (w === 0) {
      if (wasBlock) row.classList.add("prefix-block");
      return;
    }
    const tooWide = w > rowW * 0.62;
    row.classList.toggle("prefix-block", tooWide); // prefix on its own line; input starts at col 0
    const indent = tooWide ? 0 : Math.ceil(w) + 8; // + exactly one space
    row.style.setProperty("--te-indent", `${indent}px`);
  }

  // the cli (shell) tab is labelled by the resolved shell
  {
    const label = root.querySelector('.cmd-tab[data-cmd="cli"] .tab-label');
    if (label) label.textContent = SHELLS[shellId].label;
  }

  const fallbackOn = (): boolean =>
    ctx.roots.app.dataset.terminalFallback === "true" ||
    (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches);

  // highlight overlay (escaped)
  // Consumes the SAME quote-aware segmentation as tokenize/parseFacetTokens, so an
  // accepted `ensemble="not set"` renders as ONE valid token, never two broken ones. Raw
  // text (quotes/escapes intact) is what gets rendered - the overlay must mirror the
  // textarea character-for-character - while validation runs on the cooked value.
  const CARET_HTML = '<span class="te-caret"></span>';
  function highlight(text: string): string {
    const k = known(ctx);
    const canValidateKeys = k.size > 0;
    let html = "";
    let warn = "";
    // The drawn cursor must sit where the REAL caret is - clicking mid-line moves the textarea's
    // caret, so the block has to move with it. We walk the raw segments, tracking the offset, and
    // split whichever piece contains the caret.
    const focused = document.activeElement === refs.input;
    const caretAt = focused ? (refs.input.selectionStart ?? text.length) : text.length;
    let pos = 0;
    let placed = false;
    const at = (raw: string, cls?: string): string => {
      const open = cls ? `<span class="${cls}">` : "";
      const close = cls ? "</span>" : "";
      if (!placed && caretAt >= pos && caretAt <= pos + raw.length) {
        const i = caretAt - pos;
        placed = true;
        pos += raw.length;
        return `${open}${escapeHtml(raw.slice(0, i))}${close}${CARET_HTML}${open}${escapeHtml(raw.slice(i))}${close}`;
      }
      pos += raw.length;
      return `${open}${escapeHtml(raw)}${close}`;
    };

    for (const seg of tokenizeRich(text)) {
      if (seg.kind === "ws") {
        html += at(seg.raw);
        continue;
      }
      const eq = seg.value.indexOf("=");
      if (eq < 0) {
        const ok =
          !canValidateKeys || [...k].some((key) => key.startsWith(seg.value.toLowerCase()));
        html += at(seg.raw, ok ? "k" : "bad");
        if (!ok && !warn) warn = `“${seg.value}” is not a facet`;
        continue;
      }
      const key = seg.value.slice(0, eq);
      const val = seg.value.slice(eq + 1);
      // split the RAW at its first '=' (keys never contain quotes, so raw and cooked agree
      // on the key side; everything after the first raw '=' is the value's raw form).
      const rawEq = seg.raw.indexOf("=");
      const keyRaw = rawEq < 0 ? seg.raw : seg.raw.slice(0, rawEq);
      const valRaw = rawEq < 0 ? "" : seg.raw.slice(rawEq + 1);
      const keyOk = !canValidateKeys || k.has(key.toLowerCase());
      html += at(keyRaw, keyOk ? "k" : "bad");
      if (rawEq >= 0) html += at("=", "eq");
      if (!keyOk && !warn) warn = `“${key}” is not a facet`;
      let valBad = false;
      if (keyOk && val) {
        const vs = closedValueSet(ctx.state, key.toLowerCase());
        if (vs && !vs.has(val)) {
          valBad = true;
          if (!warn) warn = `“${val}” isn’t a ${key} value`;
        }
      }
      html += at(valRaw, valBad ? "bad" : "v");
    }
    const showGhost = ghostSuffix && focused;
    refs.hl.innerHTML =
      (html || '<span class="fixed"></span>') +
      (showGhost ? `<span class="te-ghost">${escapeHtml(ghostSuffix)}</span>` : "") +
      (placed ? "" : CARET_HTML); // caret past the last segment (empty input / caret at the end)
    return warn;
  }

  function setWarn(msg: string): void {
    if (msg) {
      refs.warn.textContent = "⚠ " + msg;
      refs.warn.classList.add("show");
    } else {
      refs.warn.classList.remove("show");
    }
  }

  function fit(): void {
    // A hidden textarea reports scrollHeight 0, which would pin its height to 0px - that's the
    // collapsed writing area you get after switching back from the python tab. Skip, and re-fit
    // when the view is actually visible (activate/toggle call fit()).
    if (refs.input.offsetParent === null && refs.input.clientWidth === 0) return;
    refs.input.style.height = "auto";
    const h = refs.input.scrollHeight;
    if (h > 0) refs.input.style.height = `${h}px`;
  }

  // aux regions (always safe to rebuild)
  function renderAux(): void {
    // time/bbox are painted inline with the command as read-only tokens; repeating them here
    // would just duplicate the same values.
    refs.extra.textContent = "";
  }

  // caret ↔ token geometry (quote-aware, single grammar)
  /** The token segment the caret is touching (inside or at either edge), or null on whitespace. */
  function caretSegment(): TokenSegment | null {
    const v = refs.input.value;
    const c = refs.input.selectionStart ?? v.length;
    for (const seg of tokenizeRich(v)) {
      if (seg.kind !== "tok") continue;
      if (c >= seg.start && c <= seg.end) return seg;
    }
    return null;
  }
  function tokenBounds(): { start: number; typed: string } {
    const seg = caretSegment();
    const c = refs.input.selectionStart ?? refs.input.value.length;
    if (!seg) return { start: c, typed: "" };
    // `typed` is the cooked prefix up to the caret - for filtering suggestions. Quotes only
    // appear on values with whitespace, where the raw prefix is fine for prefix-matching.
    return { start: seg.start, typed: refs.input.value.slice(seg.start, c).replace(/"/g, "") };
  }
  function tokenEnd(start: number): number {
    for (const seg of tokenizeRich(refs.input.value)) {
      if (seg.kind === "tok" && seg.start === start) return seg.end;
    }
    return start;
  }

  function candidateValues(key: string): string[] {
    const cached = enrichedValues.get(key);
    return cached && cached.length ? cached : sampleValues(ctx, key).map((it) => it.value);
  }

  function computeGhost(): void {
    ghostChoice = "";
    ghostSuffix = "";
    ghostStart = -1;
    if (fallbackOn() || ctx.state.terminalTab !== "cli" || document.activeElement !== refs.input)
      return;
    const v = refs.input.value;
    const c = refs.input.selectionStart ?? v.length;
    if (c !== v.length || v.length === 0) return; // suggest only at the end of the line
    const { start, typed } = tokenBounds();
    if (!typed) return;
    const eq = typed.indexOf("=");
    if (eq < 0) {
      const q = typed.toLowerCase();
      const cand = allKeysForAutocomplete(ctx)
        .filter((k) => k.startsWith(q) && k.length > q.length)
        .sort((a, b) => a.length - b.length)[0];
      if (cand) {
        ghostChoice = cand;
        ghostSuffix = cand.slice(typed.length);
        ghostStart = start;
      }
    } else {
      const key = typed.slice(0, eq).toLowerCase();
      const q = typed.slice(eq + 1);
      const ql = q.toLowerCase();
      const cand = candidateValues(key)
        .filter((val) => val.toLowerCase().startsWith(ql) && val.length > q.length)
        .sort((a, b) => a.length - b.length)[0];
      if (cand) {
        ghostChoice = cand;
        ghostSuffix = cand.slice(q.length);
        ghostStart = start;
      }
      enrichDebounce(() => void enrich(key), ENRICH_DEBOUNCE_MS); // refine value list, then re-ghost
    }
  }

  // openAC refreshes the inline ghost.
  function openAC(): void {
    computeGhost();
    highlight(refs.input.value); // re-render overlay with (or without) the ghost
  }

  function acceptGhost(): boolean {
    if (!ghostChoice || ghostStart < 0) return false;
    const choice = ghostChoice;
    const start = ghostStart;
    ghostChoice = "";
    ghostSuffix = "";
    ghostStart = -1;
    accept(choice, start); // reuses the key/value insertion + commit path; re-ghosts after a key
    return true;
  }

  // The full candidate list for the current token - shown ON DEMAND (↓) for discovery, so a user
  // with no idea what's available can browse and pick, while the inline ghost handles the fast path.
  function currentItems(): { items: AcItem[]; start: number } {
    const { start, typed } = tokenBounds();
    const eq = typed.indexOf("=");
    if (eq < 0) {
      const q = typed.toLowerCase();
      const items = allKeysForAutocomplete(ctx)
        .filter((k) => k.startsWith(q))
        .slice(0, 60)
        .map((value) => ({ value, count: null }));
      return { items, start };
    }
    const key = typed.slice(0, eq).toLowerCase();
    const q = typed.slice(eq + 1).toLowerCase();
    const modes = controlValues(key);
    if (modes) {
      const items = modes.filter((v) => v.startsWith(q)).map((value) => ({ value, count: null }));
      return { items, start };
    }
    const sampleCounts = new Map(sampleValues(ctx, key).map((it) => [it.value, it.count]));
    const items = candidateValues(key)
      .filter((v) => v.toLowerCase().startsWith(q))
      .slice(0, 60)
      .map((value) => ({ value, count: sampleCounts.get(value) ?? null }));
    return { items, start };
  }
  /** The key under the caret, if it's one whose values must be TYPED (bbox/time). */
  function controlHintForCaret(): string | null {
    const { typed } = tokenBounds();
    const eq = typed.indexOf("=");
    if (eq < 0) return null;
    return CONTROL_HINT[typed.slice(0, eq).toLowerCase()] ?? null;
  }
  function openList(): void {
    if (fallbackOn() || ctx.state.terminalTab !== "cli") return hideMenu();
    // bbox/time have no listable values - say HOW to type them (and that *_select defaults to
    // flexible) instead of showing an unhelpful empty list.
    const hint = controlHintForCaret();
    if (hint) return showEmptyMenu(refs.teMenu, hint);
    const { items, start } = currentItems();
    if (!items.length) return showEmptyMenu(refs.teMenu, "(no matching values)");
    showMenu(refs.teMenu, items, (value) => accept(value, start));
  }

  // Refine a facet's value list via metadata-search, cache it, then recompute the active tab's
  // inline ghost (and list, if open).
  async function enrich(key: string): Promise<void> {
    if (isGatedKey(ctx.state, key)) return; // the base scope key is never completed -> never queried
    try {
      const signal = ctx.api.channelSignal("autocomplete");
      const res = await ctx.api.metadataSearch(
        ctx.state.flavour,
        ctx.state.uniqKey,
        facetQueryStringExcluding(ctx.state, key),
        signal,
      );
      const pairs = parseSolrFacetArray(res.facets[key] ?? []);
      if (pairs.length)
        enrichedValues.set(
          key,
          pairs.map(([value]) => value),
        );
      if (document.activeElement === refs.input) {
        computeGhost();
        highlight(refs.input.value);
        if (menuOpen()) openList();
      } else if (document.activeElement === refs.pyInput) {
        computePyGhost();
        renderPyOverlay();
        if (menuOpen()) openPyList();
      }
    } catch {
      /* slow / failed / aborted - the sampled ghost stays */
    }
  }

  function accept(choice: string, start: number): void {
    const v = refs.input.value;
    const end = tokenEnd(start);
    const isKey = !v.slice(start, end).includes("=");
    const insert = isKey ? `${choice}=` : choice + " ";
    // when accepting a value the token already holds "key="; replace whole token
    let newValue: string;
    let caret: number;
    if (isKey) {
      newValue = v.slice(0, start) + insert + v.slice(end);
      caret = start + insert.length;
    } else {
      const eq = v.indexOf("=", start);
      const key = v.slice(start, eq);
      // Quote values with whitespace (e.g. the real `not set`) so the tokenizer round-trips them
      // back to one token instead of `key=not` + a stray `set`.
      const tok = `${key}=${shellQuote(choice)} `;
      newValue = v.slice(0, start) + tok + v.slice(end);
      caret = start + tok.length;
    }
    refs.input.value = newValue;
    refs.input.setSelectionRange(caret, caret);
    applyFromInput();
    if (isKey) openAC();
    else hideMenu();
    refs.input.focus();
  }

  // the load-bearing core: parse + state
  // A keystroke NEVER commits the token under the caret - typing `variable=tas`
  // commits nothing until the token is completed by whitespace, Enter or blur. The commit
  // itself goes through ctx.applyTerminalDraft -> filterCommittable, which also drops values
  // failing a closed-value-set check, so partial/invalid values never reach the backend.
  //
  // `draftDirty`: true while the input holds content that could NOT be committed
  // (unknown key, invalid value, in-progress token, junk). While dirty, render() must NOT
  // rebuild the input from state - the user's raw draft (with its warning) stays visible
  // until they change it themselves.
  let draftDirty = false;

  /** The committable portion of the input: all tokens except (optionally) the caret token. */
  function committedText(commitCaretToken: boolean): string {
    const v = refs.input.value;
    if (commitCaretToken) return v;
    const seg = caretSegment();
    // only a caret at/inside a token that is NOT followed by whitespace is "in progress";
    // a caret sitting mid-string inside a token also excludes that token (spec: never the
    // token under the caret).
    if (!seg) return v;
    return v.slice(0, seg.start) + v.slice(seg.end);
  }

  function applyFromInput(commitCaretToken = false): void {
    let warn = highlight(refs.input.value);
    fit();
    const commit = committedText(commitCaretToken);
    // a malformed bbox/time says exactly WHY (4 numbers, lat ≤ 90, needs a TO range…) rather than
    // silently committing nothing.
    const controlErrs = ctx.terminalDraftErrors(commit);
    if (!warn && controlErrs.length) warn = controlErrs[0];
    setWarn(warn);
    const rejected = ctx.applyTerminalDraft(commit);
    // Dirty when: something was rejected by the guard, an in-progress token was withheld, the
    // highlighter warned, OR the committed text contains a token the parser drops silently -
    // a bare key or empty value like `project=` / `project`. Such an incomplete draft
    // must survive an external re-render instead of being overwritten by the committed state.
    const withheld = !commitCaretToken && commit !== refs.input.value;
    const hasIncompleteToken = tokenizeRich(commit).some((seg) => {
      if (seg.kind !== "tok") return false;
      const eq = seg.value.indexOf("=");
      return eq < 1 || seg.value.slice(eq + 1) === ""; // no '=', empty key, or empty value
    });
    draftDirty = rejected > 0 || withheld || warn !== "" || hasIncompleteToken;
  }

  // public render (external sync)
  let lastExternal = ctx.state.externalEdits;
  function render(): void {
    root.classList.toggle("fallback", fallbackOn());
    // The result set changed since we last enriched -> the fuller value lists are stale (they could
    // suggest values that now return nothing). Drop them; they re-enrich lazily on demand.
    if (ctx.state.facetsVersion !== lastEnrichVersion) {
      lastEnrichVersion = ctx.state.facetsVersion;
      enrichedValues.clear();
    }
    renderCliLine(); // shell/flavour-aware fixed prefix
    syncIndent(); // the input continues the SAME line, indented past the prefix
    renderAux();
    // An explicit UI action (Clear all, a chip, the map, the time panel) must be reflected in the
    // terminal even while it's focused. But a dirty draft still survives - so we MERGE: the
    // committed part is rebuilt from state, and the user's uncommitted tokens (rejected ones
    // + the in-progress token under the caret) are kept on the end.
    //
    // Without this, a half-typed `time=` survives a Clear all and, on the next keystroke, the
    // stale draft re-commits the very facets that were just cleared.
    const external = ctx.state.externalEdits !== lastExternal;
    lastExternal = ctx.state.externalEdits;

    if (external) {
      const keep = uncommittedText(refs.input.value);
      const focused = document.activeElement === refs.input;
      refs.input.value = [terminalTokens(ctx.state), keep].filter(Boolean).join(" ");
      if (focused) {
        const end = refs.input.value.length;
        refs.input.setSelectionRange(end, end); // carry on typing where the new text ends
      }
      setWarn(highlight(refs.input.value));
      fit();
      refs.pyInput.value = pyEditableLines(ctx.state);
    } else {
      // Otherwise only rebuild the editable text when not focused AND the draft is clean -
      // a dirty draft survives re-renders verbatim with its warning until the user edits it.
      if (document.activeElement !== refs.input && !draftDirty) {
        refs.input.value = terminalTokens(ctx.state);
        setWarn(highlight(refs.input.value));
        fit();
      }
      // Python re-syncs from state when it isn't the one being edited (last-edited drives).
      if (document.activeElement !== refs.pyInput) {
        refs.pyInput.value = pyEditableLines(ctx.state);
      }
    }
    renderPy();
  }

  /**
   * The parts of the input the state does NOT represent: tokens the guard rejected, plus the
   * in-progress token under the caret. These are what must survive an external re-sync.
   */
  function uncommittedText(text: string): string {
    const { rejected } = filterCommittable(ctx.state, parseFacetTokens(text));
    const keep = [...rejected];
    // the trailing token being typed (`time=`, `proj`) isn't committed yet - keep it too
    const trailing = /\S+$/.exec(text)?.[0] ?? "";
    if (trailing && !keep.includes(trailing)) {
      const parsedTrailing = parseFacetTokens(trailing);
      const committed =
        Object.keys(parsedTrailing).length &&
        !filterCommittable(ctx.state, parsedTrailing).rejected.length &&
        Object.values(parsedTrailing).every((vs) => vs.every(Boolean));
      if (!committed) keep.push(trailing);
    }
    return [...new Set(keep)].join(" ");
  }

  // wiring
  dis.listen(refs.input, "compositionstart", () => {
    composing = true;
  });
  dis.listen(refs.input, "compositionend", () => {
    composing = false;
    applyFromInput();
    openAC();
  });
  dis.listen(refs.input, "input", () => {
    if (tabArmed) {
      disarm();
      setHint(false);
    } // typing means you're still working in here
    if (composing) return;
    if (/[\n\r]/.test(refs.input.value)) {
      const pos = refs.input.selectionStart ?? 0;
      refs.input.value = refs.input.value.replace(/[\n\r]+/g, " ");
      refs.input.setSelectionRange(pos, pos);
    }
    applyFromInput();
    openAC();
    if (menuOpen()) openList(); // keep the browse-list in sync while typing
  });
  dis.listen(refs.input, "click", () => {
    openAC();
    highlight(refs.input.value);
  }); // caret moved
  dis.listen(refs.input, "select", () => highlight(refs.input.value));
  dis.listen(refs.input, "keyup", (e) => {
    const k = (e as KeyboardEvent).key;
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(k)) {
      openAC();
      highlight(refs.input.value);
    }
  });
  dis.listen(refs.input, "focus", () => {
    ctx.state.terminalFocused = true;
  });
  dis.listen(refs.input, "blur", () => {
    disarm();
    setHint(false);
    ctx.state.terminalFocused = false;
    applyFromInput(true); // blur completes the in-progress token
    dis.setTimeout(() => hideMenu(), 120);
  });
  dis.listen(refs.input, "keydown", (e) => {
    const ke = e as KeyboardEvent;
    const caretAtEnd = (refs.input.selectionStart ?? 0) === refs.input.value.length;
    // When the browse-list is open: arrow keys navigate, Enter/Tab accept, Esc closes.
    if (menuOpen()) {
      if (ke.key === "ArrowDown") {
        ke.preventDefault();
        moveMenu(1);
        return;
      }
      if (ke.key === "ArrowUp") {
        ke.preventDefault();
        moveMenu(-1);
        return;
      }
      if (ke.key === "Enter" || ke.key === "Tab") {
        ke.preventDefault();
        acceptMenu();
        return;
      }
      if (ke.key === "Escape") {
        ke.preventDefault();
        hideMenu();
        return;
      }
      return;
    }
    // ↓ opens the browsable list of options (discovery).
    if (ke.key === "ArrowDown") {
      ke.preventDefault();
      openList();
      return;
    }
    // Tab stays in the terminal unless the user armed the exit (Esc) or used Shift+Tab.
    if (ke.key === "Tab") {
      if (tabLeaves(ke)) {
        setHint(false);
        return;
      } // let the browser move focus
      ke.preventDefault();
      if (ghostChoice) acceptGhost();
      else openList(); // nothing to complete -> show what IS available; focus never moves
      return;
    }
    if (ghostChoice && (ke.key === "ArrowRight" || ke.key === "End") && caretAtEnd) {
      ke.preventDefault();
      acceptGhost();
      return;
    }
    if (ke.key === "Escape") {
      ke.preventDefault();
      armTabExit(); // Esc -> the next Tab leaves the terminal (advertised in the hint)
      ghostChoice = "";
      ghostSuffix = "";
      ghostStart = -1;
      highlight(refs.input.value);
      return;
    }
    if (ke.key === "Enter") {
      ke.preventDefault();
      applyFromInput(true); // Enter completes and commits the in-progress token
    }
  });

  // interactive Python session (multi-line kwargs)
  // The user edits the keyword args (one per line); it commits through the SAME guarded path as
  // bash (parsePyConfig -> key=value tokens -> ctx.applyTerminalDraft). Enter inserts a newline;
  // committing is debounced (the guard + selectionsEqual drop partial/invalid/duplicate edits).
  // NOTE: unlike the CLI, this tab does NOT withhold the in-progress token and has no
  // per-token .te-warn feedback - it's intentionally laxer; the debounce + commit guard absorb
  // partial edits, and re-sync only rewrites the buffer when the textarea isn't focused.
  const pyDebounce = makeDebounce(dis);
  let pyGhostSuffix = "";
  let pyGhostAt = -1;
  function pyGrow(): void {
    const lines = Math.max(1, refs.pyInput.value.split("\n").length);
    refs.pyGutter.textContent = Array.from({ length: lines }, () => "...").join("\n");
    refs.pyInput.style.height = "auto";
    refs.pyInput.style.height = `${refs.pyInput.scrollHeight}px`;
  }
  /** The text after the LAST top-level comma (quote/bracket aware) - i.e. the kwarg being typed. */
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
      else if (ch === "," && depth === 0) cut = i + 1; // a kwarg boundary
    }
    return before.slice(cut);
  }
  /**
   * The completion token at the caret. A line may carry SEVERAL kwargs
   * (`project="a", variable="b"`), so we look at the segment after the last top-level comma -
   * not the whole line.
   */
  function pyToken(): { word: string; isValue: boolean; key: string } | null {
    const v = refs.pyInput.value;
    const c = refs.pyInput.selectionStart ?? v.length;
    const next = v[c];
    // complete at the end of a kwarg only - not in the middle of a word
    if (next !== undefined && next !== "\n" && next !== ",") return null;
    const lineStart = v.lastIndexOf("\n", c - 1) + 1;
    const seg = lastKwargSegment(v.slice(lineStart, c));
    const eq = seg.indexOf("=");
    if (eq < 0) {
      const m = seg.match(/([\w-]*)$/);
      return { word: m ? m[1] : "", isValue: false, key: "" };
    }
    const key = seg.slice(0, eq).trim().replace(/["']/g, "");
    const m = seg.slice(eq + 1).match(/([^\s,"'[\]]*)$/);
    return { word: m ? m[1] : "", isValue: true, key };
  }
  function computePyGhost(): void {
    pyGhostSuffix = "";
    pyGhostAt = -1;
    if (ctx.state.terminalTab !== "py" || document.activeElement !== refs.pyInput) return;
    const tok = pyToken();
    if (!tok || !tok.word) return;
    const q = tok.word.toLowerCase();
    let cand: string | undefined;
    if (!tok.isValue) {
      cand = allKeysForAutocomplete(ctx)
        .filter((k) => k.startsWith(q) && k.length > q.length)
        .sort((a, b) => a.length - b.length)[0];
    } else {
      cand = candidateValues(tok.key)
        .filter((val) => val.toLowerCase().startsWith(q) && val.length > q.length)
        .sort((a, b) => a.length - b.length)[0];
      if (tok.key) enrichDebounce(() => void enrich(tok.key), ENRICH_DEBOUNCE_MS);
    }
    if (cand) {
      pyGhostSuffix = cand.slice(tok.word.length);
      pyGhostAt = refs.pyInput.selectionStart ?? refs.pyInput.value.length;
    }
  }
  function renderPyOverlay(): void {
    const v = refs.pyInput.value;
    const focused = document.activeElement === refs.pyInput;
    const caret = '<span class="te-caret"></span>'; // always blinking - see highlight()
    const at = focused ? (refs.pyInput.selectionStart ?? v.length) : v.length;
    if (pyGhostSuffix && pyGhostAt >= 0 && focused) {
      refs.pyHl.innerHTML =
        escapeHtml(v.slice(0, pyGhostAt)) +
        caret +
        `<span class="py-ghost">${escapeHtml(pyGhostSuffix)}</span>` +
        escapeHtml(v.slice(pyGhostAt));
    } else {
      refs.pyHl.innerHTML = escapeHtml(v.slice(0, at)) + caret + escapeHtml(v.slice(at));
    }
  }
  /**
   * Insert a python completion - writing REAL python either way:
   *   key   -> `project=`      (ready for the value)
   *   value -> `"cordex",`     (quoted + comma, absorbing a quote already typed)
   * Tab and the menu both come through here, so they cannot produce different text.
   */
  function insertPyCompletion(
    value: string,
    isValue: boolean,
    caretAt: number,
    wordLen: number,
  ): void {
    const v = refs.pyInput.value;
    let start = caretAt - wordLen;
    let insert: string;
    if (!isValue) {
      insert = `${value}=`;
    } else {
      if (v[start - 1] === '"' || v[start - 1] === "'") start--; // absorb the opening quote
      insert = `${JSON.stringify(value)},`;
    }
    refs.pyInput.value = v.slice(0, start) + insert + v.slice(caretAt);
    const caret = start + insert.length;
    refs.pyInput.setSelectionRange(caret, caret);
    pyGhostSuffix = "";
    pyGhostAt = -1;
    pyGrow();
    computePyGhost();
    renderPyOverlay();
    pyCommit();
  }

  function acceptPyGhost(): boolean {
    if (!pyGhostSuffix || pyGhostAt < 0) return false;
    const tok = pyToken();
    if (!tok) return false;
    const full = tok.word + pyGhostSuffix; // the completed key/value
    insertPyCompletion(full, tok.isValue, pyGhostAt, tok.word.length);
    return true;
  }
  function openPyList(): boolean {
    const tok = pyToken();
    if (!tok) {
      hideMenu();
      return false;
    }
    const q = tok.word.toLowerCase();
    if (tok.isValue && CONTROL_HINT[tok.key]) {
      showEmptyMenu(refs.pyMenu, CONTROL_HINT[tok.key]); // typed, not chosen - show how
      return false;
    }
    const modes = tok.isValue ? controlValues(tok.key) : null;
    const cands = modes
      ? modes.filter((v) => v.startsWith(q))
      : tok.isValue
        ? candidateValues(tok.key).filter((v) => v.toLowerCase().startsWith(q))
        : allKeysForAutocomplete(ctx).filter((k) => k.startsWith(q));
    const items = cands.slice(0, 60).map((value) => ({ value, count: null }));
    if (!items.length) {
      showEmptyMenu(refs.pyMenu, tok.isValue ? "(no matching values)" : "(no matching keys)");
      return false; // shown, but nothing to accept -> Tab must not be trapped
    }
    const c = refs.pyInput.selectionStart ?? refs.pyInput.value.length;
    const wordLen = tok.word.length;
    const isValue = tok.isValue;
    showMenu(refs.pyMenu, items, (value) => {
      insertPyCompletion(value, isValue, c, wordLen); // exactly the same path Tab takes
      refs.pyInput.focus();
    });
    return true;
  }
  function pyCommit(): void {
    ctx.applyTerminalDraft(parsePyConfig(refs.pyInput.value));
    renderPy();
  }
  /** The editable line only exists once you're in it (or it has content) - so the closing `)` sits
   *  right under the last written kwarg, like a real session. `pyOpen` is explicit:
   *  a hidden element cannot take focus, so the line must be SHOWN before focus() is called. */
  let pyOpen = true; // the prompt line always exists - the blinking cursor has to live somewhere
  function syncPyLine(): void {
    const active =
      pyOpen || refs.pyInput.value.length > 0 || document.activeElement === refs.pyInput;
    (refs.pyInput.closest(".py-ml") as HTMLElement | null)?.style.setProperty(
      "display",
      active ? "flex" : "none",
    );
  }
  /** Open the prompt line and put the cursor in it (show FIRST, then focus). */
  function focusPy(): void {
    pyOpen = true;
    syncPyLine();
    if (!fallbackOn()) refs.pyInput.focus();
  }
  function renderPy(): void {
    pyGrow();
    renderPyOverlay();
    syncPyLine();
    // flavour / time / bbox are read-only continuation lines and ALWAYS come first; no host and no
    // len()/list() echo - the results panel already shows the outcome.
    replaceChildren(refs.pyFixed);
    const fixed = pyFixedLines(ctx.state); // flavour only - time/bbox are editable kwargs
    refs.pyFixed.style.display = fixed.length ? "" : "none";
    for (const line of fixed) {
      refs.pyFixed.append(
        el("div", { class: "py-line cont py-fixedline" }, [
          el("span", { class: "py-prompt", text: "... " }),
          el("span", { class: "py-code py-ro", text: `    ${line},` }),
        ]),
      );
    }
  }

  dis.listen(refs.pyInput, "input", () => {
    if (tabArmed) {
      disarm();
      setHint(false);
    }
    pyGrow();
    syncPyLine();
    computePyGhost();
    renderPyOverlay();
    if (menuOpen()) openPyList();
    pyDebounce(pyCommit, 200);
  });
  dis.listen(refs.pyInput, "click", () => {
    computePyGhost();
    renderPyOverlay();
  });
  dis.listen(refs.pyInput, "keyup", (e) => {
    if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(
        (e as KeyboardEvent).key,
      )
    ) {
      computePyGhost();
      renderPyOverlay();
    }
  });
  dis.listen(refs.pyInput, "keydown", (e) => {
    const ke = e as KeyboardEvent;
    const v = refs.pyInput.value;
    const c = refs.pyInput.selectionStart ?? 0;
    const atLineEnd = c === v.length || v[c] === "\n";
    if (menuOpen()) {
      if (ke.key === "ArrowDown") {
        ke.preventDefault();
        moveMenu(1);
        return;
      }
      if (ke.key === "ArrowUp") {
        ke.preventDefault();
        moveMenu(-1);
        return;
      }
      if (ke.key === "Enter" || ke.key === "Tab") {
        ke.preventDefault();
        acceptMenu();
        return;
      }
      if (ke.key === "Escape") {
        ke.preventDefault();
        hideMenu();
        return;
      }
      return;
    }
    // ↓ opens the browse-list of options when there's no line below the caret (the typing spot);
    // otherwise ↓ moves the caret between kwarg lines as usual.
    if (ke.key === "ArrowDown" && v.slice(c).indexOf("\n") < 0) {
      if (openPyList()) ke.preventDefault();
      return;
    }
    // Tab stays in the terminal unless the user armed the exit (Esc) or used Shift+Tab.
    if (ke.key === "Tab") {
      if (tabLeaves(ke)) {
        setHint(false);
        return;
      }
      ke.preventDefault();
      if (pyGhostSuffix) acceptPyGhost();
      else openPyList(); // nothing to complete -> show what IS available; focus stays put
      return;
    }
    if ((ke.key === "ArrowRight" || ke.key === "End") && atLineEnd && pyGhostSuffix) {
      ke.preventDefault();
      acceptPyGhost();
      return;
    }
    if (ke.key === "Escape") {
      ke.preventDefault();
      armTabExit(); // Esc -> the next Tab leaves the terminal (advertised in the hint)
      pyGhostSuffix = "";
      pyGhostAt = -1;
      renderPyOverlay();
    }
  });
  dis.listen(refs.pyInput, "blur", () => {
    pyGhostSuffix = "";
    pyGhostAt = -1;
    renderPyOverlay();
    syncPyLine();
    pyCommit();
    dis.setTimeout(() => hideMenu(), 120);
  });
  dis.listen(refs.pyInput, "focus", () => {
    syncPyLine();
    renderPyOverlay();
  });

  // tabs: activate, close (×), reopen (+)
  const openTabs = new Set<"cli" | "py">(["cli", "py"]); // both open by default
  function syncTabsUI(): void {
    root.querySelectorAll<HTMLElement>(".cmd-tab").forEach((t) => {
      const cmd = (t.dataset.cmd as "cli" | "py") ?? "cli";
      t.style.display = openTabs.has(cmd) ? "" : "none";
      const active = ctx.state.terminalTab === cmd;
      t.classList.toggle("on", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    refs.cliView.style.display = ctx.state.terminalTab === "cli" ? "" : "none";
    refs.py.style.display = ctx.state.terminalTab === "py" ? "" : "none";
    const addBtn = must<HTMLButtonElement>(root, ".term-add");
    addBtn.style.display = openTabs.size < 2 ? "" : "none";
  }
  function activate(mode: "cli" | "py"): void {
    if (!openTabs.has(mode)) return;
    ctx.state.terminalTab = mode;
    syncTabsUI();
    if (mode === "cli") {
      syncIndent();
      fit();
      if (!fallbackOn()) refs.input.focus();
    } // measure now it's visible
    else {
      hideMenu();
      renderPy();
      focusPy();
    }
  }
  function closeTab(mode: "cli" | "py"): void {
    openTabs.delete(mode);
    if (openTabs.size === 0) {
      // closing the LAST tab closes the whole terminal window; restore both for the next open
      openTabs.add("cli");
      openTabs.add("py");
      ctx.state.terminalTab = "cli";
      syncTabsUI();
      root.classList.remove("show");
      hideMenu();
      (
        ctx.roots.app.querySelector('[aria-label="Command terminal"]') as HTMLElement | null
      )?.focus();
      return;
    }
    if (ctx.state.terminalTab === mode) ctx.state.terminalTab = [...openTabs][0];
    syncTabsUI();
  }
  function reopenMissing(): void {
    const missing = (["cli", "py"] as const).find((m) => !openTabs.has(m));
    if (!missing) return;
    openTabs.add(missing);
    activate(missing);
  }
  const tabActivate = new Map<HTMLElement, () => void>();
  root.querySelectorAll<HTMLElement>(".cmd-tab").forEach((tab) => {
    const mode = (tab.dataset.cmd as "cli" | "py") ?? "cli";
    tabActivate.set(tab, () => activate(mode));
    dis.listen(tab, "click", (e) => {
      if ((e.target as HTMLElement).closest(".tab-x")) {
        closeTab(mode);
        return;
      }
      activate(mode);
    });
    dis.listen(tab, "keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === "Enter" || k === " ") {
        e.preventDefault();
        activate(mode);
      }
    });
    const x = tab.querySelector(".tab-x");
    if (x)
      dis.listen(x, "keydown", (e) => {
        const k = (e as KeyboardEvent).key;
        if (k === "Enter" || k === " ") {
          e.preventDefault();
          closeTab(mode);
        }
      });
  });
  dis.listen(must(root, ".term-add"), "click", () => reopenMissing());
  syncTabsUI();

  // traffic lights
  dis.listen(must(root, ".tl.close"), "click", () => {
    root.classList.remove("show");
    hideMenu();
    (ctx.roots.app.querySelector('[aria-label="Command terminal"]') as HTMLElement | null)?.focus();
  });
  // Minimize docks the window to the bottom-right as a title-bar strip (Gmail-style): position is
  // handed back to CSS so the dock is always in the corner, and the pre-dock geometry is restored
  // on un-minimize. Maximize likewise expands from wherever it is and restores exactly.
  let placement: { left: string; top: string; width: string; height: string } | null = null;
  function stash(): void {
    placement = {
      left: root.style.left,
      top: root.style.top,
      width: root.style.width,
      height: root.style.height,
    };
  }
  function toCorner(): void {
    root.style.left = "";
    root.style.top = "";
    root.style.right = "";
    root.style.bottom = "";
    root.style.transform = "";
    root.style.width = "";
    root.style.height = "";
  }
  function restore(): void {
    if (!placement) return;
    root.style.left = placement.left;
    root.style.top = placement.top;
    root.style.width = placement.width;
    root.style.height = placement.height;
    if (placement.left) {
      root.style.right = "auto";
      root.style.bottom = "auto";
      root.style.transform = "none";
    }
    placement = null;
  }
  dis.listen(must(root, ".tl.min"), "click", () => {
    const min = root.classList.toggle("minimized");
    root.classList.remove("zoomed");
    if (min) {
      stash();
      toCorner();
      hideMenu();
    } else {
      restore();
    }
  });
  dis.listen(must(root, ".tl.zoom"), "click", () => {
    const zoom = root.classList.toggle("zoomed");
    root.classList.remove("minimized");
    if (zoom) {
      stash();
      toCorner();
    } else {
      restore();
    }
  });
  // A docked window re-opens by clicking its bar (Gmail).
  dis.listen(must(root, ".term-bar"), "click", (e) => {
    if (!root.classList.contains("minimized")) return;
    if ((e.target as HTMLElement).closest(".tl")) return;
    if (dockMoved) {
      dockMoved = false;
      return;
    } // that press was a drag, not a click - stay docked
    root.classList.remove("minimized");
    restore();
  });

  // floating window: drag by the bar, resize by the corner
  // position/size are inline styles on the .cmd root; zoomed/minimized are CSS classes that
  // override them. Dragging clears the zoom. Kept off the CLI parsing core entirely.
  let drag: { dx: number; dy: number; started: boolean } | null = null;
  let rez: { x: number; y: number; w: number; h: number } | null = null;
  // Minimized dock: a HORIZONTAL-only drag (the dock stays pinned to the bottom). `dockMoved`
  // remembers that the last press was a drag, so the bar's click handler doesn't also re-open it.
  let mdock: { startX: number; startRight: number; moved: boolean } | null = null;
  let dockMoved = false;
  const bar = must(root, ".term-bar");
  dis.listen(bar, "mousedown", (e) => {
    const me = e as MouseEvent;
    // every interactive control in the bar must be excluded, or a small movement while pressing it
    // drags the window.
    if (
      (me.target as HTMLElement).closest(
        ".tl, .cmd-tab, .copy-btn, .term-kebab, .term-add, .term-menu",
      )
    )
      return;
    // Maximized windows don't move (Gmail): dragging one yanks it out of its !important layout,
    // so it snaps small and jumps to the top-left. Un-maximize first - close/minimize/restore
    // still work.
    if (root.classList.contains("zoomed")) return;
    // Minimized dock moves HORIZONTALLY only, so it can be slid aside (e.g. off the details panel)
    // while staying pinned to the bottom. A plain press with no movement stays a click (re-open).
    if (root.classList.contains("minimized")) {
      const r = root.getBoundingClientRect();
      mdock = { startX: me.clientX, startRight: window.innerWidth - r.right, moved: false };
      dockMoved = false;
      me.preventDefault();
      return;
    }
    const r = root.getBoundingClientRect();
    drag = { dx: me.clientX - r.left, dy: me.clientY - r.top, started: false }; // arm; move pins it
    me.preventDefault();
  });
  const resize = must(root, ".term-resize");
  dis.listen(resize, "mousedown", (e) => {
    const me = e as MouseEvent;
    const r = root.getBoundingClientRect();
    rez = { x: me.clientX, y: me.clientY, w: r.width, h: r.height };
    me.preventDefault();
    me.stopPropagation();
  });
  dis.listen(window, "mousemove", (e) => {
    const me = e as MouseEvent;
    if (drag) {
      if (!drag.started) {
        // First actual move: pin to the current visual box and kill the centering transform
        // INLINE (so the window never shifts by half its width). A plain click never gets here.
        const r = root.getBoundingClientRect();
        root.classList.remove("zoomed");
        root.style.transform = "none";
        root.style.right = "auto";
        root.style.bottom = "auto";
        root.style.left = `${r.left}px`;
        root.style.top = `${r.top}px`;
        drag.started = true;
      }
      // All four edges are hard walls: the window stays fully on the page, so it can never be
      // dragged (even partly) out of reach.
      const r = root.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - r.width);
      const maxTop = Math.max(0, window.innerHeight - r.height);
      const x = Math.min(maxLeft, Math.max(0, me.clientX - drag.dx));
      const y = Math.min(maxTop, Math.max(0, me.clientY - drag.dy));
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;
    } else if (mdock) {
      // Horizontal only: update --dock-right (CSS keeps bottom:0). Right grows as the pointer moves
      // left, so the dock tracks the cursor. Clamped so it can never leave the viewport.
      const dx = me.clientX - mdock.startX;
      if (!mdock.moved && Math.abs(dx) > 3) {
        mdock.moved = true;
        dockMoved = true;
      }
      if (mdock.moved) {
        const width = root.getBoundingClientRect().width || 300;
        const maxRight = Math.max(0, window.innerWidth - width);
        const right = Math.min(maxRight, Math.max(0, mdock.startRight - dx));
        root.style.setProperty("--dock-right", `${right}px`);
      }
    } else if (rez) {
      const r = root.getBoundingClientRect();
      const maxW = Math.max(360, window.innerWidth - r.left - 8); // never grow past the right edge
      const maxH = Math.max(220, window.innerHeight - r.top - 8); // …or the bottom edge
      root.style.width = `${Math.min(maxW, Math.max(360, rez.w + (me.clientX - rez.x)))}px`;
      root.style.height = `${Math.min(maxH, Math.max(220, rez.h + (me.clientY - rez.y)))}px`;
    }
  });
  dis.listen(window, "mouseup", () => {
    drag = null;
    rez = null;
    mdock = null;
  });
  // the prefix indent AND the input's own wrapped height depend on the available width - re-measure
  // both when the window/terminal resizes, so widening pulls the cursor back onto the prompt line
  dis.listen(window, "resize", () => {
    if (root.classList.contains("show")) {
      syncIndent();
      fitBar();
      fit();
    }
  });
  /** Narrow WINDOW (not viewport): drop the tab labels before the window controls get pushed out. */
  function fitBar(): void {
    const w = root.getBoundingClientRect().width;
    if (w > 0) root.classList.toggle("narrow", w < 460);
  }
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => {
      fitBar();
      syncIndent();
      fit();
    });
    ro.observe(root);
    dis.add(() => ro.disconnect());
  }

  // copy (works in fallback too - derives from state, not the overlay)
  dis.listen(refs.copy, "click", () => {
    const text =
      ctx.state.terminalTab === "cli"
        ? cliCommand(ctx.state, { shell: shellId })
        : pythonCommand(ctx.state);
    const word = must<HTMLElement>(refs.copy, ".cb-word");
    const caret = must<HTMLElement>(refs.copy, ".cb-caret");
    const done = (): void => {
      refs.copy.classList.add("done");
      caret.textContent = "\u2713";
      word.textContent = "copied";
      dis.setTimeout(() => {
        refs.copy.classList.remove("done");
        caret.textContent = "\u276f";
        word.textContent = "copy";
      }, 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => {
        if (!legacyCopy(text)) ctx.toast("error", "Copy failed - select and copy manually.");
        else done();
      });
    } else if (legacyCopy(text)) {
      done();
    } else {
      // plain-HTTP with no Clipboard API and no execCommand: DON'T claim "copied" when nothing was.
      ctx.toast("error", "Copy failed - select and copy manually.");
    }
  });

  // click anywhere in the body focuses the prompt (it's a terminal, not a form)
  dis.listen(must(root, ".term-body"), "mousedown", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".tm-item, .term-info, .term-bg-panel, a, button, textarea")) return;
    e.preventDefault(); // take the caret without stealing the selection
    if (fallbackOn()) return;
    if (ctx.state.terminalTab === "py") focusPy();
    else refs.input.focus();
  });

  const kebabBtn = must<HTMLButtonElement>(root, ".term-kebab");
  const closePanels = (): void => {
    refs.menu.classList.remove("show");
    kebabBtn.setAttribute("aria-expanded", "false");
  };
  dis.listen(kebabBtn, "click", (e) => {
    e.stopPropagation();
    const open = refs.menu.classList.toggle("show");
    kebabBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  // the install guide lives in the app-level Help panel - findable without opening a terminal
  dis.listen(refs.menu, "click", (e) => {
    const item = (e.target as HTMLElement).closest(".tmn-item") as HTMLElement | null;
    if (item?.dataset.act === "help") {
      closePanels();
      ctx.openHelp();
    }
  });
  dis.listen(document, "mousedown", (e) => {
    if (!refs.menu.classList.contains("show")) return;
    const t = e.target as HTMLElement;
    if (t.closest(".term-menu, .term-kebab")) return;
    closePanels();
  });

  // terminal background colour, persisted
  // A small palette rather than a free colour picker: each preset ships its own foreground, so the
  // text can never end up unreadable on the chosen background.
  const TERM_THEMES: Array<{ id: string; label: string; bg: string; fg: string; light?: boolean }> =
    [
      { id: "black", label: "Black", bg: "#0b0f16", fg: "#d8e2f2" },
      { id: "ink", label: "Ink", bg: "#131a26", fg: "#d8e2f2" },
      { id: "graphite", label: "Graphite", bg: "#22262b", fg: "#e4e7ea" },
      { id: "midnight", label: "Midnight", bg: "#0d1b2a", fg: "#cfe3f7" },
      { id: "forest", label: "Forest", bg: "#10201a", fg: "#cfe9d9" },
      { id: "plum", label: "Plum", bg: "#1d1526", fg: "#e6d7f2" },
      { id: "paper", label: "Paper", bg: "#f4f1ea", fg: "#22262b", light: true },
    ];
  function applyTermTheme(id: string): void {
    const t = TERM_THEMES.find((x) => x.id === id) ?? TERM_THEMES[0];
    root.style.setProperty("--term-bg", t.bg);
    root.style.setProperty("--term-fg", t.fg);
    // a light background needs the WHOLE token palette flipped (keys/values/prompt/ghost/hint),
    // not just the text colour - otherwise the light preset is unreadable.
    root.setAttribute("data-term-light", t.light ? "true" : "false");
    root.querySelectorAll<HTMLElement>(".bg-sw").forEach((sw) => {
      const on = sw.dataset.bg === t.id;
      sw.classList.toggle("on", on);
      sw.setAttribute("aria-selected", on ? "true" : "false");
    });
    saveTermTheme(t.id); // survives reload / a new window
  }
  for (const t of TERM_THEMES) {
    refs.bgPanel.append(
      el("button", {
        class: "bg-sw",
        type: "button",
        role: "option",
        "data-bg": t.id,
        title: t.label,
        "aria-label": t.label,
        style: `background:${t.bg}`,
      }),
    );
  }
  dis.listen(refs.bgPanel, "click", (e) => {
    const sw = (e.target as HTMLElement).closest(".bg-sw") as HTMLElement | null;
    if (sw?.dataset.bg) applyTermTheme(sw.dataset.bg);
  });
  // opacity: a hint of the page behind the window, without hurting legibility
  const alphaEl = must<HTMLInputElement>(root, ".term-alpha");
  function applyAlpha(a: number, persist = true): void {
    const v = Math.min(1, Math.max(0.55, a)); // never so transparent that the text stops working
    root.style.setProperty("--term-alpha", String(v));
    alphaEl.value = String(v);
    if (persist) saveTermAlpha(v);
  }
  dis.listen(alphaEl, "input", () => applyAlpha(Number(alphaEl.value)));
  applyTermTheme(loadTermTheme() ?? "black"); // default stays black
  applyAlpha(loadTermAlpha() ?? 0.85, false); // enough to sense the page behind it; the slider tunes it

  return {
    render,
    toggle(): void {
      const showing = root.classList.toggle("show");
      if (showing) {
        root.classList.remove("minimized");
        render();
        syncIndent(); // the prefix is only measurable once the window is actually on screen
        fit(); // …and so is the textarea's height
        if (ctx.state.terminalTab === "cli" && !fallbackOn()) refs.input.focus();
      } else {
        hideMenu();
        closePanels();
      }
    },
    isShown(): boolean {
      return root.classList.contains("show");
    },
  };
}

// Static skeleton (no dynamic data -> safe constants only; built via el()).
function buildSkeleton(root: HTMLElement): void {
  root.classList.add("cmd");

  const tl = (cls: string, label: string, glyph: string): HTMLButtonElement =>
    el("button", { class: `tl ${cls}`, type: "button", title: label, "aria-label": label }, [
      el("span", { text: glyph }),
    ]);

  // Real tabs: icon + name + close, in a tab-shaped chip.
  const mkTab = (cmd: "cli" | "py", label: string, icon: IconName, on: boolean): HTMLElement => {
    const x = el("span", {
      class: "tab-x",
      role: "button",
      tabindex: "0",
      "aria-label": `Close ${label} tab`,
      title: `Close ${label}`,
      text: "\u00d7",
    });
    return el(
      "span",
      { class: `cmd-tab${on ? " on" : ""}`, "data-cmd": cmd, role: "tab", tabindex: "0" },
      [
        el("span", { class: "tab-ic", "aria-hidden": "true" }, [
          svgIcon(ICONS[icon], { size: 13 }),
        ]),
        el("span", { class: "tab-label", text: label }),
        x,
      ],
    );
  };
  const cliTab = mkTab("cli", "bash", "bashTab", true);
  const pyTab = mkTab("py", "python", "pySnake", false);
  const addBtn = el("button", {
    class: "term-add",
    type: "button",
    title: "Reopen closed tab",
    "aria-label": "Reopen closed tab",
    text: "+",
  });

  // A labelled [copy] button - an icon on its own reads as "maximise" and misleads.
  // Reads like something you'd TYPE, not a chrome widget: `❯ copy` -> `✓ copied`.
  const copy = el(
    "button",
    { class: "copy-btn", type: "button", title: "Copy command", "aria-label": "Copy command" },
    [
      el("span", { class: "cb-caret", text: "\u276f" }),
      el("span", { class: "cb-word", text: "copy" }),
    ],
  );
  // One overflow (⋮) menu instead of two competing glyphs - settings live behind it.
  const kebab = el(
    "button",
    {
      class: "term-kebab",
      type: "button",
      title: "Terminal settings",
      "aria-label": "Terminal settings",
      "aria-haspopup": "true",
      "aria-expanded": "false",
    },
    [svgIcon(ICONS.kebab, { size: 14 })],
  );

  const bar = el("div", { class: "term-bar" }, [
    el("span", { class: "traffic" }, [
      tl("close", "Close", "\u2715"),
      tl("min", "Minimize", "\u2013"),
      tl("zoom", "Maximize", "+"),
    ]),
    cliTab,
    pyTab,
    addBtn,
    el("div", { class: "spacer" }),
    copy,
    kebab,
  ]);

  const cliLine = el("div", { class: "cli-line" }); // rebuilt per shell/flavour (renderCliLine)

  const input = el("textarea", {
    class: "te-input",
    rows: "1",
    spellcheck: "false",
    autocapitalize: "off",
    autocomplete: "off",
    "aria-label": "Command facets",
    placeholder: "project=cmip6 variable=tas",
  });

  const edit = el("div", { class: "term-edit" }, [
    el("div", { class: "te-wrap" }, [el("pre", { class: "te-hl", "aria-hidden": "true" }), input]),
  ]);

  // The prompt/command/read-only tokens are painted at the START of the same line as the input; the
  // input's FIRST line is then indented past them (measured at render). A flex row would give the
  // input its own narrow column on the right; with text-indent, typing continues the command and
  // wrapped lines fall back to the left margin - exactly like a real shell.
  const cliRow = el("div", { class: "cli-row" }, [
    el("span", { class: "cli-prefix", "aria-hidden": "true" }, [cliLine]),
    edit,
  ]);

  const cliView = el("div", { class: "cli-view" }, [
    cliRow,
    el("div", { class: "te-menu", role: "listbox" }),
    el("div", { class: "te-extra" }),
    el("div", { class: "te-warn", role: "alert" }),
  ]);

  // Interactive Python session: the natural call form. No `db =`, no host, no
  // len()/list() echo - the results panel already shows the outcome. flavour/time/bbox render as
  // read-only continuation lines FIRST; the editable kwargs follow; `)` closes the last line.
  const pyInput = el("textarea", {
    class: "py-input",
    rows: "1",
    spellcheck: "false",
    autocapitalize: "off",
    autocomplete: "off",
    "aria-label": "databrowser keyword arguments",
    placeholder: 'project="cordex"',
  }) as HTMLTextAreaElement;
  const pyGutter = el("div", { class: "py-gutter", "aria-hidden": "true" });
  const pyHl = el("pre", { class: "py-hl", "aria-hidden": "true" });
  const pyLine = (code: string, cont = false): HTMLElement =>
    el("div", { class: `py-line${cont ? " cont" : ""}` }, [
      el("span", { class: "py-prompt", text: cont ? "... " : ">>> " }),
      el("span", { class: "py-code", text: code }),
    ]);
  const pyFixed = el("div", { class: "py-fixed", "aria-hidden": "true" }); // flavour/time/bbox lines
  const pyClose = pyLine(")", true);
  pyClose.classList.add("py-close"); // ordered after the menu, so a flipped menu still reads right

  const py = el("div", { class: "py-view", style: "display:none" }, [
    pyLine("from freva_client import databrowser"),
    pyLine("databrowser("),
    pyFixed,
    el("div", { class: "py-ml" }, [pyGutter, el("div", { class: "py-wrap" }, [pyHl, pyInput])]),
    el("div", { class: "py-menu", role: "listbox" }),
    pyClose,
  ]);

  // Overflow panel: terminal settings + a pointer to the app-level help (the install guide itself
  // lives in the top-bar Help panel, where it's findable without opening a terminal).
  const bgPanel = el("div", {
    class: "term-bg-panel",
    role: "listbox",
    "aria-label": "Terminal colour",
  });
  const alphaRow = el("div", { class: "tmn-alpha" }, [
    el("input", {
      class: "term-alpha",
      type: "range",
      min: "0.55",
      max: "1",
      step: "0.01",
      "aria-label": "Terminal opacity",
      title: "Terminal opacity",
    }),
  ]);
  const menu = el("div", { class: "term-menu" }, [
    el("div", { class: "tmn-h", text: "Colour" }),
    bgPanel,
    el("div", { class: "tmn-h", text: "Opacity" }),
    alphaRow,
    el("button", {
      class: "tmn-item",
      type: "button",
      "data-act": "help",
      text: "How to install freva-client",
    }),
    el("a", {
      class: "tmn-item",
      href: "https://freva-org.github.io/freva-nextgen/",
      target: "_blank",
      rel: "noopener noreferrer",
      text: "Documentation \u2197",
    }),
  ]);

  root.append(
    bar,
    el("div", { class: "term-body" }, [cliView, py]),
    // Footer strip: the keyboard-escape hint reads as a status line here rather than
    // floating in the command flow. One shared copy; setHint() targets `.te-hint` wherever it lives.
    el("div", { class: "term-foot" }, [el("span", { class: "te-hint" }, hintNodes(false))]),
    menu,
    el("div", { class: "term-resize", "aria-hidden": "true" }),
  );
}

function must<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const found = root.querySelector<T>(sel);
  if (!found) throw new Error(`terminal: missing ${sel}`);
  return found;
}
