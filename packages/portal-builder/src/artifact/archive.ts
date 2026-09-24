// The canonical release archive.
//
// The release artifact identity is the SHA-256 of this archive, which only means something if
// the archive is byte-identical for identical inputs. Two ordinary `tar` invocations on two
// machines are not: they disagree about entry order, uid/gid, modes and the mtimes they take
// from the filesystem. So the format is written here rather than delegated: normalized path
// order, directories before their children, fixed ownership and modes, every mtime from
// `SOURCE_DATE_EPOCH`, and a gzip wrapper whose own timestamp field is zeroed.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, constants as zlibConstants } from "node:zlib";
import { compareCodePoints } from "../util/order.js";

const BLOCK = 512;
/** Fixed metadata: what the bytes are, not who happened to build them. */
const FILE_MODE = "0000644";
const DIRECTORY_MODE = "0000755";
const FIXED_UID = "0000000";
const FIXED_GID = "0000000";
const OWNER = "root";

interface Entry {
  path: string;
  type: "file" | "directory";
  bytes?: Buffer;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function writeString(block: Buffer, value: string, offset: number, length: number): void {
  block.write(value.slice(0, length - 1), offset, length - 1, "utf8");
}

/** One POSIX ustar header, with every variable field pinned. */
function header(entry: Entry, epoch: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  const name = entry.type === "directory" ? `${entry.path}/` : entry.path;
  if (Buffer.byteLength(name) > 99) {
    throw new Error(`Path too long for the canonical archive format: ${name}`);
  }
  writeString(block, name, 0, 100);
  block.write(
    entry.type === "directory" ? DIRECTORY_MODE + "\0" : FILE_MODE + "\0",
    100,
    8,
    "utf8",
  );
  block.write(FIXED_UID + "\0", 108, 8, "utf8");
  block.write(FIXED_GID + "\0", 116, 8, "utf8");
  block.write(octal(entry.bytes?.byteLength ?? 0, 12), 124, 12, "utf8");
  block.write(octal(epoch, 12), 136, 12, "utf8");
  block.write("        ", 148, 8, "utf8"); // checksum placeholder
  block.write(entry.type === "directory" ? "5" : "0", 156, 1, "utf8");
  block.write("ustar\0" + "00", 257, 8, "utf8");
  writeString(block, OWNER, 265, 32);
  writeString(block, OWNER, 297, 32);

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");
  return block;
}

function pad(bytes: Buffer): Buffer {
  const remainder = bytes.byteLength % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

function listEntries(root: string, prefix = ""): Entry[] {
  const entries: Entry[] = [];
  const names = readdirSync(join(root, prefix), { withFileTypes: true });
  const directories = names.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const files = names.filter((entry) => entry.isFile()).map((entry) => entry.name);

  // Directories before their children, each group in code-point order.
  for (const name of [...directories].sort(compareCodePoints)) {
    const path = prefix ? `${prefix}/${name}` : name;
    entries.push({ path, type: "directory" });
    entries.push(...listEntries(root, path));
  }
  for (const name of [...files].sort(compareCodePoints)) {
    const path = prefix ? `${prefix}/${name}` : name;
    entries.push({ path, type: "file", bytes: readFileSync(join(root, path)) });
  }
  return entries;
}

export interface ArchiveResult {
  /** SHA-256 of the canonical archive. This is the release artifact identity. */
  digest: string;
  bytes: number;
  entries: number;
  path?: string;
}

export interface ArchiveOptions {
  dir: string;
  /** Seconds since the Unix epoch; every entry's mtime. */
  sourceDateEpoch: number;
  /** Where to write. Omitted for a digest-only run. */
  out?: string;
  /** gzip the result. The gzip MTIME field is written as zero either way. */
  compress?: boolean;
}

export function buildCanonicalArchive(options: ArchiveOptions): ArchiveResult {
  const entries = listEntries(options.dir);
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(header(entry, options.sourceDateEpoch));
    if (entry.bytes) {
      chunks.push(entry.bytes, pad(entry.bytes));
    }
  }
  // Two zero blocks terminate a tar stream.
  chunks.push(Buffer.alloc(BLOCK * 2));

  let archive = Buffer.concat(chunks);
  if (options.compress) {
    archive = gzipSync(archive, { level: zlibConstants.Z_BEST_COMPRESSION });
    // Node writes the gzip MTIME field from the wall clock on some versions. Zeroing bytes
    // 4..7 leaves the wrapper carrying no wall-clock timestamp at all.
    archive.writeUInt32LE(0, 4);
    // Byte 9 is the source OS. Pinning it keeps the header machine-independent.
    archive[9] = 0x03;
  }

  const result: ArchiveResult = {
    digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    bytes: archive.byteLength,
    entries: entries.length,
  };
  if (options.out) {
    writeFileSync(options.out, archive);
    result.path = options.out;
  }
  return result;
}

/** Read an artifact's recorded epoch, so `archive` needs no second source of truth. */
export function recordedEpoch(dir: string): number {
  const buildinfo = JSON.parse(readFileSync(join(dir, "BUILDINFO.json"), "utf8")) as {
    artifact?: { sourceDateEpoch?: number };
  };
  const epoch = buildinfo.artifact?.sourceDateEpoch;
  if (typeof epoch !== "number") {
    throw new Error(
      "This artifact records no SOURCE_DATE_EPOCH, so it cannot produce a canonical archive.",
    );
  }
  return epoch;
}

/** The number of entries a canonical archive of this directory would contain. */
export function archiveEntryCount(dir: string): number {
  return listEntries(dir).length;
}
