/**
 * The code copy control.
 *
 * The button is in the document already; this gives it its behaviour and only then reveals it.
 * Three properties, each a way this commonly goes wrong:
 *
 *   * it copies the SOURCE, taken from the attribute the build wrote, not the rendered markup - no
 *     highlight spans, no line numbers, no button label, every newline and leading space as typed;
 *   * it is a real `<button>`, so Tab reaches it and Enter and Space activate it without a key
 *     handler of the portal's own;
 *   * when the Clipboard API is missing or refuses - an insecure origin, a denied permission - it
 *     says so instead of claiming success, and the code stays selectable.
 */

const RESET_MS = 1600;

function setState(button: HTMLButtonElement, label: string, state: string): void {
  const text = button.querySelector<HTMLElement>(".portal-code-copy-label");
  if (text) text.textContent = label;
  button.dataset.state = state;
}

async function copy(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection fallback rather than reporting success.
  }
  // A last resort for browsers and origins without the async clipboard, and not the first
  // choice: it moves focus and the selection.
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function initCodeCopy(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-portal-copy]");
  for (const button of buttons) {
    const source = button.dataset.portalCopy ?? "";
    button.hidden = false;
    let timer: number | undefined;
    button.addEventListener("click", () => {
      void copy(source).then((ok) => {
        setState(button, ok ? "Copied" : "Press Ctrl+C", ok ? "copied" : "failed");
        button.setAttribute("aria-label", ok ? "Code copied" : "Copying is unavailable");
        if (timer !== undefined) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          setState(button, "Copy", "idle");
          button.setAttribute("aria-label", "Copy code");
        }, RESET_MS);
      });
    });
  }
}
