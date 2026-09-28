/**
 * Runnable code blocks, as a playground provider.
 *
 * The build already did the hard part: every marked block has an identity and a digest, and the
 * page already contains the exact source, in the copy control. This module puts those two facts
 * together and refuses to enable a button whose source no longer hashes to what the build
 * approved.
 *
 * THE SOURCE IS RECONSTRUCTED RATHER THAN SHIPPED AGAIN, so a page with twelve runnable snippets
 * does not carry each of them twice - once to read and once to run - with a second copy that can
 * disagree with the first. The reconstruction is not trusted: it is checked against a digest the
 * BUILD computed, so a page whose markup was edited afterwards by an injection, a proxy or a
 * well-meant find-and-replace keeps its Try controls hidden. `button.dataset` is a hint about
 * where to find the source, never the command.
 */

import {
  registerPythonBlock,
  type ExampleSource,
  type PythonPlaygroundConfig,
} from "../python-bridge.js";
import { tryPython, tryPythonEdited } from "../python-bridge.js";
import type { SnippetEditor } from "./code-editor.js";

/** The one element the build stamps on a page that has something runnable on it. */
const HOST = "[data-portal-python-playground]";

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function digestOf(source: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  // No Web Crypto, no Try. An insecure context cannot verify anything, and a control that ran
  // unverified page text is what this check exists to prevent - so the button stays hidden and
  // Copy, which needs none of this, keeps working.
  if (!subtle) return null;
  return hex(await subtle.digest("SHA-256", new TextEncoder().encode(source)));
}

/** How long "Done" or "Failed" stays on a run control before it reads "Try in Python" again. */
const SETTLE_MS = 2500;

/**
 * What a press became, on the control that was pressed: running while it is queued or executing,
 * then done or error. Presses queue in the interpreter, so the control counts them and settles when
 * the last one does. "Done" means the program ran to the end; "error" means it raised (the
 * traceback is in the transcript) or could not run at all. On a separate origin, whose bridge
 * reports nothing back, "Done" means the example was handed to the interpreter.
 */
function runState(button: HTMLButtonElement): (run: Promise<void>) => void {
  const label = button.querySelector<HTMLElement>(".portal-code-run-label");
  const idle = label?.textContent ?? "Try in Python";
  let pending = 0;
  let failed = false;
  let timer: number | undefined;
  const show = (state: string, text: string): void => {
    button.dataset.state = state;
    if (label) label.textContent = text;
  };
  return (run) => {
    window.clearTimeout(timer);
    pending += 1;
    button.setAttribute("aria-busy", "true");
    show("running", "Running…");
    run
      .catch(() => {
        failed = true;
      })
      .finally(() => {
        pending -= 1;
        if (pending > 0) return;
        button.removeAttribute("aria-busy");
        show(failed ? "error" : "done", failed ? "Failed" : "Done");
        failed = false;
        timer = window.setTimeout(() => {
          delete button.dataset.state;
          if (label) label.textContent = idle;
        }, SETTLE_MS);
      });
  };
}

/** The offset into `pre`'s text under a point, for putting the editor's caret where the click was. */
function offsetAt(pre: HTMLElement, x: number, y: number): number | undefined {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  const range = position ? null : doc.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset;
  // The code, not the block: the line-number gutter is text too, and not the source's.
  const code = pre.querySelector("code") ?? pre;
  if (!node || offset === undefined || !code.contains(node)) return undefined;
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text === node) return total + offset;
    total += text.textContent?.length ?? 0;
  }
  return undefined;
}

/** `1\n2\n…\nn`: the gutter's text for `source`. The editor keeps it current once it loads. */
function lineNumbers(source: string): string {
  return Array.from({ length: source.split("\n").length }, (_, i) => i + 1).join("\n");
}

function tag(className: string, text: string, icon?: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  if (icon) {
    const mark = document.createElement("span");
    mark.className = icon;
    mark.setAttribute("aria-hidden", "true");
    span.append(mark);
  }
  const label = document.createElement("span");
  label.className = `${className}-label`;
  label.textContent = text;
  span.append(label);
  return span;
}

/**
 * An editable snippet: the editor loads on the first click or focus, never before. Until then the
 * block is the build's read-only code dressed as an editor - line numbers, an "Editable" tag, a tab
 * stop, a text cursor - all added by script, since without a script nothing can be edited.
 */
function makeEditable(
  figure: HTMLElement,
  source: string,
  name: string,
  run: () => void,
): () => SnippetEditor | null {
  const pre = figure.querySelector<HTMLElement>("pre.portal-code-block");
  const copy = figure.querySelector<HTMLElement>("[data-portal-copy]");
  const actions = figure.querySelector<HTMLElement>(".portal-code-actions");
  if (!pre || !actions) return () => null;

  // Reset, beside Try in Python, shown only once there is something to reset.
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "portal-code-reset";
  reset.textContent = "Reset";
  reset.setAttribute("aria-label", "Restore the original code");
  reset.hidden = true;
  actions.append(reset);

  pre.tabIndex = 0;
  pre.setAttribute("aria-label", `${name}: editable Python. Press Enter to edit.`);

  // Line numbers: aria-hidden and unselectable, and outside the source Copy copies.
  const gutter = document.createElement("span");
  gutter.className = "portal-code-gutter";
  gutter.setAttribute("aria-hidden", "true");
  gutter.textContent = lineNumbers(source);
  pre.prepend(gutter);

  // "Editable" beside the language, and "Edited" beside the title (or the tag) once it differs.
  const lang = figure.querySelector(".portal-code-lang");
  const title = figure.querySelector(".portal-code-title");
  const editable = tag("portal-code-editable", "Editable", "portal-code-editable-icon");
  const edited = tag("portal-code-edited", "Edited");
  edited.hidden = true;
  lang?.after(editable);
  (title ?? editable).after(edited);

  let editor: SnippetEditor | null = null;
  let loading: Promise<void> | null = null;
  const open = (caret?: number): void => {
    if (editor || loading) return;
    loading = import("./code-editor.js")
      .then(({ mountEditor }) => {
        pre.removeAttribute("aria-label");
        editor = mountEditor({
          pre,
          original: source,
          name,
          ...(caret !== undefined ? { caret } : {}),
          onRun: run,
          onChange(value) {
            // Copy copies what is on screen; Reset exists while it differs from the author's.
            if (copy) copy.dataset.portalCopy = value;
            reset.hidden = value === source;
            edited.hidden = value === source;
            figure.toggleAttribute("data-portal-edited", value !== source);
          },
        });
        editor.focus();
      })
      .catch(() => {
        // No editor - the network dropped mid-import. The snippet stays read-only and runnable.
        loading = null;
      });
  };
  pre.addEventListener("pointerdown", (event) => open(offsetAt(pre, event.clientX, event.clientY)));
  pre.addEventListener("keydown", (event) => {
    if (event.target === pre && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      open();
    }
  });
  reset.addEventListener("click", () => {
    editor?.reset();
    editor?.focus();
  });
  return () => editor;
}

/**
 * Find the runnable blocks, verify them, and register them as one provider. Returns a promise the
 * entry chains on: the playground must not be prepared until the sources are registered, or the
 * first press finds an empty registry. Nothing here loads the interpreter, the console or the
 * terminal - a page with a Try button that nobody presses fetches none of them.
 */
export async function mountRunnableCode(): Promise<void> {
  const host = document.querySelector<HTMLElement>(HOST);
  if (!host) return;
  const raw = host.getAttribute("data-portal-python-playground");
  if (!raw) return;
  let config: PythonPlaygroundConfig;
  try {
    config = JSON.parse(raw) as PythonPlaygroundConfig;
  } catch {
    return;
  }

  const approved = new Map(config.examples.map((example) => [example.id, example]));
  const sources = new Map<string, ExampleSource>();
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button[data-portal-run]")];

  for (const button of buttons) {
    const id = button.getAttribute("data-portal-example");
    const stamped = button.getAttribute("data-portal-digest");
    if (!id || !stamped) continue;
    const registered = approved.get(id);
    // THREE THINGS HAVE TO AGREE, and the build's answer decides: the id must be one the build
    // registered, the digest on the button must be the one the build recorded for it, and the
    // source in the copy control must hash to that same digest. A page satisfying two of the
    // three has been changed since it was built.
    if (!registered || registered.sha256 !== stamped) continue;
    const copy = button
      .closest(".portal-code-figure")
      ?.querySelector<HTMLElement>("[data-portal-copy]");
    const source = copy?.getAttribute("data-portal-copy");
    if (source === null || source === undefined) continue;
    const computed = await digestOf(source);
    if (computed !== registered.sha256) continue;

    const title = registered.title ?? id;
    sources.set(id, { title, source });
    button.hidden = false;
    const track = runState(button);
    const figure = button.closest<HTMLElement>(".portal-code-figure");
    let editorOf: () => SnippetEditor | null = () => null;
    const press = (): void => {
      const edited = editorOf()?.value();
      // An unedited snippet sends a name and a digest - never the source or anything from the DOM
      // - which the coordinator resolves against the registry verified here. Only text the visitor
      // changed goes as visitor input, like a cell typed at the prompt. Focus stays: the window
      // returns it to THIS button when hidden.
      track(
        edited !== undefined && edited !== source
          ? tryPythonEdited({ exampleId: id, source: edited })
          : tryPython({ exampleId: id, digest: registered.sha256 }),
      );
    };
    button.addEventListener("click", press);
    // Editable only where the build said so - which it does only for an interpreter on this
    // origin - and only once the source above was verified: the editor starts from checked text.
    if (figure?.hasAttribute("data-portal-editable")) {
      editorOf = makeEditable(figure, source, title, press);
    }
  }

  registerPythonBlock({ host, config, sources });
}
