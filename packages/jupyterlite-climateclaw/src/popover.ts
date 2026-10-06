// A small popover anchored to a button: the account card and the model picker. It closes on a
// click outside, Escape, a scroll of the page or the anchor leaving the page; focus goes back to
// the anchor when it closed by keyboard.

export interface PopoverHandle {
  readonly node: HTMLElement;
  close(): void;
}

let openOne: PopoverHandle | null = null;

export function openPopover(
  anchor: HTMLElement,
  content: HTMLElement,
  options: { className?: string; label: string; align?: "start" | "end"; above?: boolean },
): PopoverHandle {
  openOne?.close();
  const doc = anchor.ownerDocument;
  const node = doc.createElement("div");
  node.className = `jp-ClimateClaw-popover ${options.className ?? ""}`.trim();
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-label", options.label);
  node.append(content);
  doc.body.append(node);
  anchor.setAttribute("aria-expanded", "true");

  const place = () => {
    const rect = anchor.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const view = doc.documentElement;
    const left =
      options.align === "end"
        ? rect.right - box.width
        : Math.min(rect.left, view.clientWidth - box.width - 8);
    const below = rect.bottom + 6;
    const fitsBelow = below + box.height < view.clientHeight - 8;
    const top = options.above || !fitsBelow ? Math.max(8, rect.top - box.height - 6) : below;
    node.style.left = `${Math.max(8, left)}px`;
    node.style.top = `${top}px`;
  };
  place();

  const onDown = (event: Event) => {
    const target = event.target as Node | null;
    if (target && (node.contains(target) || anchor.contains(target))) return;
    handle.close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    handle.close();
    anchor.focus();
  };
  const onScroll = (event: Event) => {
    if (!node.contains(event.target as Node | null)) handle.close();
  };
  // After this click: the one that opened it must not close it.
  const timer = setTimeout(() => doc.addEventListener("pointerdown", onDown, true));
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", place);

  const handle: PopoverHandle = {
    node,
    close: () => {
      if (!node.isConnected) return;
      clearTimeout(timer);
      doc.removeEventListener("pointerdown", onDown, true);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
      anchor.setAttribute("aria-expanded", "false");
      node.remove();
      if (openOne === handle) openOne = null;
    },
  };
  openOne = handle;
  return handle;
}

/** An element with a class and text (textContent: never markup). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", className);
  node.type = "button";
  node.title = label;
  node.setAttribute("aria-label", label);
  node.addEventListener("click", onClick);
  return node;
}
