// Structured identity checking for the artifact's manifests (C7).
//
// A published manifest describes the *build*, not the *machine that ran it*: two builds of the
// same inputs on two different checkouts must produce identical manifests, so nothing in them
// may be a caller's directory, a temporary path or a resolved local file. The check is
// positive rather than negative, because grepping the JSON for `/home/` and `/Users/` misses
// every root nobody thought of (`/workspace`, `/root`, `/opt`, `/builds`, `/mnt`, a UNC share)
// and cannot see a caller-specific value that does not look like a path. Every string is
// located by JSON Pointer, assigned the role its schema gives it, and checked against that
// role's closed grammar; a string whose pointer has no declared role is itself an error, so a
// field added without saying what kind of value it holds fails verification and this table
// cannot quietly fall behind the manifests it describes.

import type { DiagnosticBag } from "../diagnostics.js";
import { rawPathReason } from "../config/raw-path.js";

export type ValueRole =
  | "identifier"
  | "token"
  | "text"
  | "sitePath"
  | "artifactPath"
  | "artifactPathPrefix"
  | "sourcePath"
  | "absoluteUrl"
  | "serviceUrl"
  | "origin"
  | "digest"
  | "purl"
  | "purlName"
  | "imageReference"
  | "commit"
  | "patchName"
  | "schemaFileName"
  | "timestamp"
  | "languageTag"
  | "mimeType"
  | "fileExtension"
  | "documentRoot"
  | "moduleRef"
  | "moduleRefPrefix"
  | "cspHash"
  | "headerName"
  | "headerValue"
  | "cspDirectiveName"
  | "cspDirectiveValue"
  | "version";

interface Rule {
  /** Matched against the pointer with every array index replaced by `*`. */
  pointer: RegExp;
  role: ValueRole;
}

/**
 * The declared role of every string an artifact manifest may contain. The first matching rule
 * wins, which lets a specific rule precede a general one.
 */
const RULES: Rule[] = [
  // portal-manifest.json
  { pointer: /^\/site\/id$/, role: "identifier" },
  { pointer: /^\/site\/title$/, role: "text" },
  { pointer: /^\/site\/language$/, role: "languageTag" },
  { pointer: /^\/site\/canonicalUrl$/, role: "absoluteUrl" },
  { pointer: /^\/site\/basePath$/, role: "sitePath" },
  { pointer: /^\/site\/theme$/, role: "identifier" },
  { pointer: /^\/routes\/\*\/path$/, role: "sitePath" },
  { pointer: /^\/routes\/\*\/url$/, role: "absoluteUrl" },
  { pointer: /^\/routes\/\*\/kind$/, role: "token" },
  { pointer: /^\/routes\/\*\/file$/, role: "artifactPath" },
  { pointer: /^\/routes\/\*\/(componentId|landingId)$/, role: "identifier" },
  { pointer: /^\/routes\/\*\/title$/, role: "text" },
  { pointer: /^\/components\/\*\/(id|kind)$/, role: "identifier" },
  { pointer: /^\/components\/\*\/route$/, role: "sitePath" },
  { pointer: /^\/components\/\*\/serviceId$/, role: "identifier" },
  { pointer: /^\/services\/\*\/(id|kind|authentication)$/, role: "identifier" },
  { pointer: /^\/services\/\*\/origin$/, role: "origin" },
  { pointer: /^\/services\/\*\/url$/, role: "serviceUrl" },
  { pointer: /^\/mounts\/\*\/mount$/, role: "sitePath" },
  { pointer: /^\/mounts\/\*\/(kind|profile)$/, role: "identifier" },
  { pointer: /^\/files\/\*\/path$/, role: "artifactPath" },
  { pointer: /^\/files\/\*\/mimeType$/, role: "mimeType" },
  { pointer: /^\/files\/\*\/cacheClass$/, role: "token" },
  { pointer: /^\/files\/\*\/contentDisposition$/, role: "token" },

  // input-manifest.json
  { pointer: /^\/sources\/\*\/ref\/kind$/, role: "token" },
  { pointer: /^\/sources\/\*\/ref\/path$/, role: "sourcePath" },
  { pointer: /^\/sources\/\*\/ref\/purl$/, role: "purl" },
  { pointer: /^\/sources\/\*\/role$/, role: "token" },
  { pointer: /^\/sources\/\*\/digest$/, role: "digest" },
  { pointer: /^\/builder\/package\/kind$/, role: "token" },
  { pointer: /^\/builder\/package\/purl$/, role: "purl" },
  { pointer: /^\/builder\/package\/path$/, role: "sourcePath" },
  { pointer: /^\/builder\/package\/digest$/, role: "digest" },
  { pointer: /^\/builder\/image\/kind$/, role: "token" },
  { pointer: /^\/builder\/image\/reference$/, role: "imageReference" },
  { pointer: /^\/builder\/image\/(index|manifest|config)Digest$/, role: "digest" },
  { pointer: /^\/builder\/image\/platform\/(os|architecture|variant)$/, role: "token" },
  { pointer: /^\/builder\/sourceRevision$/, role: "commit" },
  { pointer: /^\/(schemas\/[^/]+|profile)\/name$/, role: "schemaFileName" },
  { pointer: /^\/(schemas\/[^/]+|profile)\/digest$/, role: "digest" },
  { pointer: /^\/rstHelper\/(protocol|package)$/, role: "token" },
  { pointer: /^\/rstHelper\/(version|docutils)$/, role: "version" },
  { pointer: /^\/components\/\*\/materials\/\*\/kind$/, role: "token" },
  { pointer: /^\/components\/\*\/materials\/\*\/purl$/, role: "purl" },
  { pointer: /^\/components\/\*\/materials\/\*\/path$/, role: "sourcePath" },
  { pointer: /^\/components\/\*\/materials\/\*\/digest$/, role: "digest" },
  { pointer: /^\/components\/\*\/materials\/\*\/reference$/, role: "imageReference" },
  { pointer: /^\/components\/\*\/materials\/\*\/(index|manifest|config)Digest$/, role: "digest" },
  {
    pointer: /^\/components\/\*\/materials\/\*\/platform\/(os|architecture|variant)$/,
    role: "token",
  },
  { pointer: /^\/stac\/upstream\/repository$/, role: "absoluteUrl" },
  { pointer: /^\/stac\/upstream\/tag$/, role: "identifier" },
  { pointer: /^\/stac\/upstream\/commit$/, role: "commit" },
  { pointer: /^\/stac\/upstream\/sourceDigest$/, role: "digest" },
  { pointer: /^\/stac\/patches\/\*\/name$/, role: "patchName" },
  { pointer: /^\/stac\/patches\/\*\/digest$/, role: "digest" },
  { pointer: /^\/stac\/preparedDigest$/, role: "digest" },
  // The Freva side of the same provenance: which recipe built that tree, and under what inputs.
  { pointer: /^\/stac\/recipeVersion$/, role: "identifier" },
  { pointer: /^\/stac\/cacheKey$/, role: "digest" },
  { pointer: /^\/stac\/lockfileDigest$/, role: "digest" },
  { pointer: /^\/stac\/license\/spdx$/, role: "identifier" },
  { pointer: /^\/stac\/license\/digest$/, role: "digest" },
  { pointer: /^\/trustedSubsites\/\*\/mount$/, role: "sitePath" },
  { pointer: /^\/trustedSubsites\/\*\/profile$/, role: "identifier" },
  { pointer: /^\/trustedSubsites\/\*\/(policy|tree)Digest$/, role: "digest" },
  { pointer: /^\/reproducibility\/effectiveAt$/, role: "timestamp" },
  { pointer: /^\/publicEnvironment\/[^/]+$/, role: "text" },

  // component-evidence.json
  { pointer: /^\/components\/\*\/ownedModuleRoots\/\*$/, role: "moduleRefPrefix" },
  { pointer: /^\/components\/\*\/allowedSharedModules\/\*$/, role: "moduleRefPrefix" },
  { pointer: /^\/components\/\*\/modules\/\*$/, role: "moduleRef" },
  {
    pointer: /^\/components\/\*\/(ownedStaticRoots|assetNamespaces|copiedRoots)\/\*$/,
    role: "artifactPathPrefix",
  },
  { pointer: /^\/components\/\*\/(chunks|copiedFiles)\/\*$/, role: "artifactPath" },
  { pointer: /^\/components\/\*\/routes\/\*$/, role: "sitePath" },
  { pointer: /^\/components\/\*\/emittedServiceIds\/\*$/, role: "identifier" },
  { pointer: /^\/graph\/chunks\/\*\/file$/, role: "artifactPath" },
  { pointer: /^\/graph\/chunks\/\*\/modules\/\*$/, role: "moduleRef" },
  { pointer: /^\/graph\/modules\/\*$/, role: "moduleRef" },
  { pointer: /^\/graph\/copiedFiles\/\*$/, role: "artifactPath" },

  // host-policy.json
  { pointer: /^\/mount\/canonicalUrl$/, role: "absoluteUrl" },
  { pointer: /^\/mount\/basePath$/, role: "sitePath" },
  { pointer: /^\/mount\/documentRoot$/, role: "documentRoot" },
  { pointer: /^\/routing\/directoryIndex$/, role: "artifactPath" },
  { pointer: /^\/routing\/spaFallback$/, role: "artifactPath" },
  { pointer: /^\/routing\/trailingSlashRedirect$/, role: "token" },
  { pointer: /^\/errorPages\/notFound$/, role: "artifactPath" },
  { pointer: /^\/headers\/\*\/match\/(path|prefix)$/, role: "sitePath" },
  { pointer: /^\/headers\/\*\/match\/class$/, role: "token" },
  { pointer: /^\/headers\/\*\/set\/[^/]+$/, role: "headerValue" },
  { pointer: /^\/csp\/portal\/[^/]+$/, role: "cspDirectiveValue" },
  { pointer: /^\/csp\/subsites\/\*\/mount$/, role: "sitePath" },
  { pointer: /^\/csp\/subsites\/\*\/profile$/, role: "identifier" },
  { pointer: /^\/csp\/subsites\/\*\/directives\/[^/]+$/, role: "cspDirectiveValue" },
  { pointer: /^\/csp\/subsites\/\*\/inline(Script|Style)Hashes\/\*$/, role: "cspHash" },
  { pointer: /^\/csp\/subsites\/\*\/workers$/, role: "token" },
  { pointer: /^\/mimeTypes\/[^/]+$/, role: "mimeType" },
  { pointer: /^\/cache\/classes\/[^/]+$/, role: "headerValue" },
  { pointer: /^\/authCallback\/path$/, role: "sitePath" },
  { pointer: /^\/authCallback\/headers\/[^/]+$/, role: "headerValue" },

  // BUILDINFO.json
  { pointer: /^\/builder\/name$/, role: "purlName" },
  { pointer: /^\/builder\/version$/, role: "version" },
  { pointer: /^\/builder\/purl$/, role: "purl" },
  { pointer: /^\/inputManifestDigest$/, role: "digest" },
  { pointer: /^\/artifact\/effectiveAt$/, role: "timestamp" },
];

/** Object keys that are themselves data, with the grammar each must satisfy. */
const KEY_RULES: Rule[] = [
  { pointer: /^\/mimeTypes$/, role: "fileExtension" },
  { pointer: /^\/headers\/\*\/set$/, role: "headerName" },
  { pointer: /^\/authCallback\/headers$/, role: "headerName" },
  { pointer: /^\/csp\/portal$/, role: "cspDirectiveName" },
  { pointer: /^\/csp\/subsites\/\*\/directives$/, role: "cspDirectiveName" },
  { pointer: /^\/schemas$/, role: "identifier" },
  { pointer: /^\/graph\/moduleBytes$/, role: "moduleRef" },
  { pointer: /^\/publicEnvironment$/, role: "identifier" },
  { pointer: /^\/cache\/classes$/, role: "identifier" },
];

const MODULE_SCHEMES = ["builder:", "source:", "stac-materials:", "pkg:npm/", "unattributed:"];

/**
 * Absolute filesystem roots, checked on *every* string whatever its role. This is the belt to
 * the role grammar's braces and deliberately not the primary check: a list of roots is always
 * incomplete, so it can only add confidence, never establish it.
 */
const HOST_PATHS = [
  /(^|[\s"'(=:,])\/(home|Users|root|tmp|var|private|opt|workspace|builds|mnt|srv|media|Volumes|github|runner)\//,
  /(^|[\s"'(=,])[A-Za-z]:[\\/]/,
  /(^|[\s"'(=,])\\\\[A-Za-z0-9]/,
  /(^|[\s"'(=,])file:\/\//,
];

/**
 * Control characters, written by code point so this file contains none itself. Matching them
 * is the point of the check, so the lint rule that warns about them is disabled here rather
 * than the check weakened.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f]");

const PATTERNS: Partial<Record<ValueRole, RegExp>> = {
  identifier: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  token: /^[A-Za-z0-9][A-Za-z0-9._/+;= -]*$/,
  digest: /^sha256:[0-9a-f]{64}$/,
  purl: /^pkg:[a-z][a-z0-9+.-]*\/[A-Za-z0-9%._-]+(\/[A-Za-z0-9%._-]+)*@[A-Za-z0-9._+-]+(#\S*)?$/,
  purlName: /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/,
  commit: /^[0-9a-f]{40}$/,
  patchName: /^[0-9]{4}-[A-Za-z0-9][A-Za-z0-9._-]*\.patch$/,
  schemaFileName: /^[a-z0-9][a-z0-9.-]*$/,
  timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  languageTag: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
  mimeType: /^[a-z]+\/[A-Za-z0-9.+-]+(; *[a-z]+=[A-Za-z0-9-]+)*$/,
  fileExtension: /^\.[A-Za-z0-9]+$/,
  // The artifact root, relative to whatever the host serves. Always exactly ".".
  documentRoot: /^\.$/,
  cspHash: /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/,
  headerName: /^[A-Za-z][A-Za-z0-9-]*$/,
  cspDirectiveName: /^[a-z][a-z0-9-]*$/,
  version: /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
  imageReference:
    /^[a-z0-9]+([._-][a-z0-9]+)*(\.[a-z0-9-]+)*(:\d+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$/,
};

/**
 * A site path: rooted, POSIX, and free of anything that could re-root it. The rules are the
 * shared raw-path contract, so a manifest is verified by exactly the rules the loader accepted
 * the value under; weaker rules here could bless a path the loader would refuse.
 */
function checkSitePath(value: string): string | undefined {
  return rawPathReason(value, { rejectQueryAndFragment: false });
}

function checkRelativePath(value: string, allowTrailingSlash: boolean): string | undefined {
  if (value === "") return "is empty";
  if (value.startsWith("/")) return "is absolute";
  if (/^[A-Za-z]:/.test(value)) return "starts with a drive letter";
  if (value.includes("//")) return "contains an empty segment";
  if (!allowTrailingSlash && value.endsWith("/")) return "ends with a slash";
  const reason = rawPathReason(value, {
    requireLeadingSlash: false,
    rejectQueryAndFragment: false,
  });
  if (reason) return reason;
  return undefined;
}

function checkUrl(value: string, allowPathOnly: boolean): string | undefined {
  if (allowPathOnly && value.startsWith("/")) return checkSitePath(value.split("?")[0]!);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not an absolute URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `uses the '${url.protocol}' scheme`;
  }
  return undefined;
}

function checkModuleRef(value: string, prefix: boolean): string | undefined {
  if (!MODULE_SCHEMES.some((scheme) => value.startsWith(scheme))) {
    return `does not use one of the normalized module schemes (${MODULE_SCHEMES.join(", ")})`;
  }
  const body = value.slice(value.indexOf(":") + 1);
  if (body.startsWith("/")) return "names an absolute path after its scheme";
  if (!prefix && body === "") return "has an empty body";
  return undefined;
}

/** Returns a reason the value is wrong for its role, or undefined. */
export function checkRole(role: ValueRole, value: string): string | undefined {
  switch (role) {
    case "sitePath":
      return checkSitePath(value);
    case "artifactPath":
    case "sourcePath":
      return checkRelativePath(value, false);
    case "artifactPathPrefix":
      return checkRelativePath(value, true);
    case "absoluteUrl":
      return checkUrl(value, false);
    case "serviceUrl":
      return checkUrl(value, true);
    case "origin": {
      if (value === "") return undefined;
      const reason = checkUrl(value, false);
      if (reason) return reason;
      const url = new URL(value);
      return url.pathname === "/" && url.search === "" && url.hash === ""
        ? undefined
        : "is not a bare origin";
    }
    case "moduleRef":
      return checkModuleRef(value, false);
    case "moduleRefPrefix":
      return checkModuleRef(value, true);
    case "text":
    case "headerValue":
    case "cspDirectiveValue":
      return CONTROL.test(value) ? "contains a control character" : undefined;
    default: {
      const pattern = PATTERNS[role];
      if (!pattern) return `has no grammar for the role '${role}'`;
      return pattern.test(value) ? undefined : `does not match the grammar for '${role}'`;
    }
  }
}

function roleFor(pointer: string, rules: Rule[]): ValueRole | undefined {
  for (const rule of rules) if (rule.pointer.test(pointer)) return rule.role;
  return undefined;
}

const normalizePointer = (pointer: string): string => pointer.replace(/\/\d+(?=\/|$)/g, "/*");

const escapeSegment = (segment: string): string => segment.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * Walk one manifest and report every string missing a role, wrong for its role, or carrying a
 * build-machine path.
 */
export function checkManifestIdentity(name: string, value: unknown, bag: DiagnosticBag): void {
  const visit = (node: unknown, pointer: string): void => {
    if (typeof node === "string") {
      const normalized = normalizePointer(pointer);
      const role = roleFor(normalized, RULES);
      if (!role) {
        bag.error(
          "FP1603",
          `'${name}' contains the string field '${normalized}', which has no declared value role.`,
          {
            file: name,
            pointer,
            hint: "Every manifest field must declare what kind of value it holds, so verification can prove it is build identity rather than caller state. Add it to src/verify/identity.ts.",
          },
        );
      } else {
        const reason = checkRole(role, node);
        if (reason) {
          bag.error("FP1603", `'${name}' at '${pointer}' ${reason} (role '${role}').`, {
            file: name,
            pointer,
          });
        }
      }
      for (const pattern of HOST_PATHS) {
        if (pattern.test(node)) {
          bag.error(
            "FP1603",
            `'${name}' at '${pointer}' contains a build-machine path, which is never artifact identity.`,
            { file: name, pointer },
          );
          break;
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${pointer}/${index}`));
      return;
    }
    if (node && typeof node === "object") {
      const keyRole = roleFor(normalizePointer(pointer), KEY_RULES);
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (keyRole) {
          const reason = checkRole(keyRole, key);
          if (reason) {
            bag.error(
              "FP1603",
              `'${name}' has the key '${key}' at '${pointer}', which ${reason} (role '${keyRole}').`,
              { file: name, pointer },
            );
          }
        }
        visit(child, `${pointer}/${escapeSegment(key)}`);
      }
    }
  };
  visit(value, "");
}
