/**
 * Asset and download classification. A file is either an embeddable asset on the published MIME
 * allowlist or a passive download the host must serve as an attachment with `nosniff`; there is
 * no "copy whatever is there" class. HTML, JavaScript, CSS, WebAssembly and source maps are
 * refused in both: active same-origin content enters only via a declared `static-docs-v1` subsite.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Diagnostic } from "../diagnostics.js";
import { sha256 } from "../util/package.js";
import { walkRoot } from "../sources/glob.js";
import type { ContentProfile } from "../rendering/profile.js";
import { sanitizeSvgFile } from "../rendering/svg.js";
import type { CacheClass, InputRecord, ResolvedStaticFile } from "./types.js";
import { compareCodePoints } from "../util/order.js";

export interface MountedRoot {
  /** Absolute canonical path of the root. */
  absolute: string;
  /** Source-root-relative path of the root. */
  relative: string;
  /** Site-logical mount, always with a trailing slash. */
  mount: string;
}

export interface AssetCollectionResult {
  files: ResolvedStaticFile[];
  inputs: InputRecord[];
  diagnostics: Diagnostic[];
  /** Published bytes by artifact-relative path, so the writer never re-reads. */
  contents: Map<string, Buffer>;
}

export function mimeForAsset(file: string, profile: ContentProfile): string | undefined {
  return profile.assets.embeddableMimeTypes[extname(file).toLowerCase()];
}

export function mimeForDownload(file: string, profile: ContentProfile): string {
  return (
    profile.downloads.mimeTypes[extname(file).toLowerCase()] ??
    profile.downloads.unknownExtensionMimeType
  );
}

interface CollectOptions {
  kind: "asset" | "download";
  basePath: string;
  canonicalUrl: string;
  profile: ContentProfile;
  limits: ContentProfile["limits"];
}

export function collectMountedFiles(
  roots: MountedRoot[],
  opts: CollectOptions,
): AssetCollectionResult {
  const files: ResolvedStaticFile[] = [];
  const inputs: InputRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  const contents = new Map<string, Buffer>();
  let totalBytes = 0;

  for (const root of roots) {
    const walked = walkRoot(root.absolute, root.relative);
    diagnostics.push(...walked.diagnostics);
    for (const rel of walked.files) {
      const abs = join(root.absolute, rel);
      const sourceRel = `${root.relative}/${rel}`.replace(/^\/+/, "");
      const size = statSync(abs).size;
      if (size > opts.limits.maxAssetBytes) {
        diagnostics.push({
          code: "FP1407",
          severity: "error",
          message: `'${sourceRel}' is ${size} bytes, above the ${opts.limits.maxAssetBytes}-byte limit.`,
          file: sourceRel,
        });
        continue;
      }
      const outFile = `${root.mount.replace(/^\//, "")}${rel}`;
      const url = `${opts.basePath.replace(/\/$/, "")}${root.mount}${rel}`;
      let bytes = readFileSync(abs);
      const inputDigest = sha256(bytes);
      let mimeType: string;
      let cacheClass: CacheClass;
      let sanitized = false;

      if (opts.kind === "asset") {
        const ext = extname(rel).toLowerCase();
        if (opts.profile.assets.forbiddenAssetExtensions.includes(ext)) {
          diagnostics.push({
            code: "FP1401",
            severity: "error",
            message: `'${sourceRel}' is an active or unknown format and cannot be an embeddable asset.`,
            file: sourceRel,
            hint: "Move it to rendering.downloads, or publish it as a declared static-docs-v1 subsite.",
          });
          continue;
        }
        const mime = mimeForAsset(rel, opts.profile);
        if (!mime) {
          diagnostics.push({
            code: "FP1401",
            severity: "error",
            message: `'${sourceRel}' has no entry on the published embeddable MIME allowlist.`,
            file: sourceRel,
            hint: `Allowed extensions: ${Object.keys(opts.profile.assets.embeddableMimeTypes).join(", ")}.`,
          });
          continue;
        }
        mimeType = mime;
        cacheClass = "revalidate";
        if (opts.profile.assets.sanitizedExtensions.includes(ext)) {
          const result = sanitizeSvgFile(bytes, sourceRel, opts.profile);
          diagnostics.push(...result.diagnostics);
          if (!result.ok) continue;
          bytes = Buffer.from(result.svg, "utf8");
          sanitized = true;
        }
      } else {
        mimeType = mimeForDownload(rel, opts.profile);
        cacheClass = "download";
      }

      totalBytes += bytes.byteLength;
      contents.set(outFile, bytes);
      const entry: ResolvedStaticFile = {
        file: outFile,
        url,
        source: sourceRel,
        mimeType,
        bytes: bytes.byteLength,
        digest: sha256(bytes),
        cacheClass,
        kind: opts.kind,
      };
      if (opts.kind === "download")
        entry.contentDisposition = opts.profile.downloads.contentDisposition;
      if (sanitized) entry.sanitized = true;
      files.push(entry);
      inputs.push({
        path: sourceRel,
        role: opts.kind,
        digest: inputDigest,
        bytes: size,
      });
    }
  }

  if (totalBytes > opts.limits.maxTotalAssetBytes) {
    diagnostics.push({
      code: "FP1407",
      severity: "error",
      message: `Total ${opts.kind} bytes ${totalBytes} exceed the ${opts.limits.maxTotalAssetBytes}-byte limit.`,
    });
  }

  files.sort((a, b) => compareCodePoints(a.file, b.file));
  inputs.sort((a, b) => compareCodePoints(a.path, b.path));
  return { files, inputs, diagnostics, contents };
}
