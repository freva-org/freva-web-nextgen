/**
 * Publishing the Cosmos scene's artwork into an artifact.
 *
 * What is published is the sky art: a star sphere, a moon and a sun, exported once by
 * `scripts/export-cosmos-art.mjs` and committed, plus the manifest recording what they were drawn
 * for. No object bodies are published. This file is the only thing in the builder that knows
 * those files exist: it copies them into the artifact, works out the one URL the island needs,
 * and hands back a record. It does not decode an image and does not know what the scene draws.
 *
 * A portal on `default`, `freva`, `waterpark` or `contour` must not contain one byte of this -
 * the same rule the footer badge and every optional component follow - so this returns
 * `undefined` unless the resolved theme asked for the Cosmos backdrop, and nothing is copied,
 * hashed or linked.
 *
 * Content addressing: the files are published under a directory named for the digest of the whole
 * set. The scene's registry names its files by plain filename, and those names are also the
 * replacement contract documented beside the assets, so hashing each filename would break both.
 * Hashing the directory keeps the filenames intact and still guarantees that a changed file
 * produces a changed URL.
 */

import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { DiagnosticBag } from "../diagnostics.js";
import { PACKAGE_ROOT, sha256 } from "../util/package.js";

/** Where the bodies live in the package. Beside the renderer that names them. */
const SOURCE_DIR = join(PACKAGE_ROOT, "client", "components", "cosmos", "scene");

/** Where they land in the artifact. Underscored, like `_portal` and `_badge`. */
const ROOT = "_cosmos";

/**
 * The sky's pre-generated artwork - the whole published set, under `sky/`.
 *
 * `MANIFEST.json` travels with them on purpose: it records the geometry the art was drawn for and
 * every file's intrinsic size, which is what makes "pre-generated" auditable rather than a claim.
 * `tests/artifact/cosmos-theme.test.ts` asserts the renderer names exactly these files and that
 * no object body is published, so the two cannot drift apart.
 */
const SKY_ART = [
  "sky/MANIFEST.json",
  "sky/moon.webp",
  "sky/sky-sphere.webp",
  "sky/sun.webp",
] as const;

export interface CosmosPublication {
  /** The URL the island stamps on the canvas. Trailing slash is load-bearing. */
  assetBase: string;
  /** Published bytes by artifact-relative path. */
  contents: Map<string, Buffer>;
  /** One input-manifest row per published file, so the build stays auditable. */
  inputs: { path: string; role: string; digest: string; bytes: number }[];
}

/**
 * Copy the scene artwork, if this build is a Cosmos build.
 *
 * @param backdrop the resolved theme's backdrop, or undefined
 * @param basePath the site's base path, already normalised with a trailing slash
 */
export function publishCosmosScene(
  backdrop: "contour" | "cosmos" | undefined,
  basePath: string,
  bag: DiagnosticBag,
): CosmosPublication | undefined {
  if (backdrop !== "cosmos") return undefined;

  // The artwork is required, not present-or-absent: a Cosmos build without it is a Cosmos build
  // with no sky, a broken artifact that should say so at build time rather than at a reader's
  // screen.
  let names: string[];
  try {
    statSync(SOURCE_DIR);
    names = SKY_ART.filter((name) => {
      try {
        statSync(join(SOURCE_DIR, name));
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    names = [];
  }

  if (names.length !== SKY_ART.length) {
    const missing = SKY_ART.filter((name) => !names.includes(name));
    bag.error(
      "FP1211",
      "theme.preset is 'cosmos' but the scene's sky artwork is missing from the installed builder: " +
        missing.join(", "),
      { pointer: "/theme/preset" },
    );
    return undefined;
  }

  const files = names.map((name) => {
    const bytes = readFileSync(join(SOURCE_DIR, name));
    return { name, bytes, digest: sha256(bytes) };
  });

  // One digest over every file's name and content: any change to any file moves the whole
  // directory, and an unchanged set rebuilds to the identical URL.
  // `sha256()` returns a `sha256:`-prefixed string, so the hex starts after the colon.
  const setDigest = sha256(
    Buffer.from(files.map((f) => `${f.name}:${f.digest}`).join("\n"), "utf8"),
  )
    .split(":")[1]!
    .slice(0, 8);

  const contents = new Map<string, Buffer>();
  const inputs: CosmosPublication["inputs"] = [];
  for (const file of files) {
    contents.set(posix.join(ROOT, setDigest, file.name), file.bytes);
    inputs.push({
      path: `@freva-org/portal-builder/client/components/cosmos/scene/${file.name}`,
      role: "asset",
      digest: file.digest,
      bytes: file.bytes.byteLength,
    });
  }

  return { assetBase: `${basePath}${ROOT}/${setDigest}/`, contents, inputs };
}
