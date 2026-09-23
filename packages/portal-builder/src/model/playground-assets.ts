/**
 * Where the playground's static assets come from, and the combination that cannot work.
 *
 * `wheelhouseUrl` and `addonBaseUrl` both default to a directory beside the runtime -
 * `../freva-wheels/` and `../python-addons/` resolved against the Pyodide index URL. For a
 * deployment that mirrors Pyodide onto its own origin that is a kindness: copy the three
 * directories together and configure nothing. For one that leaves the runtime on the pinned
 * public CDN it resolves to `https://cdn.jsdelivr.net/pyodide/v314.0.6/freva-wheels/` and
 * `.../python-addons/`, directories that do not exist on a host this project does not control,
 * and the browser finds out at start as a 403 in a terminal.
 *
 * So the sibling default is valid when the runtime is self-hosted and a build error when it is
 * not - unless this build was handed the files, in which case they are served from the artifact's
 * own origin and the question does not arise. The ordinary answer to "where do the wheels come
 * from" is "this portal serves them", not "some URL an operator typed".
 */

import { DEFAULT_PYODIDE_INDEX_URL } from "@freva-org/browser-python";
import type { DiagnosticBag } from "../diagnostics.js";
import type { PlaygroundSettings } from "./types.js";
import { ADDONS_DIR, WHEELHOUSE_DIR } from "./python-materials.js";

/** Where one class of asset is served from, and why it ended up there. */
export interface AssetSource {
  url: string;
  origin: "artifact" | "configured" | "beside-runtime";
}

export interface PlaygroundAssetSources {
  wheelhouse?: AssetSource;
  addons?: AssetSource;
}

/** True when the runtime is the pinned public CDN rather than something this deployment serves. */
export function runtimeIsDefaultCdn(settings: { runtimeIndexUrl?: string | undefined }): boolean {
  return !settings.runtimeIndexUrl;
}

interface ResolveAssetsOptions {
  settings: PlaygroundSettings;
  /** True when this build was handed prepared materials and will serve them itself. */
  materialsIncorporated: boolean;
  /**
   * The site's own base path, e.g. `/` or `/portal/`. A root-relative URL is what the artifact
   * gets when it serves the files itself, and it is the one answer that survives deployment: a
   * preview on 127.0.0.1:4321, a staging host and production all serve the same bytes from the
   * same path, so nothing is rewritten per-environment and no `portal.yaml` names a loopback
   * address such as `http://127.0.0.1:4321/`.
   */
  basePath: string;
  file: string;
  pointer: string;
  bag: DiagnosticBag;
}

const at = (file: string, pointer: string): { file: string; pointer: string } => ({
  file,
  pointer,
});

/**
 * Decide where the wheels and add-on artefacts come from, and refuse the impossible combination.
 * Each step is a statement rather than a fallback:
 *
 *   1. an explicit `wheelhouseUrl`/`addonBaseUrl` always wins - a deployment that hosts its
 *      materials elsewhere keeps doing so;
 *   2. otherwise, incorporated materials are served from the artifact's own path;
 *   3. otherwise, the sibling-of-the-runtime default - valid only when the runtime is self-hosted;
 *   4. otherwise, a build error naming the key, the command, and why the default cannot work here.
 */
export function resolvePlaygroundAssets(options: ResolveAssetsOptions): PlaygroundAssetSources {
  const { settings, materialsIncorporated, basePath, bag, file, pointer } = options;
  const sources: PlaygroundAssetSources = {};
  const selfHosted = !runtimeIsDefaultCdn(settings);
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;

  const decide = (
    configured: string | undefined,
    key: "wheelhouseUrl" | "addonBaseUrl",
    dir: string,
    why: string,
    prepared: string,
  ): AssetSource | undefined => {
    if (configured) return { url: configured, origin: "configured" };
    if (materialsIncorporated) return { url: `${base}${dir}/`, origin: "artifact" };
    if (selfHosted) {
      return {
        url: new URL(`../${dir}/`, settings.runtimeIndexUrl!).href,
        origin: "beside-runtime",
      };
    }
    // The refusal names the key a reader would edit, the command that makes the files, and why
    // the default is wrong here and right elsewhere: "set this option" without "and here is why
    // the default cannot work" is the kind of diagnostic that gets worked around.
    bag.error("FP1223", `The Python playground ${why}, and this build has no way to serve them.`, {
      ...at(file, pointer),
      hint:
        `pythonPlayground.${key} is not set, no Python materials were supplied, and the runtime ` +
        `is still the pinned public Pyodide CDN - so the default location resolves to ` +
        `${new URL(`../${dir}/`, DEFAULT_PYODIDE_INDEX_URL).href}, a directory that does not ` +
        `exist on a host this project does not control. "Beside the runtime" is a valid layout ` +
        `for a deployment that mirrors Pyodide onto its own origin; it is not a valid layout for ` +
        `the public CDN.\n` +
        `Pick one:\n` +
        `  - let this portal serve them: freva-portal-builder prepare-playground --out ` +
        `.python-materials, then build with --python-materials .python-materials;\n` +
        `  - or host them yourself and set pythonPlayground.${key} to where they are served ` +
        `(prepare them with \`${prepared}\`);\n` +
        `  - or mirror the Pyodide runtime with pythonPlayground.runtimeIndexUrl and put ` +
        `${dir}/ beside it.`,
    });
    return undefined;
  };

  // A wheelhouse is a property of the profile: only `freva-client` installs the Freva wheel at
  // startup, so a portal on `minimal` or `xarray-zarr` needs none and is not asked. Hence the
  // check is against the profile, not against whether the key is set.
  if (settings.profile === "freva-client") {
    const source = decide(
      settings.wheelhouseUrl,
      "wheelhouseUrl",
      WHEELHOUSE_DIR,
      "uses the freva-client profile, which installs the Freva client's wheels at startup",
      "freva-browser-python prepare-freva-wheelhouse",
    );
    if (source) sources.wheelhouse = source;
  }

  if (settings.addons.length > 0) {
    const source = decide(
      settings.addonBaseUrl,
      "addonBaseUrl",
      ADDONS_DIR,
      `has ${settings.addons.length === 1 ? "an add-on" : "add-ons"} configured ` +
        `(${settings.addons.join(", ")}), whose artefacts are static files`,
      "freva-browser-python prepare-addons",
    );
    if (source) sources.addons = source;
  }

  return sources;
}
