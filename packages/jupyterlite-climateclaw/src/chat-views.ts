// What every view of a chat watches on its model, whichever view it is.

import type { IChatModel, InputToolbarRegistry } from "@jupyter/chat";

/** ClimateClaw's own Stop, which takes Send's place while a reply streams (see stop-button.ts). */
export const OWN_STOP = "climateclawStop";

/** The parts of a chat view `watchStop` uses. */
export interface StopView {
  readonly model: IChatModel;
  readonly inputToolbarRegistry?: Pick<InputToolbarRegistry, "show" | "hide"> &
    Partial<Pick<InputToolbarRegistry, "get" | "itemsChanged">>;
}

/**
 * Shows jupyterlite-ai's Stop while a bot writes, as its own panel does - from the start: a view
 * made while a reply runs (a chat moved to a tab mid-reply) shows Stop at once. Once the view has
 * ClimateClaw's own Stop, that one shows itself: jupyterlite-ai's (one item shared by every chat)
 * is let go, hidden only if this view showed it.
 */
export function watchStop(widget: StopView): () => void {
  const model = widget.model;
  const registry = widget.inputToolbarRegistry;
  let showing = false;
  const own = () => Boolean(registry?.get?.(OWN_STOP));
  let hadOwn = own();
  const update = (_: unknown, writers: readonly IChatModel.IWriter[]) => {
    if (!registry) return;
    const writing = writers.some((w) => w.user.bot === true);
    if (writing && !own()) {
      registry.show("stop");
      showing = true;
    } else if (showing || !own()) {
      registry.hide("stop");
      showing = false;
    }
  };
  // Only when the own Stop arrives (a show or hide emits too: acting on those would loop).
  const items = () => {
    if (own() === hadOwn) return;
    hadOwn = own();
    update(model, model.writers ?? []);
  };
  model.writersChanged?.connect(update);
  registry?.itemsChanged?.connect(items);
  update(model, model.writers ?? []);
  return () => {
    model.writersChanged?.disconnect(update);
    registry?.itemsChanged?.disconnect(items);
  };
}

/**
 * Follows sign-ins for the panel: true when one just completed and should lead to a new chat -
 * whenever the panel shows its welcome (signed in from the header, the account card, a link) or
 * the sign-in started from the welcome's own button.
 */
export function signInLeadsToNewChat(
  initiallySignedIn: boolean,
): (state: { signedIn: boolean; view: string; fromWelcome: boolean }) => boolean {
  let was = initiallySignedIn;
  return ({ signedIn, view, fromWelcome }) => {
    const just = signedIn && !was;
    was = signedIn;
    return signedIn && (fromWelcome || (just && view === "welcome"));
  };
}
