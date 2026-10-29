/**
 * Values grouped by key, in first-seen order. Keys come from URLs and typed queries, so they are
 * collected in a Map and turned into own data properties by Object.fromEntries: no key is ever
 * assigned onto a plain object, and `__proto__` is dropped.
 */
export function groupValues(
  pairs: Iterable<readonly [string, string]>,
  unique = false,
): Record<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [key, value] of pairs) {
    if (key === "__proto__") continue;
    const list = groups.get(key);
    if (!list) groups.set(key, [value]);
    else if (!unique || !list.includes(value)) list.push(value);
  }
  return Object.fromEntries(groups);
}
