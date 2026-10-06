// Per-session setup choices: what a deployment allows, what a visitor picked, and the check
// between them. A choice from a peer (another frame, a stored checkpoint) is untrusted data and
// goes through `validateSetup` before anything is started with it.

import { Sha256 } from "./sha256.js";

export type SessionFrontend = "console" | "notebook";

/** One session's setup. Locked for the life of an interpreter generation. */
export interface SessionSetup {
  profile: string;
  /** Sorted, unique add-on ids. */
  addons: readonly string[];
  /** Run the deployment's starter code after the interpreter is ready. */
  runStarter: boolean;
  frontend: SessionFrontend;
}

/** What a deployment allows. Built by the deployment's tooling, never from visitor input. */
export interface SessionPolicy {
  /** Profile -> the add-ons a visitor may choose with it. */
  profiles: Readonly<Record<string, { readonly allowedAddons: readonly string[] }>>;
  /** Whether the deployment has starter code at all. */
  starter: boolean;
  /** Profiles the starter runs on. */
  starterProfiles: readonly string[];
  /** Whether a visitor may switch the starter off where it applies. */
  allowSkipStarter: boolean;
  /** Whether the notebook front end is offered. */
  notebook: boolean;
  /** The setup a session gets without a choice. Always valid under this policy. */
  defaults: SessionSetup;
}

export type SetupCheck = { ok: true; setup: SessionSetup } | { ok: false; problems: string[] };

const SETUP_KEYS = ["addons", "frontend", "profile", "runStarter"];
const MAX_ADDONS = 16;
const has = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

/** Whether the starter applies to `profile`. */
export function starterApplies(policy: SessionPolicy, profile: string): boolean {
  return policy.starter && policy.starterProfiles.includes(profile);
}

/** Check a candidate setup against the policy and return it normalised, or every problem. */
export function validateSetup(policy: SessionPolicy, candidate: unknown): SetupCheck {
  const problems: string[] = [];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, problems: ["a setup must be an object"] };
  }
  const c = candidate as Record<string, unknown>;
  const extra = Object.keys(c).filter((key) => !SETUP_KEYS.includes(key));
  if (extra.length > 0) problems.push(`unknown field(s): ${extra.join(", ")}`);

  const profile = c.profile;
  const known = typeof profile === "string" && has(policy.profiles, profile);
  if (!known) problems.push(`profile ${JSON.stringify(profile)} is not offered`);

  const addons: string[] = [];
  if (!Array.isArray(c.addons) || c.addons.length > MAX_ADDONS) {
    problems.push("addons must be a list of at most 16 ids");
  } else {
    const allowed = known ? policy.profiles[profile as string]!.allowedAddons : [];
    for (const id of c.addons) {
      if (typeof id !== "string") problems.push("an add-on id must be a string");
      else if (addons.includes(id)) problems.push(`add-on '${id}' is listed twice`);
      else if (known && !allowed.includes(id)) {
        problems.push(`add-on '${id}' is not offered with '${profile as string}'`);
      } else addons.push(id);
    }
  }
  addons.sort();

  if (typeof c.runStarter !== "boolean") problems.push("runStarter must be true or false");
  else if (known) {
    const applies = starterApplies(policy, profile as string);
    if (c.runStarter && !applies)
      problems.push(`the starter does not run on '${profile as string}'`);
    if (!c.runStarter && applies && !policy.allowSkipStarter) {
      problems.push("the starter cannot be skipped");
    }
  }

  if (c.frontend !== "console" && !(c.frontend === "notebook" && policy.notebook)) {
    problems.push(`front end ${JSON.stringify(c.frontend)} is not offered`);
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    setup: Object.freeze({
      profile: profile as string,
      addons: Object.freeze(addons),
      runStarter: c.runStarter as boolean,
      frontend: c.frontend as SessionFrontend,
    }),
  };
}

/** Whether two setups are the same interpreter and front end. */
export function sameSetup(a: SessionSetup, b: SessionSetup): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** A short human description, e.g. `xarray-zarr + dask · starter · console`. */
export function describeSetup(setup: SessionSetup): string {
  const env = [setup.profile, ...setup.addons].join(" + ");
  return `${env} · ${setup.runStarter ? "starter" : "no starter"} · ${setup.frontend}`;
}

/** JSON with object keys sorted, so equal values serialise identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The policy's identity: SHA-256 of its canonical form. Two peers agree on a setup only if they
 * agree on this, so a choice made under one deployment is never applied under another.
 */
export function policyFingerprint(policy: SessionPolicy): string {
  const normalised = {
    ...policy,
    profiles: Object.fromEntries(
      Object.entries(policy.profiles).map(([name, entry]) => [
        name,
        { allowedAddons: [...entry.allowedAddons].sort() },
      ]),
    ),
    starterProfiles: [...policy.starterProfiles].sort(),
  };
  return new Sha256().update(new TextEncoder().encode(canonicalJson(normalised))).digest();
}
