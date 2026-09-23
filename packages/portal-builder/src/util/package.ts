// Where the builder's own files are, and what they hash to. The published schema and profile
// digests end up in `BUILDINFO.json`, so they are read from the packaged files rather than an
// in-memory copy: the artifact should identify the bytes a consumer can actually fetch.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `<package>/`, whether running from `src/` (tests, tsx) or `dist/` (published). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SCHEMA_DIR = join(PACKAGE_ROOT, "schema");
export const ASTRO_DIR = join(PACKAGE_ROOT, "astro");

interface PackageJson {
  name: string;
  version: string;
}

let cachedPkg: PackageJson | undefined;

export function packageInfo(): PackageJson {
  if (!cachedPkg) {
    cachedPkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as PackageJson;
  }
  return cachedPkg;
}

/** The canonical package URL used by every manifest reference to a framework file. */
export function packagePurl(): string {
  const { name, version } = packageInfo();
  return `pkg:npm/${name.replace("@", "%40")}@${version}`;
}

export function sha256(data: Buffer | string): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export function readSchemaFile(name: string): string {
  return readFileSync(join(SCHEMA_DIR, name), "utf8");
}

export function schemaDigest(name: string): string {
  return sha256(readFileSync(join(SCHEMA_DIR, name)));
}
