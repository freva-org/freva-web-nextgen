import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readRegularFile } from "../../src/util/read-file.js";

const dir = mkdtempSync(join(tmpdir(), "read-file-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readRegularFile", () => {
  it("reads a file within the limit, and only its size above it", () => {
    writeFileSync(join(dir, "a.txt"), "hello");
    expect(readRegularFile(join(dir, "a.txt"))).toEqual({ size: 5, bytes: Buffer.from("hello") });
    expect(readRegularFile(join(dir, "a.txt"), 4)).toEqual({ size: 5 });
  });

  it("is null for a missing path, a directory, or a path through a file", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "f"), "");
    expect(readRegularFile(join(dir, "missing"))).toBeNull();
    expect(readRegularFile(join(dir, "sub"))).toBeNull();
    expect(readRegularFile(join(dir, "f", "x"))).toBeNull();
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO without waiting on it", () => {
    execFileSync("mkfifo", [join(dir, "pipe")]);
    expect(readRegularFile(join(dir, "pipe"))).toBeNull();
  });
});
