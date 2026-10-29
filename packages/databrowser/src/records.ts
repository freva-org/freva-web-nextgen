/**
 * The own list at `record[key]`, created when missing. Keys come from URLs and typed queries, so
 * `toString` or `constructor` must not resolve to Object.prototype's members, and `__proto__`
 * cannot be an own key of a plain object at all: it is refused (null).
 */
export function ownList(record: Record<string, string[]>, key: string): string[] | null {
  if (key === "__proto__") return null;
  if (!Object.prototype.hasOwnProperty.call(record, key)) record[key] = [];
  return record[key] ?? null;
}
