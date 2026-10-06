// Who and where, as the chat header shows them: a user's initials for the account avatar and a
// short label for the Freva host ("DKRZ" for nextgems.dkrz.de).

/** Two letters for an avatar: "jdoe" -> "JD", "Mo Hadizade" -> "MH", "m.hadizade@x" -> "MH". */
export function initials(name: string | null | undefined): string {
  const local = (name ?? "").trim().split("@")[0] ?? "";
  const words = local.split(/[\s._-]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return "?";
  const letters = (word: string) => [...word].filter((c) => /[\p{L}\p{N}]/u.test(c));
  const first = letters(words[0]!);
  const pair =
    words.length > 1
      ? [first[0], letters(words[words.length - 1]!)[0]]
      : [first[0], first[1]].filter(Boolean);
  return pair.join("").toUpperCase() || "?";
}

/**
 * What an account's avatar shows: the initials of the person's name, or null for an account id
 * with digits ("k204221"), whose letters say nothing - the avatar shows a person then.
 */
export function avatarText(
  fullName: string | null | undefined,
  username: string | null | undefined,
): string | null {
  if (fullName?.trim()) return initials(fullName);
  const local = (username ?? "").trim().split("@")[0] ?? "";
  if (!local || /\d/.test(local)) return null;
  return initials(local);
}

/** How a signed-in user is greeted in a short note: the first name, else the username. */
export function shortName(
  fullName: string | null | undefined,
  username: string | null | undefined,
): string {
  return fullName?.trim().split(/\s+/)[0] || username?.trim() || "your Freva account";
}

/**
 * A short name for the host: the operator's `hostLabel`, else the registrable domain's own label
 * in capitals when it is short ("nextgems.dkrz.de" -> "DKRZ"), else the host name.
 */
export function hostLabel(host: string, override = ""): string {
  if (override.trim()) return override.trim();
  let hostname = "";
  try {
    hostname = new URL(host).hostname;
  } catch {
    return "";
  }
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":") || !hostname.includes(".")) {
    return hostname;
  }
  const parts = hostname.split(".");
  const label = parts[parts.length - 2] ?? hostname;
  return label.length <= 5 ? label.toUpperCase() : hostname;
}
