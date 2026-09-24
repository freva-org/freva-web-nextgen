/**
 * `static-docs-v1` trusted documentation subsites (FP-001 D10).
 *
 * The *only* way active same-origin code enters the artifact, and deliberately awkward: an
 * explicit `trust: active`, a closed policy document, an already-built tree, and a byte inventory
 * the build reads. What it claims is bounded - statically discoverable resource URLs inventoried
 * and literal inline blocks hashed, with no claim about what arbitrary JavaScript does at
 * runtime; the browser conformance tests cover that, against the policy this module records.
 */

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import type { Diagnostic } from "../diagnostics.js";
import { sha256 } from "../util/package.js";
import { walkRoot } from "../sources/glob.js";
import type { ContentProfile } from "../rendering/profile.js";
import type { InputRecord, ResolvedSubsite } from "./types.js";
import type { SubsitePolicyDocument } from "../config/types.js";
import { inspectCss, inspectHtml, type SubsiteFinding } from "./subsite-inventory.js";
import { compareCodePoints } from "../util/order.js";

const SUBSITE_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
};

export interface SubsiteInput {
  /** Absolute canonical path of the already-built tree. */
  absolute: string;
  /** Source-root-relative path of the tree. */
  relative: string;
  mount: string;
  policy: SubsitePolicyDocument;
  policySource: string;
  policyDigest: string;
}

export interface SubsiteResult {
  subsite?: ResolvedSubsite;
  inputs: InputRecord[];
  contents: Map<string, Buffer>;
  diagnostics: Diagnostic[];
}

export function collectSubsite(
  input: SubsiteInput,
  profile: ContentProfile,
  basePath: string,
): SubsiteResult {
  const diagnostics: Diagnostic[] = [];
  const inputs: InputRecord[] = [];
  const contents = new Map<string, Buffer>();
  const walked = walkRoot(input.absolute, input.relative);
  diagnostics.push(...walked.diagnostics);

  if (walked.files.length === 0) {
    diagnostics.push({
      code: "FP1403",
      severity: "error",
      message: `Trusted subsite '${input.relative}' is empty. The portal never runs a command to create it.`,
      file: input.relative,
    });
  }
  if (walked.files.length > profile.limits.maxSubsiteFiles) {
    diagnostics.push({
      code: "FP1407",
      severity: "error",
      message: `Trusted subsite '${input.relative}' has ${walked.files.length} files, above the ${profile.limits.maxSubsiteFiles} limit.`,
      file: input.relative,
    });
  }

  /** Artifact-absolute prefix this subsite is served under, e.g. `/site/reference/`. */
  const mountPrefix = `${basePath.replace(/\/$/, "")}${input.mount}`;

  const files: ResolvedSubsite["files"] = [];
  const inlineScriptHashes = new Set<string>();
  const inlineStyleHashes = new Set<string>();
  const staticResources = new Set<string>();
  const present = new Set(walked.files);
  let totalBytes = 0;

  /**
   * The origins this subsite's policy declares, normalized the way a browser computes an origin,
   * so comparison is exact rather than textual. A declared origin not already in normal form is
   * refused, not normalized: `https://Example.org:443` and `https://example.org` denote the same
   * origin, and a policy that spells one while meaning the other cannot be reviewed by reading.
   */
  const declaredOrigins = (
    list: readonly string[],
    field: string,
  ): { allowed: Set<string>; sorted: string[] } => {
    const allowed = new Set<string>();
    for (const declared of list) {
      let origin: string | undefined;
      try {
        const url = new URL(declared);
        origin =
          url.origin !== "null" &&
          url.username === "" &&
          url.password === "" &&
          url.pathname === "/" &&
          url.search === "" &&
          url.hash === "" &&
          declared === url.origin
            ? url.origin
            : undefined;
      } catch {
        origin = undefined;
      }
      if (origin === undefined) {
        diagnostics.push({
          code: "FP1404",
          severity: "error",
          message: `Trusted subsite policy field '${field}' contains '${declared}', which is not an exact normalized origin.`,
          file: input.policySource,
          hint: "Write scheme, host and, only when it is not the default, port - with no path, credentials, query, fragment or wildcard.",
        });
        continue;
      }
      allowed.add(origin);
    }
    return { allowed, sorted: [...allowed].sort(compareCodePoints) };
  };

  const connect = declaredOrigins(input.policy.runtime.connectOrigins, "runtime.connectOrigins");
  const frames = declaredOrigins(input.policy.runtime.frameOrigins, "runtime.frameOrigins");

  /**
   * A finding from the parsed inventory becomes a diagnostic. The parser decides *what the
   * browser would do*; this decides *whether the profile and this policy allow it*.
   */
  const report = (finding: SubsiteFinding, rel: string): void => {
    const file = `${input.relative}/${rel}`;
    if (finding.kind === "external-subresource") {
      diagnostics.push({
        code: "FP1405",
        severity: "error",
        message:
          `Trusted subsite file '${rel}' references the external static resource '${finding.value}' ` +
          `(${finding.element}[${finding.attribute}]). static-docs-v1 permits external origins for ` +
          `runtime connections and frames only, never for a subresource.`,
        file,
        hint: "Vendor the resource into the documentation build, or deploy the documentation on its own origin.",
      });
      return;
    }
    if (finding.kind === "external-connection") {
      if (finding.origin !== "" && connect.allowed.has(finding.origin)) return;
      diagnostics.push({
        code: "FP1405",
        severity: "error",
        message:
          `Trusted subsite file '${rel}' opens a connection to '${finding.value}' ` +
          `(${finding.element}[${finding.attribute}]), whose origin is not declared in runtime.connectOrigins.`,
        file,
        hint:
          connect.sorted.length > 0
            ? `Declared connect origins: ${connect.sorted.join(", ")}.`
            : "Add the exact origin to runtime.connectOrigins in the subsite policy, or remove the reference.",
      });
      return;
    }
    if (finding.kind === "external-frame") {
      if (finding.origin !== "" && frames.allowed.has(finding.origin)) return;
      diagnostics.push({
        code: "FP1405",
        severity: "error",
        message:
          `Trusted subsite file '${rel}' frames '${finding.value}' ` +
          `(${finding.element}[${finding.attribute}]), whose origin is not declared in runtime.frameOrigins.`,
        file,
        hint:
          frames.sorted.length > 0
            ? `Declared frame origins: ${frames.sorted.join(", ")}.`
            : "Add the exact origin to runtime.frameOrigins in the subsite policy, or remove the frame.",
      });
      return;
    }
    if (finding.kind === "external-worker") {
      diagnostics.push({
        code: "FP1405",
        severity: "error",
        message: `Trusted subsite file '${rel}' loads the external worker '${finding.value}'. static-docs-v1 permits same-origin workers only.`,
        file,
      });
      return;
    }
    if (finding.kind === "escaping-resource") {
      diagnostics.push({
        code: "FP1405",
        severity: "error",
        message: `Trusted subsite file '${rel}' references '${finding.value}', which is outside its own mount.`,
        file,
        hint: `The subsite must already be built for the mount ${mountPrefix}.`,
      });
      return;
    }
    if (finding.kind === "active-url") {
      diagnostics.push({
        code: "FP1406",
        severity: "error",
        message: `Trusted subsite file '${rel}' contains an active URL '${finding.value}' on ${finding.element}[${finding.attribute}].`,
        file,
      });
      return;
    }
    if (finding.kind === "event-handler") {
      diagnostics.push({
        code: "FP1406",
        severity: "error",
        message: `Trusted subsite file '${rel}' contains the literal inline event handler '${finding.attribute}' on <${finding.element}>.`,
        file,
      });
      return;
    }
    diagnostics.push({
      code: "FP1403",
      severity: "error",
      message: `Trusted subsite stylesheet '${rel}' could not be parsed: ${finding.detail}`,
      file,
    });
  };

  for (const rel of walked.files) {
    const abs = join(input.absolute, rel);
    const bytes = readFileSync(abs);
    totalBytes += bytes.byteLength;
    const ext = extname(rel).toLowerCase();
    const mount = input.mount.replace(/^\//, "");
    const outFile = `${mount}${rel}`;
    contents.set(outFile, bytes);
    files.push({
      file: outFile,
      url: `${basePath.replace(/\/$/, "")}${input.mount}${rel}`,
      source: `${input.relative}/${rel}`,
      mimeType: SUBSITE_MIME[ext] ?? "application/octet-stream",
      bytes: bytes.byteLength,
      digest: sha256(bytes),
    });
    inputs.push({
      path: `${input.relative}/${rel}`,
      role: "subsite-file",
      digest: sha256(bytes),
      bytes: bytes.byteLength,
    });

    if (ext === ".html" || ext === ".htm") {
      const inventory = inspectHtml(bytes.toString("utf8"), rel, mountPrefix);
      for (const finding of inventory.findings) report(finding, rel);
      for (const resource of inventory.localResources) staticResources.add(resource);
      for (const digest of inventory.inlineScriptHashes) inlineScriptHashes.add(digest);
      for (const digest of inventory.inlineStyleHashes) inlineStyleHashes.add(digest);
    } else if (ext === ".css") {
      const inventory = inspectCss(bytes.toString("utf8"), rel, mountPrefix);
      for (const finding of inventory.findings) report(finding, rel);
      for (const resource of inventory.localResources) staticResources.add(resource);
    }
  }

  // Every local static resource must exist in the copied tree: a documentation build that
  // references a file it did not ship produces a subsite whose first page load 404s.
  for (const resource of [...staticResources].sort()) {
    if (present.has(resource)) continue;
    diagnostics.push({
      code: "FP1405",
      severity: "error",
      message: `Trusted subsite references '${resource}', which is not in the copied tree.`,
      file: input.relative,
      hint: "Rebuild the documentation so every referenced resource is part of its output.",
    });
  }

  if (totalBytes > profile.limits.maxSubsiteBytes) {
    diagnostics.push({
      code: "FP1407",
      severity: "error",
      message: `Trusted subsite '${input.relative}' is ${totalBytes} bytes, above the ${profile.limits.maxSubsiteBytes}-byte limit.`,
      file: input.relative,
    });
  }

  for (const entry of input.policy.entryPoints) {
    if (!present.has(entry)) {
      diagnostics.push({
        code: "FP1404",
        severity: "error",
        message: `Declared entry point '${entry}' does not exist in '${input.relative}'.`,
        file: input.policySource,
      });
    }
  }

  // The tree digest makes the subsite reproducible without its producer's source tree (AR-003).
  const treeHash = createHash("sha256");
  for (const file of [...files].sort((a, b) => compareCodePoints(a.file, b.file))) {
    treeHash.update(file.file).update("\0").update(file.digest).update("\n");
  }

  const subsite: ResolvedSubsite = {
    mount: input.mount,
    profile: "static-docs-v1",
    policy: {
      entryPoints: [...input.policy.entryPoints],
      runtime: {
        connectOrigins: [...input.policy.runtime.connectOrigins],
        frameOrigins: [...input.policy.runtime.frameOrigins],
        workers: input.policy.runtime.workers,
      },
    },
    policySource: input.policySource,
    policyDigest: input.policyDigest,
    treeDigest: `sha256:${treeHash.digest("hex")}`,
    files: files.sort((a, b) => compareCodePoints(a.file, b.file)),
    inlineScriptHashes: [...inlineScriptHashes].sort(),
    inlineStyleHashes: [...inlineStyleHashes].sort(),
    staticResources: [...staticResources].sort(),
  };

  return {
    ...(diagnostics.some((d) => d.severity === "error") ? {} : { subsite }),
    inputs,
    contents,
    diagnostics,
  };
}

export function subsiteFileSize(path: string): number {
  return statSync(path).size;
}
