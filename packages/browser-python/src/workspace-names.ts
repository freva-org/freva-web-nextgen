// The one rule for workspace file names, shared by what may be imported into a workspace and what
// a checkpoint may carry - so a session never saves a file it could not restore.

/** The prefix of an import's staging name. Hidden from listings: it is not a file yet. */
export const IMPORT_PREFIX = ".freva-import-";

/** Why `name` is not a workspace file name, or null when it is one. */
export function workspaceNameProblem(name: string): string | null {
  const parts = name.split("/");
  if (name.length === 0) return "it is empty";
  if (name.length > 1024) return "it is longer than 1024 characters";
  if (parts.length > 16) return "it is nested deeper than 16 levels";
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return "it has an empty, '.' or '..' part";
    if (part.length > 255) return "a part is longer than 255 characters";
    if (part.startsWith(IMPORT_PREFIX)) return "it uses a reserved name";
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\\]/.test(part)) return "it contains a control character or '\\'";
  }
  return null;
}
