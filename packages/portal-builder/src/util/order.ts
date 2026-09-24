// Deterministic ordering: everything that ends up in an artifact is ordered by Unicode code
// point. `localeCompare` depends on the ICU data and locale of the machine running the build,
// so two hosts can sort the same manifest differently and a reproducibility comparison fails
// for a reason that has nothing to do with the site.

export function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const x = left[i]!.codePointAt(0)!;
    const y = right[i]!.codePointAt(0)!;
    if (x !== y) return x - y;
  }
  return left.length - right.length;
}

export function byCodePoint<T>(key: (value: T) => string): (a: T, b: T) => number {
  return (a, b) => compareCodePoints(key(a), key(b));
}
