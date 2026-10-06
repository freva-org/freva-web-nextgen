// The one place ClimateClaw relies on a jupyterlite-ai internal (0.20.1, pinned exactly): its chat
// model keeps the contents manager it saves and restores its backup with in `_contentsManager`,
// set in the constructor and read by `save()` and `restore()`. `tests/ai-chat-internals.test.ts`
// checks this against the installed package, so a version without it fails the tests, not users.

export const CONTENTS_FIELD = "_contentsManager";

/**
 * Routes the model's own backup reads and writes through `contents`. False when the model has no
 * such field (another jupyterlite-ai): the caller must then keep the model from saving at all.
 */
export function routeChatContents(model: object, contents: object): boolean {
  const holder = model as Record<string, unknown>;
  if (!(CONTENTS_FIELD in holder) || !holder[CONTENTS_FIELD]) return false;
  holder[CONTENTS_FIELD] = contents;
  return holder[CONTENTS_FIELD] === contents;
}
