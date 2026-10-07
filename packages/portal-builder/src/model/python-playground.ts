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
  profileNeedsPackageIndex,
  supportsOptional,
} from "@freva-org/browser-python";
import {
  canonicalJson,
  policyFingerprint,
  type SessionPolicy,
} from "@freva-org/browser-python/session";
import { createHash } from "node:crypto";
import { isRefusedPackageOrigin, resolvePackagePolicy } from "./package-policy.js";
import type { DiagnosticBag, Diagnostic } from "../diagnostics.js";
import type { RawPythonPlaygroundBase } from "../config/types.js";
import type {
  NotebookAssistantSettings,
  NotebookDataPanelSettings,
  PlaygroundSettings,
} from "./types.js";

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

  // `same-origin`: the notebook is published in the portal's own artifact, so it needs no
  // `playgroundOrigin`. The console keeps whatever origin is configured for it.
  const sameOrigin = raw.notebook?.deployment === "same-origin";
  // The console's origin: `playgroundOrigin`, unless `consoleInPage` keeps it in the portal's
  // pages and leaves that origin to the notebook - only when there is a notebook to leave it to.
  const notebookWanted =
    raw.notebook?.enabled === true && (sameOrigin || Boolean(raw.playgroundOrigin));
  const consoleOrigin =
    raw.consoleInPage === true && notebookWanted ? undefined : raw.playgroundOrigin;
  const persistCredentials = raw.persistCredentials === true;
  if (persistCredentials && !consoleOrigin) {
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
          "origin with playgroundOrigin (without consoleInPage), or leave persistCredentials off.",
      },
    );
  }

  const sessionChoices = resolveSessionChoices(raw, profile, addons, where, bag);
  const maxSessions = raw.maxSessions ?? 2;
  if (raw.notebook?.enabled && !raw.playgroundOrigin && !sameOrigin) {
    bag.error("FP1235", "The notebook needs the playground's own origin.", {
      ...at(where, "/notebook/enabled"),
      hint:
        "The notebook runs only on `playgroundOrigin`, under its own Content-Security-Policy, so " +
        "the portal's pages keep theirs. Set `playgroundOrigin`, or `notebook.deployment: " +
        "same-origin` to publish it in the portal's artifact, or leave the notebook off.",
    });
  }

  const notebookOn = notebookWanted;
  if (notebookOn && sameOrigin) {
    // Allowed, and said out loud on every build: what a separate origin would have kept apart is
    // shared. An explicit choice, so a notice rather than a warning `warningsAsErrors` would stop.
    bag.info("FP1239", "The notebook is published on the portal's own origin.", {
      ...at(where, "/notebook/deployment"),
      hint:
        "The notebook, the console and the portal share one origin and its storage, including " +
        "the stored Freva/ClimateClaw sign-in: any script on that origin - a notebook output, " +
        "the console - can read it, and the notebook's frame sandbox does not separate it from " +
        "the page. On <account>.github.io every Pages site of that account shares the origin " +
        "too, and GitHub Pages sends no Content-Security-Policy (see `notebook.metaPolicy`). " +
        "For a separate origin, set `playgroundOrigin` and drop `deployment: same-origin`.",
    });
  }
  if (raw.notebook?.metaPolicy === true && !(notebookOn && sameOrigin)) {
    bag.warn("FP1239", "`notebook.metaPolicy` changes nothing without a same-origin notebook.", {
      ...at(where, "/notebook/metaPolicy"),
      hint: "It applies to `deployment: same-origin` only; a separate origin sends its headers.",
    });
  }
  if (raw.consoleInPage === true && !notebookOn) {
    bag.warn("FP1238", "`consoleInPage` changes nothing here: there is no notebook to move.", {
      ...at(where, "/consoleInPage"),
      hint:
        "It keeps the console in the portal's pages while the notebook uses `playgroundOrigin`. " +
        "Without the notebook and `playgroundOrigin`, remove it.",
    });
  }
  const notebookAssistant = resolveNotebookAssistant(raw, notebookOn, sameOrigin, where, bag);
  const notebookDataPanel = resolveNotebookDataPanel(raw, notebookOn, where, bag);

  return {
    profile,
    ...(notebookAssistant ? { notebookAssistant } : {}),
    ...(notebookDataPanel ? { notebookDataPanel } : {}),
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
      policyProfile(profile, sessionChoices?.policy),
    ),
    network,
    autostart: raw.autostart ?? "never",
    maxSessions,
    maxLiveSessions: Math.min(maxSessions, raw.resources?.maxLiveSessions ?? maxSessions),
    notebook: notebookOn,
    ...(notebookOn && sameOrigin ? { notebookSameOrigin: true } : {}),
    ...(notebookOn && sameOrigin && raw.notebook?.metaPolicy === true
      ? { notebookMetaPolicy: true }
      : {}),
    ...(sessionChoices ? { sessionChoices } : {}),
    addons,
    optionalAddons,
    ...(raw.initialSource ? { initialSource: raw.initialSource } : {}),
    ...(consoleOrigin ? { playgroundOrigin: consoleOrigin } : {}),
    ...(notebookOn && !sameOrigin && raw.playgroundOrigin
      ? { notebookOrigin: raw.playgroundOrigin }
      : {}),
    ...(raw.controls ? { controls: raw.controls } : {}),
    ...(raw.editableSnippets ? { editableSnippets: true } : {}),
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

function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * `notebook.assistant.climateclaw`: only with the notebook on, a host that is an HTTPS origin (or,
 * for a local notebook, a loopback one) and an auth API on that origin (the bearer is sent to the
 * host only).
 */
function resolveNotebookAssistant(
  raw: RawPythonPlaygroundBase,
  notebookOn: boolean,
  sameOrigin: boolean,
  where: PlaygroundWhere,
  bag: DiagnosticBag,
): NotebookAssistantSettings | undefined {
  const stanza = raw.notebook?.assistant?.climateclaw;
  if (!stanza) return undefined;
  const base = "/notebook/assistant/climateclaw";
  if (!notebookOn) {
    bag.error("FP1236", "The notebook assistant needs the notebook.", {
      ...at(where, "/notebook/assistant"),
      hint:
        "Set `notebook.enabled: true` (with `playgroundOrigin` or `deployment: same-origin`), " +
        "or remove `assistant`.",
    });
    return undefined;
  }
  let host: string;
  try {
    const url = new URL(stanza.host);
    const local = url.protocol === "http:" && isLoopback(url.hostname);
    if ((url.protocol !== "https:" && !local) || url.origin !== stanza.host.replace(/\/+$/, ""))
      throw new Error();
    host = url.origin;
  } catch {
    bag.error("FP1236", `'${stanza.host}' is not an HTTPS origin.`, {
      ...at(where, `${base}/host`),
      hint:
        "Give the Freva host as an origin only, e.g. https://freva.example.org " +
        "(or http://localhost:<port> for a local mock).",
    });
    return undefined;
  }
  // A loopback host is a developer's own machine: only a local notebook may point there. A
  // same-origin notebook's origin is the portal's, known only to the host: a warning, not a stop.
  if (new URL(host).protocol === "http:" && sameOrigin) {
    bag.warn("FP1236", `The loopback host '${host}' is for local development only.`, {
      ...at(where, `${base}/host`),
      hint: "A notebook served from anywhere but this machine cannot reach it.",
    });
  } else if (new URL(host).protocol === "http:") {
    let localNotebook = false;
    try {
      localNotebook = isLoopback(new URL(raw.playgroundOrigin ?? "").hostname);
    } catch {
      // No playground origin: the notebook check above has already said so.
    }
    if (!localNotebook) {
      bag.error("FP1236", `The loopback host '${host}' is for local development only.`, {
        ...at(where, `${base}/host`),
        hint: "Use it with a loopback `playgroundOrigin` (http://localhost:<port>), never a public one.",
      });
      return undefined;
    }
  }
  const authBaseUrl = (stanza.authBaseUrl ?? `${host}/api/freva-nextgen/auth/v2`).replace(
    /\/+$/,
    "",
  );
  try {
    if (new URL(authBaseUrl).origin !== host) throw new Error();
  } catch {
    bag.error("FP1236", "`authBaseUrl` must be on the Freva host's origin.", {
      ...at(where, `${base}/authBaseUrl`),
      hint: "The sign-in token is sent to the Freva host only; a second origin would receive it too.",
    });
    return undefined;
  }
  const examples = stanza.examples ?? [];
  const titles = new Set<string>();
  for (const [index, example] of examples.entries()) {
    const key = example.title.trim().toLowerCase();
    if (titles.has(key)) {
      bag.error("FP1236", `Two examples are both called '${example.title}'.`, {
        ...at(where, `${base}/examples/${index}/title`),
        hint: "Each example becomes a menu item and a slash command named after its title.",
      });
    }
    titles.add(key);
  }
  const resolved = {
    host,
    authBaseUrl,
    ...(stanza.expectedIssuer ? { expectedIssuer: stanza.expectedIssuer } : {}),
    defaultModel: stanza.defaultModel,
    ...(stanza.runAndFixModel ? { runAndFixModel: stanza.runAndFixModel } : {}),
    ...(stanza.scopeNote ? { scopeNote: stanza.scopeNote } : {}),
    examples: examples.map((e) => ({ title: e.title.trim(), prompt: e.prompt.trim() })),
    ...(stanza.previewOrigin ? { previewOrigin: stanza.previewOrigin } : {}),
    hideCodeByDefault: stanza.hideCodeByDefault === true,
  };
  return { ...resolved, fingerprint: fingerprintOf(resolved) };
}

/**
 * `notebook.dataPanel`, apart from the tree it names and its files: the resolver, which knows
 * the landing blocks and the source root, checks those.
 */
function resolveNotebookDataPanel(
  raw: RawPythonPlaygroundBase,
  notebookOn: boolean,
  where: PlaygroundWhere,
  bag: DiagnosticBag,
): NotebookDataPanelSettings | undefined {
  const stanza = raw.notebook?.dataPanel;
  if (!stanza) return undefined;
  if (!notebookOn) {
    bag.error("FP1237", "The notebook's data panel needs the notebook.", {
      ...at(where, "/notebook/dataPanel"),
      hint:
        "Set `notebook.enabled: true` (with `playgroundOrigin` or `deployment: same-origin`), " +
        "or remove `dataPanel`.",
    });
    return undefined;
  }
  const askWanted = stanza.launcher?.ask !== false;
  const resolved = {
    ...(stanza.title ? { title: stanza.title } : {}),
    ...(stanza.icon ? { icon: stanza.icon } : {}),
    tree: stanza.tree,
    defaultAction: stanza.defaultAction ?? "open-in-notebook",
    seedNotebooks: [...(stanza.seedNotebooks ?? [])],
    ...(stanza.startNotebook ? { startNotebook: stanza.startNotebook } : {}),
    gridlook: stanza.gridlook === true,
    launcher: {
      newNotebook: stanza.launcher?.newNotebook !== false,
      browse: stanza.launcher?.browse !== false,
      examples: stanza.launcher?.examples !== false,
      ask: askWanted && Boolean(raw.notebook?.assistant),
    },
  };
  if (stanza.defaultAction === "ask-climateclaw" && !raw.notebook?.assistant) {
    bag.error(
      "FP1237",
      "The data panel's default action asks ClimateClaw, but there is no assistant.",
      {
        ...at(where, "/notebook/dataPanel/defaultAction"),
        hint: "Configure `notebook.assistant.climateclaw`, or choose another default action.",
      },
    );
  }
  return { ...resolved, fingerprint: fingerprintOf(resolved) };
}

/**
 * `sessionChoices`, validated: every profile a real one, every add-on curated and compatible with
 * its profile, the configured setup among the choices, and the starter only where it can run.
 */
function resolveSessionChoices(
  raw: RawPythonPlaygroundBase,
  profile: string,
  addons: readonly string[],
  where: PlaygroundWhere,
  bag: DiagnosticBag,
): { policy: SessionPolicy; fingerprint: string } | undefined {
  const choices = raw.sessionChoices;
  if (!choices) return undefined;
  const base = "/sessionChoices";
  const profiles: Record<string, { allowedAddons: string[] }> = {};
  for (const [name, entry] of Object.entries(choices.profiles ?? {})) {
    if (!(PROFILES as readonly string[]).includes(name)) {
      bag.error("FP1219", `'${name}' is not a profile @freva-org/browser-python offers.`, {
        ...at(where, `${base}/profiles/${name}`),
        hint: `Available: ${PROFILES.join(", ")}.`,
      });
      continue;
    }
    const allowed: string[] = [];
    for (const [index, id] of (entry?.allowedAddons ?? []).entries()) {
      const description = ADDON_CATALOGUE[id as keyof typeof ADDON_CATALOGUE];
      if (!description) {
        bag.error("FP1219", `'${id}' is not a curated add-on.`, {
          ...at(where, `${base}/profiles/${name}/allowedAddons/${index}`),
          hint: `Available: ${ADDONS.join(", ")}.`,
        });
      } else if (!(description.profiles as readonly string[]).includes(name)) {
        bag.error("FP1219", `The '${id}' add-on does not work with the '${name}' profile.`, {
          ...at(where, `${base}/profiles/${name}/allowedAddons/${index}`),
          hint: `It is available on: ${description.profiles.join(", ")}.`,
        });
      } else if (!allowed.includes(id)) allowed.push(id);
    }
    profiles[name] = { allowedAddons: allowed.sort() };
  }
  if (!profiles[profile]) {
    bag.error("FP1219", `sessionChoices does not offer the configured profile '${profile}'.`, {
      ...at(where, `${base}/profiles`),
      hint: "The configured profile and add-ons are the default setup, so they must be a choice.",
    });
  } else {
    for (const [index, id] of addons.entries()) {
      if (profiles[profile].allowedAddons.includes(id)) continue;
      bag.error(
        "FP1219",
        `The configured add-on '${id}' is not allowed on '${profile}' in sessionChoices.`,
        {
          ...at(where, `/addons/${index}`),
          hint: `Add it to sessionChoices.profiles.${profile}.allowedAddons, or remove it from addons.`,
        },
      );
    }
  }
  const starter = Boolean(raw.initialSource);
  if (choices.starterProfiles && !starter) {
    bag.error("FP1219", "sessionChoices.starterProfiles is set, but there is no initialSource.", {
      ...at(where, `${base}/starterProfiles`),
      hint: "starterProfiles says where the starter code runs; without initialSource there is none.",
    });
  }
  const starterProfiles: string[] = [];
  for (const [index, name] of (choices.starterProfiles ?? (starter ? [profile] : [])).entries()) {
    if (!profiles[name]) {
      bag.error("FP1219", `starterProfiles names '${name}', which sessionChoices does not offer.`, {
        ...at(where, `${base}/starterProfiles/${index}`),
      });
    } else if (!starterProfiles.includes(name)) starterProfiles.push(name);
  }
  starterProfiles.sort();
  const notebook =
    raw.notebook?.enabled === true &&
    (raw.notebook.deployment === "same-origin" || Boolean(raw.playgroundOrigin));
  const policy: SessionPolicy = {
    profiles,
    starter,
    starterProfiles: starter ? starterProfiles : [],
    allowSkipStarter: choices.allowSkipStarter === true,
    notebook,
    defaults: {
      profile,
      addons: [...addons].sort(),
      runStarter: starter && starterProfiles.includes(profile),
      frontend: "console",
    },
  };
  return { policy, fingerprint: policyFingerprint(policy) };
}

/**
 * The session policy every front end validates against: the configured one, or the single setup a
 * portal without `sessionChoices` has.
 */
export function sessionPolicyOf(settings: PlaygroundSettings): SessionPolicy {
  if (settings.sessionChoices) return settings.sessionChoices.policy;
  const starter = Boolean(settings.initialSource);
  return {
    profiles: { [settings.profile]: { allowedAddons: [...settings.addons].sort() } },
    starter,
    starterProfiles: starter ? [settings.profile] : [],
    allowSkipStarter: false,
    notebook: settings.notebook,
    defaults: {
      profile: settings.profile,
      addons: [...settings.addons].sort(),
      runStarter: starter,
      frontend: "console",
    },
  };
}

/** The starter choices a profile offers: on, off, or both when a visitor may skip it. */
export function starterRuns(policy: SessionPolicy, profile: string): boolean[] {
  const applies = policy.starter && policy.starterProfiles.includes(profile);
  if (!applies) return [false];
  return policy.allowSkipStarter ? [true, false] : [true];
}

/** Every profile a session may run, the configured one first. */
export function allowedProfiles(
  settings: Pick<PlaygroundSettings, "profile" | "sessionChoices">,
): string[] {
  const others = Object.keys(settings.sessionChoices?.policy.profiles ?? {}).filter(
    (name) => name !== settings.profile,
  );
  return [settings.profile, ...others.sort()];
}

/** Every add-on any allowed setup may load: what the materials and the policy must cover. */
export function allowedAddons(
  settings: Pick<PlaygroundSettings, "addons" | "sessionChoices">,
): string[] {
  const all = new Set(settings.addons);
  for (const entry of Object.values(settings.sessionChoices?.policy.profiles ?? {})) {
    for (const id of entry.allowedAddons) all.add(id);
  }
  return [...all].sort();
}

/**
 * The profile whose network needs the page's policy must cover: one that installs from a package
 * index if any allowed profile does, else the configured one.
 */
export function policyProfile(profile: string, policy: SessionPolicy | undefined): string {
  const names = [profile, ...Object.keys(policy?.profiles ?? {})];
  return names.find((name) => profileNeedsPackageIndex(name)) ?? profile;
}

/**
 * The separate origin a playground deploys to, if any: the console's, or - with `consoleInPage` -
 * the notebook's alone. One child artifact serves either.
 */
export function secondOrigin(
  settings: Pick<PlaygroundSettings, "playgroundOrigin" | "notebookOrigin"> | undefined,
): string | undefined {
  return settings?.playgroundOrigin ?? settings?.notebookOrigin;
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
    notebookOrigin: settings.notebookOrigin ?? null,
    notebookSameOrigin: settings.notebookSameOrigin === true,
    notebookMetaPolicy: settings.notebookMetaPolicy === true,
    runtimeIndexUrl: settings.runtimeIndexUrl ?? null,
    wheelhouseUrl: settings.wheelhouseUrl ?? null,
    addonBaseUrl: settings.addonBaseUrl ?? null,
    connectOrigins: [...settings.connectOrigins].sort().join(","),
    persistCredentials: settings.persistCredentials,
    "terminal.osControls": settings.terminal.osControls,
    "terminal.alwaysOnTop": settings.terminal.alwaysOnTop,
    "terminal.rememberAppearance": settings.terminal.rememberAppearance,
    // The choice policy is one page-wide decision too: a page has one chooser and one CSP.
    sessionChoices: settings.sessionChoices?.fingerprint ?? null,
    notebook: settings.notebook,
    maxLiveSessions: settings.maxLiveSessions,
    // What the notebook carries is the page's too: one notebook site per portal.
    notebookAssistant: settings.notebookAssistant?.fingerprint ?? null,
    notebookDataPanel: settings.notebookDataPanel?.fingerprint ?? null,
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

/** Whether starter code asks for `PORTAL_BASE_URL` (a mention in a comment counts too). */
export function usesPortalBase(source: string | undefined): boolean {
  return Boolean(source && /\bPORTAL_BASE_URL\b/.test(source));
}

/**
 * `PORTAL_BASE_URL`: the portal's root URL, where its published files are. On the portal's own
 * origin it is the base path, resolved where the interpreter runs, so one build serves the same
 * files at `/` and `/showroom/`, locally and on its host; on another origin (`origin`), the
 * portal's full URL. Defined unseen at every start; the starter runs and shows as written.
 */
export function portalBaseUrl(basePath: string, origin?: string): string {
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return origin ? `${origin.replace(/\/+$/, "")}${base}` : base;
}
