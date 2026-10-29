import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

/**
 * A regular file's size and, when it is at most `maxBytes`, its bytes; null when `path` is not a
 * regular file. The check and the read go through one descriptor, so they see the same file.
 */
export function readRegularFile(
  path: string,
  maxBytes = Number.POSITIVE_INFINITY,
): { size: number; bytes?: Buffer } | null {
  let fd: number;
  try {
    // O_NONBLOCK: opening a FIFO must not hang the build; it is refused below as not a file.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return null;
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) return { size: stat.size };
    return { size: stat.size, bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}
