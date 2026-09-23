// Artifact verification: the bytes match the checksums, the manifests match their published
// schemas, every recorded route has a real file, and the recorded evidence agrees with what is
// present. It deliberately does not reconstruct the source graph from minified output - that
// is what `component-evidence.json`, recorded during the build, is for.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DiagnosticBag } from "../diagnostics.js";
import { validateAgainst } from "../config/schema.js";
import { checkManifestIdentity } from "./identity.js";
import { sha256 } from "../util/package.js";

interface PortalManifest {
  site: { basePath: string; canonicalUrl: string };
  routes: { path: string; file: string; kind: string }[];
  components: { id: string; kind: string; enabled: boolean; route?: string }[];
  files: { path: string; mimeType: string; cacheClass: string }[];
}

interface ComponentEvidence {
  components: {
    id: string;
    enabled: boolean;
    ownedStaticRoots: string[];
    assetNamespaces: string[];
    modules: string[];
    copiedFiles: string[];
  }[];
  graph: {
    modules: string[];
    copiedFiles: string[];
    chunks: { file: string; modules: string[] }[];
  };
}

function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

export function verifyArtifact(dir: string): DiagnosticBag {
  const bag = new DiagnosticBag();
  const required = [
    "index.html",
    // The status documents are named in the manifest and checked against it below; 404 is
    // called out here because a host with no error configuration still falls back to it.
    "404.html",
    "portal-manifest.json",
    "input-manifest.json",
    "component-evidence.json",
    "host-policy.json",
    "BUILDINFO.json",
    "checksums.sha256",
  ];
  for (const name of required) {
    if (!existsSync(join(dir, name))) {
      bag.error("FP1603", `The artifact is missing '${name}'.`, { file: name });
    }
  }
  if (bag.errors.length > 0) return bag;

  // Checksums.
  const present = new Set(listFiles(dir));
  const recorded = new Map<string, string>();
  for (const line of readFileSync(join(dir, "checksums.sha256"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const [digest, ...rest] = line.split("  ");
    recorded.set(rest.join("  "), digest!);
  }
  for (const [path, digest] of recorded) {
    if (!present.has(path)) {
      bag.error("FP1603", `checksums.sha256 lists '${path}', which is not in the artifact.`, {
        file: path,
      });
      continue;
    }
    const actual = sha256(readFileSync(join(dir, ...path.split("/")))).replace("sha256:", "");
    if (actual !== digest) {
      bag.error("FP1603", `'${path}' does not match its recorded checksum.`, { file: path });
    }
  }
  for (const path of present) {
    if (path !== "checksums.sha256" && !recorded.has(path)) {
      bag.error("FP1603", `'${path}' is in the artifact but not in checksums.sha256.`, {
        file: path,
      });
    }
  }

  // Manifests against their published schemas.
  const manifests = [
    ["portal-manifest.json", "portalManifest"],
    ["input-manifest.json", "inputManifest"],
    ["component-evidence.json", "componentEvidence"],
    ["host-policy.json", "hostPolicy"],
    ["BUILDINFO.json", "buildinfo"],
  ] as const;
  const parsedManifests = new Map<string, unknown>();
  for (const [name, schema] of manifests) {
    const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
    parsedManifests.set(name, parsed);
    bag.merge(validateAgainst(schema, parsed, name).diagnostics);
  }

  const portal = JSON.parse(
    readFileSync(join(dir, "portal-manifest.json"), "utf8"),
  ) as PortalManifest;
  const evidence = JSON.parse(
    readFileSync(join(dir, "component-evidence.json"), "utf8"),
  ) as ComponentEvidence;

  // Routes.
  for (const route of portal.routes) {
    if (!present.has(route.file)) {
      bag.error("FP1603", `Route '${route.path}' has no file '${route.file}' in the artifact.`, {
        file: route.file,
      });
    }
  }

  // Manifests describe the same file set.
  for (const file of portal.files) {
    if (!present.has(file.path)) {
      bag.error("FP1603", `portal-manifest.json lists '${file.path}', which is absent.`, {
        file: file.path,
      });
    }
  }

  // Disabled components left nothing behind.
  for (const component of evidence.components) {
    if (component.enabled) continue;
    for (const root of component.ownedStaticRoots) {
      for (const path of present) {
        if (path === root || path.startsWith(`${root}/`)) {
          bag.error(
            "FP1602",
            `Component '${component.id}' is disabled but '${path}' is present in the artifact.`,
            { file: path },
          );
        }
      }
    }
    for (const namespace of component.assetNamespaces) {
      for (const path of present) {
        if (path.startsWith(namespace)) {
          bag.error(
            "FP1602",
            `Component '${component.id}' is disabled but the asset namespace '${namespace}' is present ('${path}').`,
            { file: path },
          );
        }
      }
    }
    if (component.modules.length > 0) {
      bag.error(
        "FP1601",
        `Component '${component.id}' is disabled but component-evidence.json records ${component.modules.length} owned modules.`,
      );
    }
  }

  // Every manifest string is build identity, by role. Not a search for known-bad prefixes:
  // each string is located by pointer, given the role its schema declares, and checked against
  // that role's closed grammar. An unclassified field fails, so this cannot fall behind.
  for (const [name] of manifests) {
    checkManifestIdentity(name, parsedManifests.get(name), bag);
  }

  // Size sanity.
  const total = [...present].reduce((sum, p) => sum + statSync(join(dir, ...p.split("/"))).size, 0);
  bag.info("FP1603", `Artifact contains ${present.size} files, ${total} bytes.`);

  return bag;
}
