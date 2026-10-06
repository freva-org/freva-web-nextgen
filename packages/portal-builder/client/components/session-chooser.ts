// The per-session setup chooser: "Same as current" or "Custom setup", then a review step, then
// Start. Shared by the portal window (local sessions) and the playground document (framed
// sessions, whose chooser lives in the child). It renders and collects; the caller validates
// against the policy and reserves the live slot when Start is pressed.

import type * as Sessions from "@freva-org/browser-python/session";
import type { SessionPolicy, SessionSetup } from "@freva-org/browser-python/session";

type SessionModule = typeof Sessions;

export interface ChooserOptions {
  session: SessionModule;
  policy: SessionPolicy;
  /** What "Same as current" proposes; `null` offers the default setup instead. */
  current: SessionSetup | null;
  /** e.g. "1 of 2 live interpreters in use". */
  liveSummary(): Promise<string>;
  /** Start a session; resolves `null` once started, or a reason to show and stay. */
  start(setup: SessionSetup): Promise<string | null>;
}

const CSS = `
.portal-python-chooser { display: grid; gap: 0.6em; }
.portal-python-chooser p { margin: 0; }
.portal-python-chooser fieldset { margin: 0; padding: 0.4em 0.6em; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 0.35rem; }
.portal-python-chooser legend { padding: 0 0.3em; font-weight: 600; }
.portal-python-chooser label { display: flex; gap: 0.45em; align-items: baseline; padding: 0.1em 0; }
.portal-python-chooser .portal-python-chooser-actions { display: flex; flex-wrap: wrap; gap: 0.5em; justify-content: flex-end; }
.portal-python-chooser button { font: inherit; color: inherit; cursor: pointer; padding: 0.35em 0.8em; border-radius: 0.35rem; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: color-mix(in srgb, currentColor 8%, transparent); }
.portal-python-chooser button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 16%, transparent); }
.portal-python-chooser button:disabled { cursor: default; opacity: 0.55; }
.portal-python-chooser button:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
.portal-python-chooser .portal-python-chooser-option { display: block; width: 100%; text-align: left; }
.portal-python-chooser .portal-python-chooser-option small { display: block; opacity: 0.75; }
.portal-python-chooser dl { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 0.25em 0.8em; margin: 0; }
.portal-python-chooser dt { font-weight: 600; }
.portal-python-chooser dd { margin: 0; overflow-wrap: anywhere; }
.portal-python-chooser [role="alert"] { padding: 0.35em 0.5em; border-radius: 0.3rem; background: rgba(255, 154, 139, 0.18); }
`;

const adopted = new WeakSet<Document>();

/** Adopt the chooser's styles; constructable sheets pass a strict `style-src 'self'`. */
export function adoptChooserStyles(doc: Document = document): void {
  if (adopted.has(doc)) return;
  adopted.add(doc);
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  } catch {
    const style = doc.createElement("style");
    style.textContent = CSS;
    doc.head.append(style);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Render the chooser into `host`, replacing its content. */
export function renderChooser(host: HTMLElement, options: ChooserOptions): void {
  const doc = host.ownerDocument;
  adoptChooserStyles(doc);
  const { policy, session } = options;
  const profiles = Object.keys(policy.profiles);
  let draft: SessionSetup = { ...(options.current ?? policy.defaults), frontend: "console" };

  const frame = (...children: Node[]): void => {
    const root = el(doc, "div");
    root.className = "portal-python-chooser";
    root.append(...children);
    host.replaceChildren(root);
    root.querySelector<HTMLElement>("button, input")?.focus();
  };
  const actions = (...buttons: HTMLButtonElement[]): HTMLElement => {
    const row = el(doc, "div");
    row.className = "portal-python-chooser-actions";
    row.append(...buttons);
    return row;
  };
  const button = (label: string, onClick: () => void): HTMLButtonElement => {
    const node = el(doc, "button", label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  };

  const first = (): void => {
    const same = options.current;
    const offer = same ?? policy.defaults;
    const sameButton = button("", () => review({ ...offer, frontend: "console" }));
    sameButton.className = "portal-python-chooser-option";
    sameButton.append(
      el(doc, "span", same ? "Same as current" : "Default setup"),
      el(doc, "small", session.describeSetup({ ...offer, frontend: "console" })),
    );
    const customButton = button("", () => custom());
    customButton.className = "portal-python-chooser-option";
    customButton.append(
      el(doc, "span", "Custom setup…"),
      el(doc, "small", "Choose the profile, add-ons and starter code for this session."),
    );
    frame(
      el(
        doc,
        "p",
        "A new session is an independent Python interpreter with its own CPU and memory. It " +
          "shares no variables or files with other sessions.",
      ),
      sameButton,
      customButton,
    );
  };

  const custom = (): void => {
    const profileSet = el(doc, "fieldset");
    profileSet.append(el(doc, "legend", "Profile"));
    for (const name of profiles) {
      const label = el(doc, "label");
      const input = el(doc, "input");
      input.type = "radio";
      input.name = "portal-python-profile";
      input.value = name;
      input.checked = draft.profile === name;
      input.addEventListener("change", () => {
        const allowed = policy.profiles[name]?.allowedAddons ?? [];
        draft = {
          ...draft,
          profile: name,
          addons: draft.addons.filter((id) => allowed.includes(id)),
          runStarter: session.starterApplies(policy, name),
        };
        custom();
      });
      label.append(input, el(doc, "span", name));
      profileSet.append(label);
    }
    const children: Node[] = [profileSet];
    const allowed = policy.profiles[draft.profile]?.allowedAddons ?? [];
    if (allowed.length > 0) {
      const addonSet = el(doc, "fieldset");
      addonSet.append(el(doc, "legend", "Add-ons"));
      for (const id of allowed) {
        const label = el(doc, "label");
        const input = el(doc, "input");
        input.type = "checkbox";
        input.value = id;
        input.checked = draft.addons.includes(id);
        input.addEventListener("change", () => {
          const set = new Set(draft.addons);
          if (input.checked) set.add(id);
          else set.delete(id);
          draft = { ...draft, addons: [...set].sort() };
        });
        label.append(input, el(doc, "span", id));
        addonSet.append(label);
      }
      children.push(addonSet);
    }
    if (session.starterApplies(policy, draft.profile)) {
      const label = el(doc, "label");
      const input = el(doc, "input");
      input.type = "checkbox";
      input.checked = draft.runStarter;
      input.disabled = !policy.allowSkipStarter;
      input.addEventListener("change", () => {
        draft = { ...draft, runStarter: input.checked };
      });
      label.append(
        input,
        el(
          doc,
          "span",
          policy.allowSkipStarter
            ? "Run this site's starter code when Python is ready"
            : "This site's starter code runs when Python is ready",
        ),
      );
      children.push(label);
    }
    children.push(
      actions(
        button("Back", first),
        button("Review", () => review(draft)),
      ),
    );
    frame(...children);
  };

  const review = (setup: SessionSetup): void => {
    draft = setup;
    const list = el(doc, "dl");
    const row = (term: string, value: string): void => {
      list.append(el(doc, "dt", term), el(doc, "dd", value));
    };
    row("Profile", setup.profile);
    row("Add-ons", setup.addons.length > 0 ? setup.addons.join(", ") : "none");
    if (policy.starter) row("Starter code", setup.runStarter ? "runs" : "does not run");
    const live = el(doc, "dd", "…");
    list.append(el(doc, "dt", "Live interpreters"), live);
    void options.liveSummary().then((text) => {
      live.textContent = text;
    });
    const problem = el(doc, "p");
    problem.setAttribute("role", "alert");
    problem.hidden = true;
    const startButton = button("Start session", () => {
      const check = session.validateSetup(policy, setup);
      if (!check.ok) {
        problem.textContent = `This setup is not allowed: ${check.problems.join("; ")}.`;
        problem.hidden = false;
        return;
      }
      startButton.disabled = true;
      void options.start(check.setup).then(
        (reason) => {
          if (reason === null) return;
          problem.textContent = reason;
          problem.hidden = false;
          startButton.disabled = false;
        },
        (error: unknown) => {
          problem.textContent = error instanceof Error ? error.message : String(error);
          problem.hidden = false;
          startButton.disabled = false;
        },
      );
    });
    frame(
      list,
      el(
        doc,
        "p",
        "The setup is fixed for the life of this session. A restart keeps it; a different setup " +
          "is a new session.",
      ),
      problem,
      actions(button("Back", first), startButton),
    );
  };

  first();
}
