/**
 * Runtime validation for everything security-relevant.
 *
 * TypeScript types are erased at runtime. A plain-JavaScript caller - or a
 * config assembled from JSON, env vars or a template - can hand us
 * `allowInsecureTransport: "false"`, and a truthy string then *enables* the
 * exposure the flag names. Every security-relevant value is therefore checked
 * for its real runtime type, not its declared one.
 */

import { AuthError } from "./token.js";

export function strictBoolean(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new AuthError(
      `${label} must be a real boolean, got ${typeof value} ` +
        `${JSON.stringify(value)}. A truthy string such as "false" must never ` +
        "be read as an acknowledgement.",
    );
  }
  return value;
}

export function strictEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  fallback?: T,
): T {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new AuthError(
      `${label} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(value)}.`,
    );
  }
  return value as T;
}

export function strictNumber(
  value: unknown,
  label: string,
  {
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
    fallback,
  }: {
    min?: number;
    max?: number;
    fallback?: number;
  } = {},
): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AuthError(`${label} must be a finite number, got ${JSON.stringify(value)}.`);
  }
  if (value < min || value > max) {
    throw new AuthError(`${label} must be between ${min} and ${max}, got ${value}.`);
  }
  return value;
}

export function strictFunction(
  value: unknown,
  label: string,
): ((...args: never[]) => unknown) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function") {
    throw new AuthError(`${label} must be a function, got ${typeof value}.`);
  }
  return value as (...args: never[]) => unknown;
}

export function strictStringArray(
  value: unknown,
  label: string,
  { maxLength = 64 }: { maxLength?: number } = {},
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AuthError(`${label} must be an array of strings.`);
  }
  if (value.length > maxLength) {
    throw new AuthError(`${label} must not have more than ${maxLength} entries.`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new AuthError(`${label} entries must be non-empty strings.`);
    }
  }
  return [...(value as string[])];
}

export function strictString(
  value: unknown,
  label: string,
  { maxLength = 4096 }: { maxLength?: number } = {},
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AuthError(`${label} must be a string, got ${typeof value}.`);
  }
  if (value.length > maxLength) {
    throw new AuthError(`${label} must be at most ${maxLength} characters.`);
  }
  return value;
}

/** A TokenStorage must actually implement its contract before we trust it. */
export function assertStorageShape(value: unknown, label: string): void {
  if (!value || typeof value !== "object") {
    throw new AuthError(`${label} must be a TokenStorage object.`);
  }
  const s = value as Record<string, unknown>;
  for (const method of ["load", "save", "clear"]) {
    if (typeof s[method] !== "function") {
      throw new AuthError(`${label}.${method}() must be a function.`);
    }
  }
  if (s.subscribe !== undefined && typeof s.subscribe !== "function") {
    throw new AuthError(`${label}.subscribe must be a function when present.`);
  }
  if (s.kind !== undefined) {
    strictEnum(s.kind, ["memory", "cookie", "server-managed", "custom"] as const, `${label}.kind`);
  }
  if (s.persistent !== undefined) {
    strictBoolean(s.persistent, `${label}.persistent`);
  }
}

export const REFRESH_MODES = ["auto", "force", "never"] as const;
export const PROMPTS = ["login", "consent", "select_account", "none"] as const;

/** Validate a per-call options bag (fetch / getToken / login / logout). */
export function validateCallOptions(
  options: unknown,
  label: string,
  spec: {
    booleans?: string[];
    enums?: Record<string, readonly string[]>;
    strings?: string[];
  },
): void {
  if (options === undefined) return;
  if (!options || typeof options !== "object") {
    throw new AuthError(`${label} must be an object.`);
  }
  const o = options as Record<string, unknown>;
  for (const key of spec.booleans ?? []) {
    strictBoolean(o[key], `${label}.${key}`);
  }
  for (const [key, allowed] of Object.entries(spec.enums ?? {})) {
    if (o[key] !== undefined) strictEnum(o[key], allowed, `${label}.${key}`);
  }
  for (const key of spec.strings ?? []) {
    strictString(o[key], `${label}.${key}`);
  }
}
