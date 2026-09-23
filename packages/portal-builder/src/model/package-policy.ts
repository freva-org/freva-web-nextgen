/**
 * What this playground may fetch a package from - one answer, read by both the policy and the
 * help. Two texts describing one deployment drift unless they are the same text: a help panel
 * offering `await micropip.install("name")` beside a Content-Security-Policy that names no
 * package index gives `ValueError: Can't fetch metadata for …` at lookup, before wheel
 * compatibility is even considered. So the origins below are computed once, from the resolved
 * playground, and used both to write the policy and to write what the help says.
 *
 * Which of two kinds a deployment gets is a configured decision. Curated, the default:
 *
 *   - packages in the pinned runtime load from the configured runtime mirror, on import;
 *   - the Freva client and the prepared add-ons install from pinned, digest-checked wheels on an
 *     origin the deployment controls;
 *   - a package a visitor names is not promised, and no external wheel URL is advertised;
 *   - a public package index is refused wherever a deployment tries to configure one.
 *
 * Open keeps all of that - the pinned runtime, the digest-checked wheels and the prepared add-ons
 * are the working starting environment, not a whitelist - and adds `micropip.install("name")`
 * against the public index plus any HTTPS wheel or data URL the visitor names, because a science
 * console for opening data from wherever it lives cannot enumerate its origins at deployment
 * time. The difference is one CSP scheme source, `https:` in `connect-src`, and no refusal of a
 * configured index; it is not a second policy system, since `@freva-org/browser-python` has
 * `network: "origins" | "https"` and this is that capability reaching configuration.
 *
 * Open does not change what this build distributes - the prepared artefacts are still
 * hash-checked and a mismatch is still a refusal, see
 * `packages/browser-python/src/worker/addons.ts` - it widens what a *visitor* may fetch for
 * themselves. It is not a sandbox either: a package the visitor installs runs in the same
 * interpreter as whatever that session holds, which is why `persistCredentials` stays off on the
 * portal's own origin and is warned about.
 */

import { PACKAGE_INDEX_ORIGINS, profileNeedsPackageIndex } from "@freva-org/browser-python";

import type { PlaygroundSettings } from "./types.js";

/** Origins a curated playground may reach for package artefacts, and where each one came from. */
export interface PackagePolicy {
  /**
   * Which of the two kinds this deployment resolved to. `"curated"` is the default; `"open"` is
   * reached only when a deployment asks for it in configuration.
   */
  kind: "curated" | "open";
  /**
   * Whether the visitor's Python may reach any TLS origin: true exactly when `kind` is `"open"`.
   * Its own field because the emitted `connect-src` is written from it, and a reader of a policy
   * object should not have to know that one word implies a scheme source.
   */
  anyHttpsOrigin: boolean;
  /**
   * Whether a PUBLIC PACKAGE INDEX is among `origins`, because the chosen profile's startup
   * reaches one.
   *
   * Its own field rather than something a reader infers from the origin list, because it changes
   * what is true of the deployment: an index in `connect-src` is reachable by anything running in
   * the page, so a visitor can install other packages from it. `kind` still says what the
   * deployment DECLARED; this says what the profile COSTS.
   */
  packageIndex: boolean;
  /** Exactly the origins the interpreter may fetch package artefacts from. Sorted, deduplicated. */
  origins: string[];
  /** Which configured value contributed each origin, for a help panel that has to say it in words. */
  sources: {
    runtime: string;
    /** Present only when the deployment configured one elsewhere; it defaults beside the runtime. */
    wheelhouse?: string;
    /** Present only when the deployment configured one elsewhere; it defaults beside the runtime. */
    addons?: string;
  };
}

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/**
 * Resolve the package policy for one playground. `runtimeFallback` is the pinned CDN the engine
 * uses when a deployment mirrors nothing. The wheelhouse and add-on directory default to
 * directories beside the runtime, so a deployment configuring neither contributes no origin
 * beyond the runtime's, and the policy says that rather than naming an unused location.
 */
export function resolvePackagePolicy(
  settings: Pick<PlaygroundSettings, "runtimeIndexUrl" | "wheelhouseUrl" | "addonBaseUrl">,
  runtimeFallback: string,
  network: "origins" | "https" = "origins",
  profile: string = "minimal",
): PackagePolicy {
  const open = network === "https";
  // THE PROFILE'S OWN REQUIREMENT, which is not the deployment's to withhold. `freva-client`
  // installs its wheel with dependency resolution enabled, so micropip reaches PyPI during
  // startup; a curated policy naming no index produces a build that succeeds and an interpreter
  // that fails at metadata lookup, which is the failure this whole module exists to prevent.
  // `@freva-org/browser-python` states which profiles this applies to, because it is that
  // package's install behaviour that creates the requirement.
  const packageIndex = !open && profileNeedsPackageIndex(profile);
  // The refusal applies to curated deployments only: in open mode `https:` is already in
  // `connect-src`, so dropping a configured index origin from this list would remove it from the
  // help panel while the browser permitted it anyway - the exact two-texts-one-deployment drift
  // this module exists to prevent.
  const keep = (origin: string | undefined): string | undefined =>
    origin && (open || !isRefusedPackageOrigin(origin)) ? origin : undefined;
  // A refused runtime origin falls back rather than vanishing: the runtime is not optional, and a
  // policy with no runtime origin would produce a page whose interpreter cannot load at all, a
  // confusing second failure on top of the build error the settings resolver already raised.
  const configuredRuntime = keep(originOf(settings.runtimeIndexUrl ?? runtimeFallback));
  const runtime = configuredRuntime ?? originOf(runtimeFallback) ?? runtimeFallback;
  const wheelhouse = keep(settings.wheelhouseUrl ? originOf(settings.wheelhouseUrl) : undefined);
  const addons = keep(settings.addonBaseUrl ? originOf(settings.addonBaseUrl) : undefined);
  const origins = [
    ...new Set(
      [
        runtime,
        wheelhouse,
        addons,
        // The two hosts micropip uses, and only those - not the refusal list, which also carries
        // `test.pypi.org`, and not a scheme source. An open deployment already has `https:` in
        // `connect-src`, so naming them there would add nothing.
        ...(packageIndex ? PACKAGE_INDEX_ORIGINS : []),
      ].filter((o): o is string => Boolean(o)),
    ),
  ];
  origins.sort();
  return {
    kind: open ? "open" : "curated",
    anyHttpsOrigin: open,
    packageIndex: packageIndex || open,
    origins,
    sources: {
      runtime,
      ...(wheelhouse ? { wheelhouse } : {}),
      ...(addons ? { addons } : {}),
    },
  };
}

/**
 * Origins a curated deployment refuses to write into any policy, whatever it configures.
 *
 * A public package index is not a data origin: reaching one lets a visitor install code into an
 * interpreter that already holds whatever the session holds - in-memory Freva tokens, persisted
 * credentials, same-origin storage, the configured service origins. A curated deployment wants a
 * fixed, reviewable environment, so it refuses loudly at build time against the field that named
 * the index. An open deployment has made that trade deliberately in its configuration and this
 * list does not apply to it; reaching open mode requires `network: "https"` to be written down.
 *
 * IT DOES NOT COVER A PROFILE'S OWN REQUIREMENT. `freva-client` resolves its dependencies from
 * PyPI at startup, so `resolvePackagePolicy` adds those two hosts for that profile whatever this
 * list says. The difference is who chose: a deployment that WRITES an index into a configuration
 * field is refused, and a deployment that SELECTS a profile which needs one is told - in the
 * help panel, and in `packageIndex` - rather than silently given a page that cannot start.
 */
export const REFUSED_PACKAGE_ORIGINS: readonly string[] = [
  "https://pypi.org",
  "https://files.pythonhosted.org",
  "https://test.pypi.org",
];

/**
 * Whether an origin is one of the public indexes a curated build will not write into a policy.
 *
 * Applied in two places, both of which check the mode first. `resolvePlaygroundSettings` calls it
 * so a curated deployment that configures one gets a build error naming the field; this module
 * calls it again above so a caller that ignored the diagnostic still cannot end up with a curated
 * `PackagePolicy` carrying a package index.
 */
export function isRefusedPackageOrigin(origin: string): boolean {
  return REFUSED_PACKAGE_ORIGINS.includes(origin);
}
