/**
 * The build's half of the live-archive recipes. The templates are data in
 * `schema/tree-recipes.json`, read through `recipe-templates.ts` and rendered by
 * `client/components/tree-recipes.ts`; this file registers them - hashes each template, decides
 * which the configured interpreter profile can execute, and says so when one cannot.
 *
 * The digest is over the template because a live archive's stores are discovered in a visitor's
 * browser, so no build could hash a snippet for one. A recipe is a fixed program with one hole,
 * so name and digest still identify the program that runs; the store is a parameter, validated in
 * the page against the configured endpoint and declared roots before it goes near the hole.
 */

import { TREE_RECIPES, runnableRecipes } from "./recipe-templates.js";
import type { DiagnosticBag } from "../diagnostics.js";
import { resolvePlaygroundSettings } from "./python-playground.js";
import type { PlaygroundSettings, PythonPlaygroundData, RegisteredExampleDigest } from "./types.js";
import type { RawDatasetTreePython } from "../config/types.js";
import { sha256 } from "../util/package.js";

/**
 * What each browser-python profile loads. Mirrored rather than imported:
 * `@freva-org/browser-python` keeps this list inside its worker bundle, a Web Worker entry a Node
 * build cannot import without dragging the whole interpreter in. `profile-packages.test.ts`
 * compares the two, so a profile that gains a package upstream fails this build until the copy is
 * updated.
 */
export const PROFILE_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  minimal: [],
  "xarray-zarr": ["xarray", "zarr", "fsspec", "numcodecs", "micropip"],
  "freva-client": ["xarray", "zarr", "fsspec", "numcodecs", "micropip", "pygments"],
};

/**
 * The resolved values of the fields this stanza actually wrote: one entry per key a
 * `dataset-tree` block's `python` stanza may carry. The portal-wide fields it cannot carry -
 * add-ons, connect origins, credential persistence, asset locations - are absent by construction,
 * so always the portal's.
 */
function written(raw: RawDatasetTreePython, own: PlaygroundSettings): Partial<PlaygroundSettings> {
  const out: Partial<PlaygroundSettings> = {};
  if (raw.profile !== undefined) out.profile = own.profile;
  if (raw.autostart !== undefined) out.autostart = own.autostart;
  if (raw.maxSessions !== undefined) out.maxSessions = own.maxSessions;
  if (raw.network !== undefined) out.network = own.network;
  if (raw.initialSource !== undefined && own.initialSource !== undefined) {
    out.initialSource = own.initialSource;
  }
  if (raw.playgroundOrigin !== undefined && own.playgroundOrigin !== undefined) {
    out.playgroundOrigin = own.playgroundOrigin;
  }
  if (raw.runtimeIndexUrl !== undefined && own.runtimeIndexUrl !== undefined) {
    out.runtimeIndexUrl = own.runtimeIndexUrl;
  }
  if (raw.terminal !== undefined) out.terminal = own.terminal;
  return out;
}

/** `recipe:<id>`, the name a page uses and the build registers. */
export const recipeExampleId = (id: string): string => `recipe:${id}`;

/**
 * Register the templates, and report the ones this profile cannot run.
 *
 * Every recipe is shown whatever the profile - it is documentation, and a reader may copy one
 * into an environment that does have the packages. Only the runnable ones get a digest, which is
 * what the component's eligibility rule reads, so the others appear with Copy and no run control.
 *
 * The note is an `info`, not a warning: a profile carrying no xarray is a legitimate
 * configuration - a portal may want a console without the science stack - and a copy-only recipe
 * is not a misconfiguration. Not knowing why the button is missing would be.
 */
export function livePythonPlayground(
  raw: RawDatasetTreePython | undefined,
  instanceId: string,
  bag: DiagnosticBag,
  where: { file: string; pointer: string },
  store: PythonPlaygroundData["store"],
  inherit?: PlaygroundSettings,
): PythonPlaygroundData | undefined {
  if (!raw || raw.enabled !== true) return undefined;
  // The profile is the portal's unless this block named one, and so is everything else the
  // block's stanza cannot say: a block resolved in isolation would get `minimal`, no add-ons and
  // no asset URLs, and contradict the portal stanza about the one interpreter the page has. See
  // `inherit` and the note at the call site.
  const profile = raw.profile ?? inherit?.profile ?? "minimal";
  const packages = PROFILE_PACKAGES[profile] ?? [];
  // A framed playground cannot run a template, and that is decided here rather than discovered by
  // a visitor. The store filling a recipe's one hole is a parameter: the page validates a node id
  // against this build's endpoint and declared roots and substitutes it before the source reaches
  // an interpreter. That works only in this document. Across the embed boundary the message a
  // parent may send a playground origin is
  // `{ kind: "run-example", exampleId, digest, targetSession }`, with nowhere for a parameter - by
  // design, since the point of that protocol is that a name and a digest cross and source never
  // does. Widening the message would weaken that contract, so on a framed build every recipe is
  // shown, copyable, with no run control, and the gap is reported to the operator here rather
  // than left as a Try button that opens a window to say the example was refused.
  const framedOrigin = raw.playgroundOrigin ?? inherit?.playgroundOrigin;
  const framed = typeof framedOrigin === "string" && framedOrigin.length > 0;
  const runnable = framed ? new Set<string>() : new Set(runnableRecipes(packages));

  const examples: RegisteredExampleDigest[] = [];
  const recipeDigests: Record<string, string> = {};
  const withheld: string[] = [];
  for (const recipe of TREE_RECIPES) {
    const id = recipeExampleId(recipe.id);
    // Bare hex, without this repository's usual `sha256:` prefix, like the catalogue's registered
    // examples: the value crosses into `@freva-org/browser-python`, whose registry accepts a
    // lowercase hex SHA-256 and refuses anything else as malformed. The component's eligibility
    // check reads it the same way, so a prefixed digest silently removes the run control.
    const digest = sha256(Buffer.from(recipe.template, "utf8")).replace(/^sha256:/, "");
    recipeDigests[recipe.id] = digest;
    if (!runnable.has(recipe.id)) {
      withheld.push(
        framed ? recipe.label : `${recipe.label} (needs ${recipe.requires.join(", ")})`,
      );
      continue;
    }
    examples.push({ id, datasetId: instanceId, exampleId: recipe.id, sha256: digest });
  }

  if (framed) {
    bag.info(
      "FP1217",
      `This block's playground runs on a separate origin, and an access recipe needs the store ` +
        `substituted into it. The embed protocol carries an example name and a digest and no ` +
        `parameters, so the ${TREE_RECIPES.length} recipes are shown without a run control: ` +
        `${withheld.join("; ")}.`,
      {
        file: where.file,
        pointer: `${where.pointer}/python/playgroundOrigin`,
        hint:
          "Remove `playgroundOrigin` to run recipes in the portal's own document, or keep the " +
          "separate origin and treat the recipes as documentation to copy.",
      },
    );
  } else if (withheld.length > 0) {
    bag.info(
      "FP1217",
      `The '${profile}' interpreter profile cannot run ${withheld.length} of the ` +
        `${TREE_RECIPES.length} access recipes, so they are shown without a run control: ` +
        `${withheld.join("; ")}.`,
      {
        file: where.file,
        pointer: `${where.pointer}/python/profile`,
        hint:
          profile === "minimal"
            ? "The 'xarray-zarr' profile carries xarray, zarr and fsspec, which is what the HTTP recipe needs."
            : "A recipe whose packages this profile does not carry is documentation; it is shown and copyable.",
      },
    );
  }

  const own = resolvePlaygroundSettings(raw, where, bag);
  /* istanbul ignore next - `raw.enabled` was checked by the caller. */
  if (!own) throw new Error("livePythonPlayground called for a disabled block");
  // Inherit, then override only what was written. Keyed off the raw stanza rather than the
  // resolved one, because a resolved value carries a default indistinguishable from a choice:
  // `own.profile` is `"minimal"` both for a block that asked for it and for one that said
  // nothing. What the author wrote is the only thing that can override the portal.
  const settings = inherit ? { ...inherit, ...written(raw, own) } : own;
  return {
    ...settings,
    examples: examples.sort((a, b) => a.id.localeCompare(b.id)),
    recipes: [...runnable].sort(),
    recipeDigests,
    ...(store ? { store } : {}),
  };
}

/**
 * The source of each registered recipe, for the page's own manifest: the template, not a rendered
 * snippet. It is what the digest covers, and the page substitutes the validated store at press.
 */
export function liveRecipeSources(): { id: string; title: string; source: string }[] {
  return TREE_RECIPES.map((recipe) => ({
    id: recipeExampleId(recipe.id),
    title: recipe.label,
    source: recipe.template,
  }));
}
