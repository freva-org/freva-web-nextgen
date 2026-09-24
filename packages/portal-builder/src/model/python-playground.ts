/**
 * One playground, however many things on the page asked for it.
 *
 * Two things can ask: a dataset-tree block's `python` stanza and the portal-level
 * `pythonPlayground` that a documentation page's runnable snippets use. They resolve to the same
 * shape and are checked for agreement, because a page has one window, one interpreter and one
 * filesystem - two stanzas that disagree are a configuration mistake, not a precedence puzzle for
 * this file to guess its way out of.
 *
 * Deliberately absent: any inference from content. No origin is derived from a Python import, no
 * add-on is turned on because a snippet says `import dask`, and no profile is chosen by reading
 * source. Network permissions and interpreter contents are the deployment's decisions, and a
 * page's prose is not the deployment.
 */

import {
  ADDON_CATALOGUE,
  ADDONS,
  DEFAULT_PYODIDE_INDEX_URL,
  PROFILES,
  supportsOptional,
} from "@freva-org/browser-python";
import { isRefusedPackageOrigin, resolvePackagePolicy } from "./package-policy.js";
import type { DiagnosticBag, Diagnostic } from "../diagnostics.js";
import type { RawPythonPlaygroundBase } from "../config/types.js";
import type { PlaygroundSettings } from "./types.js";

/** Where a diagnostic about a playground stanza points. */
export interface PlaygroundWhere {
  file: string;
  pointer: string;
}

const at = (where: PlaygroundWhere, suffix = ""): Partial<Diagnostic> => ({
  file: where.file,
  pointer: `${where.pointer}${suffix}`,
});

/**
 * An exact HTTPS origin, and nothing that merely looks like one: no wildcard, path, query,
 * fragment or credentials. The schema refuses most of this as a pattern; repeating it here is
 * what can say *why* in a sentence, and what produces the normalised `new URL(...).origin` the
 * policy actually contains.
 */
function normaliseOrigin(
  value: string,
  where: PlaygroundWhere,
  index: number,
  bag: DiagnosticBag,
  open: boolean,
): string | undefined {
  const complain = (why: string): undefined => {
    bag.error(
      "FP1219",
      `'${value}' is not usable as a network origin for the Python playground: ${why}.`,
      {
        ...at(where, `/connectOrigins/${index}`),
        hint:
          "Write an exact origin and nothing else, e.g. https://freva.example.org. The allowlist " +
          "is what the interpreter may reach; a wildcard or a path is not an origin.",
      },
    );
    return undefined;
  };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return complain("it is not a URL");
  }
  if (url.protocol !== "https:") return complain("only https is accepted");
  if (url.username || url.password) return complain("it carries credentials");
  if (url.search || url.hash) return complain("it carries a query or a fragment");
  if (url.pathname !== "/") return complain("it carries a path");
  if (value.includes("*")) return complain("wildcards are not origins");
  // A package index is not a data origin, in restricted mode where that distinction is the point.
  // `connectOrigins` is for the services a snippet legitimately reads - a Freva instance, an S3
  // archive. Naming a public index there would put it in `connect-src`, turning
  // `await micropip.install("name")` from a documented refusal into arbitrary visitor-chosen code
  // running with this origin's authority; a deployment that wants that says so with
  // `network: "https"`, where it is the stated feature - see `REFUSED_PACKAGE_ORIGINS`. In open
  // mode the refusal would be theatre: `https:` is already in `connect-src`, so the origin is
  // reachable whether listed or not, and refusing it would only make the deployment's own
  // configuration disagree with the policy the browser enforces.
  if (!open && isRefusedPackageOrigin(url.origin)) {
    return complain(
      "it is a public package index, and this deployment is in restricted mode " +
        '(set pythonPlayground.network: "https" to allow package installs and HTTPS data)',
    );
  }
  if (url.origin !== value.replace(/\/$/, "")) {
    // e.g. https://HOST vs https://host - normalised, and said so, rather than silently differing
    // from what the deployment wrote into its own server configuration.
    return url.origin;
  }
  return url.origin;
}

/**
 * The part of a playground stanza both callers share, resolved and validated. Returns `undefined`
 * only when the stanza is absent or switched off; every other refusal is a diagnostic plus a
 * best-effort value, so one bad line does not hide the next.
 */
export function resolvePlaygroundSettings(
  raw: RawPythonPlaygroundBase | undefined,
  where: PlaygroundWhere,
  bag: DiagnosticBag,
): PlaygroundSettings | undefined {
  if (!raw || raw.enabled !== true) return undefined;

  const profile = raw.profile ?? "minimal";
  if (!(PROFILES as readonly string[]).includes(profile)) {
    bag.error("FP1219", `'${profile}' is not a profile @freva-org/browser-python offers.`, {
      ...at(where, "/profile"),
      hint: `Available: ${PROFILES.join(", ")}.`,
    });
  }

  // Add-ons are not packages, and the closed list is the point. The catalogue is imported from
  // the package that pins the artefacts rather than mirrored here: a mirrored list drifts behind
  // its source with nothing to catch it.
  const addons: string[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of (raw.addons ?? []).entries()) {
    if (seen.has(candidate)) {
      bag.error(
        "FP1219",
        `The '${candidate}' add-on is listed twice.`,
        at(where, `/addons/${index}`),
      );
      continue;
    }
    seen.add(candidate);
    if (!(ADDONS as readonly string[]).includes(candidate)) {
      bag.error("FP1219", `'${candidate}' is not a curated add-on.`, {
        ...at(where, `/addons/${index}`),
        hint:
          `Available: ${ADDONS.join(", ")}. Add-ons are a closed set of prepared capabilities, ` +
          "not package names - there is no way to ask for an arbitrary package here.",
      });
      continue;
    }
    const description = ADDON_CATALOGUE[candidate as keyof typeof ADDON_CATALOGUE];
    if (!(description.profiles as readonly string[]).includes(profile)) {
      // Refused at build time, with both names in the sentence. The alternative is a page that
      // ships, a button that lights up, and a visitor who waits for an interpreter only to be
      // shown a ModuleNotFoundError: on `minimal`, `dask` would install with no xarray to chunk.
      bag.error(
        "FP1219",
        `The '${candidate}' add-on does not work with the '${profile}' profile.`,
        {
          ...at(where, `/addons/${index}`),
          hint: `It is available on: ${description.profiles.join(", ")}.`,
        },
      );
      continue;
    }
    addons.push(candidate);
  }
  addons.sort();

  // Optional add-ons are a statement about ones already configured, not a second way to configure
  // them. Every refusal is a build error rather than a downgrade, and each says which of three
  // things went wrong, because they have three fixes: a name not in `addons` is a list out of
  // step, a name listed twice is a duplicate, and an add-on that cannot be optional is a request
  // the product cannot honour without leaving a half-changed interpreter.
  const optionalAddons: string[] = [];
  const seenOptional = new Set<string>();
  for (const [index, candidate] of (raw.optionalAddons ?? []).entries()) {
    const where_ = { ...at(where, `/optionalAddons/${index}`) };
    if (seenOptional.has(candidate)) {
      bag.error("FP1219", `The '${candidate}' add-on is listed twice in optionalAddons.`, where_);
      continue;
    }
    seenOptional.add(candidate);
    if (!(ADDONS as readonly string[]).includes(candidate)) {
      bag.error("FP1219", `'${candidate}' is not a curated add-on.`, {
        ...where_,
        hint: `Available: ${ADDONS.join(", ")}.`,
      });
      continue;
    }
    if (!addons.includes(candidate)) {
      bag.error("FP1219", `'${candidate}' is in optionalAddons but not in addons.`, {
        ...where_,
        hint:
          "optionalAddons says which of the CONFIGURED add-ons may be missing without stopping " +
          "the interpreter. It does not configure one: add it to addons as well, or remove it " +
          "from here.",
      });
      continue;
    }
    if (!supportsOptional(candidate)) {
      // Refused with the reason, because the reason is the whole answer: an add-on that installs
      // wheels mutates the interpreter part-way through, so "carry on without it" would mean
      // carrying on with some of its dependency closure present and the capability absent.
      bag.error("FP1219", `The '${candidate}' add-on cannot be optional.`, {
        ...where_,
        hint:
          `It installs wheels into the interpreter, so a failure part-way through would leave a ` +
          `session holding some of its dependencies and not the capability - and nothing can undo ` +
          `that in a live interpreter. An add-on can be optional only when every artefact is ` +
          `fetched and verified before anything is written, which is true of one that ships data ` +
          `and no wheels. Keep '${candidate}' in addons and remove it from optionalAddons.`,
      });
      continue;
    }
    optionalAddons.push(candidate);
  }
  optionalAddons.sort();

  // The mode, read once, before anything that depends on it. Default `"origins"`, so a portal
  // that says nothing gets exactly the policy it had.
  const network: "origins" | "https" = raw.network === "https" ? "https" : "origins";

  // The same refusal for the three artefact directories, said against the field that names one.
  // These are not free-form allowlist entries - they are where the build actually fetches a
  // runtime, a wheel or an add-on from - so a public index here is both a policy entry and an
  // instruction to install from it. `resolvePackagePolicy` drops such an origin regardless; this
  // is the message that tells someone which line to change.
  for (const field of ["runtimeIndexUrl", "wheelhouseUrl", "addonBaseUrl"] as const) {
    const configured = raw[field];
    if (!configured) continue;
    // Restricted mode only: in open mode the origin is reachable anyway, and a build error about a
    // policy that would permit it regardless helps nobody.
    if (network === "https") continue;
    let origin: string;
    try {
      origin = new URL(configured).origin;
    } catch {
      continue; // Not a URL at all; whoever validates the field itself says so.
    }
    if (isRefusedPackageOrigin(origin)) {
      bag.error("FP1219", `'${field}' names a public package index (${origin}).`, {
        ...at(where, `/${field}`),
        hint:
          "Serve the runtime, the Freva wheels and the add-on artefacts from an origin you " +
          "control - `npx freva-browser-python prepare-runtime|prepare-freva-wheelhouse|" +
          "prepare-addons` write them for you. This build does not put a package index in a " +
          "Content-Security-Policy.",
      });
    }
  }

  const connectOrigins: string[] = [];
  for (const [index, origin] of (raw.connectOrigins ?? []).entries()) {
    const normalised = normaliseOrigin(origin, where, index, bag, network === "https");
    if (normalised && !connectOrigins.includes(normalised)) connectOrigins.push(normalised);
  }
  connectOrigins.sort();

  const persistCredentials = raw.persistCredentials === true;
  if (persistCredentials && !raw.playgroundOrigin) {
    // A recommendation, not a refusal - but said out loud, every time. What is persisted is a
    // refresh token in browser storage, readable by any same-origin script, including anything a
    // visitor manages to execute at the prompt. The curated environment keeps "anything" small,
    // but the token is still readable by it: on a dedicated origin that is a contained decision,
    // on the portal's own origin it is the portal's credential store.
    bag.warn(
      "FP1220",
      "The Python playground is set to persist credentials on the portal's own origin.",
      {
        ...at(where, "/persistCredentials"),
        hint:
          "What is stored is a refresh token, in browser storage, readable by any same-origin " +
          "script - including anything a visitor runs at the prompt. Give the playground its own " +
          "origin with playgroundOrigin, or leave persistCredentials off.",
      },
    );
  }

  return {
    profile,
    // Derived from the same three fields the policy is written from, so the help panel and the
    // `connect-src` a browser enforces cannot say different things about one deployment.
    packagePolicy: resolvePackagePolicy(
      {
        ...(raw.runtimeIndexUrl ? { runtimeIndexUrl: raw.runtimeIndexUrl } : {}),
        ...(raw.wheelhouseUrl ? { wheelhouseUrl: raw.wheelhouseUrl } : {}),
        ...(raw.addonBaseUrl ? { addonBaseUrl: raw.addonBaseUrl } : {}),
      },
      DEFAULT_PYODIDE_INDEX_URL,
      network,
      profile,
    ),
    network,
    autostart: raw.autostart ?? "never",
    maxSessions: raw.maxSessions ?? 2,
    addons,
    optionalAddons,
    ...(raw.initialSource ? { initialSource: raw.initialSource } : {}),
    ...(raw.playgroundOrigin ? { playgroundOrigin: raw.playgroundOrigin } : {}),
    ...(raw.runtimeIndexUrl ? { runtimeIndexUrl: raw.runtimeIndexUrl } : {}),
    ...(raw.wheelhouseUrl ? { wheelhouseUrl: raw.wheelhouseUrl } : {}),
    ...(raw.addonBaseUrl ? { addonBaseUrl: raw.addonBaseUrl } : {}),
    connectOrigins,
    persistCredentials,
    terminal: {
      osControls: raw.terminal?.osControls ?? "auto",
      alwaysOnTop: raw.terminal?.alwaysOnTop ?? true,
      rememberAppearance: raw.terminal?.rememberAppearance ?? true,
    },
  };
}

/**
 * Everything about a playground that is the *page's* rather than one provider's.
 *
 * One window per page: a window is a place the visitor put somewhere, and a second appearing
 * because a landing carries both prose and a dataset tree would be two of the same place. So
 * everything except the examples has to agree, and agreement is required rather than resolved by
 * precedence, because a precedence rule silently answers a question the author did not know they
 * had asked.
 */
export function playgroundIdentity(settings: PlaygroundSettings): Record<string, unknown> {
  return {
    profile: settings.profile,
    autostart: settings.autostart,
    // `network` is part of the identity for the same reason the origins are: it is the page's
    // single permission, not one block's. Two stanzas disagreeing about it would be one page whose
    // interpreter can install packages according to one and cannot according to the other.
    network: settings.network,
    maxSessions: settings.maxSessions,
    addons: [...settings.addons].sort().join(","),
    initialSource: settings.initialSource ?? null,
    playgroundOrigin: settings.playgroundOrigin ?? null,
    runtimeIndexUrl: settings.runtimeIndexUrl ?? null,
    wheelhouseUrl: settings.wheelhouseUrl ?? null,
    addonBaseUrl: settings.addonBaseUrl ?? null,
    connectOrigins: [...settings.connectOrigins].sort().join(","),
    persistCredentials: settings.persistCredentials,
    "terminal.osControls": settings.terminal.osControls,
    "terminal.alwaysOnTop": settings.terminal.alwaysOnTop,
    "terminal.rememberAppearance": settings.terminal.rememberAppearance,
  };
}

/** One provider's claim on the page's single playground, for the agreement check. */
export interface PlaygroundClaim {
  /** How to describe it in a message: "the portal's pythonPlayground", "the dataset-tree block". */
  describe: string;
  pointer: string;
  settings: PlaygroundSettings;
  /**
   * Which file to report a disagreement against, when the claims come from more than one.
   *
   * Within a page they all come from the same document and the caller passes it once. Across
   * pages they do not, and a diagnostic pointing at the first page would send an author to the
   * file that is not the one they changed.
   */
  file?: string;
}

/**
 * Refuse a set of providers that ask for different playgrounds. Reported per differing key rather
 * than as one "these do not match": an author with two stanzas and one wrong line needs to know
 * which line.
 *
 * Called twice: once per page over that page's own blocks, and once over the whole portal with
 * one claim per page. The second is not redundant - a portal emits ONE child artifact and ONE
 * site-wide policy, so two pages disagreeing is the same defect one page away, and only the
 * portal-wide pass can see it.
 */
export function checkPlaygroundAgreement(
  claims: readonly PlaygroundClaim[],
  declaredIn: string,
  bag: DiagnosticBag,
): void {
  const [first, ...rest] = claims;
  if (!first || rest.length === 0) return;
  const expected = playgroundIdentity(first.settings);
  for (const claim of rest) {
    const actual = playgroundIdentity(claim.settings);
    for (const [key, value] of Object.entries(expected)) {
      if (JSON.stringify(actual[key]) === JSON.stringify(value)) continue;
      bag.error(
        "FP1215",
        `Two things ask for different Python playgrounds: '${key}' is ` +
          `${JSON.stringify(actual[key])} for ${claim.describe} and ${JSON.stringify(value)} for ` +
          `${first.describe}. A portal has one interpreter, one window, one filesystem, one ` +
          `session limit and one Content-Security-Policy, so everything in it that runs Python ` +
          `has to agree about them.`,
        { file: claim.file ?? declaredIn, pointer: `${claim.pointer}` },
      );
    }
  }
}
