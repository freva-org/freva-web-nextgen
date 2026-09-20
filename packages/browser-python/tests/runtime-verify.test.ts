/**
 * The runtime checker, checked against runtimes built to be wrong. "Does a file with this name
 * exist" is the question a restored CI cache always answers yes to: a cache archived
 * mid-assembly, a partial restore, an interrupted download or a disk that filled all leave the
 * names in place, and the failure then surfaces inside a WebAssembly instantiation or a wheel
 * import, in a browser suite, as an opaque "Failed to fetch". Each case below corrupts one
 * specific thing and asserts the sentence a person would need to read.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_ASSETS, digestOf, verifyRuntime } from "../scripts/runtime-verify.mjs";

const dirs: string[] = [];
afterEach(() => dirs.splice(0, dirs.length));

/** A directory that passes, plus whatever the test then breaks in it. */
function goodRuntime(): {
  dir: string;
  manifest: Record<string, unknown>;
  lock: Record<string, unknown>;
  write: (name: string, body: string) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "runtime-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  const write = (name: string, body: string) => {
    writeFileSync(join(dir, name), body);
  };
  for (const asset of CORE_ASSETS) {
    write(asset, `contents of ${asset}`);
    files[asset] = digestOf(Buffer.from(`contents of ${asset}`));
  }
  write("numpy-1.0-none-any.whl", "numpy bytes");
  files["numpy-1.0-none-any.whl"] = digestOf(Buffer.from("numpy bytes"));
  write("dep-1.0-none-any.whl", "dep bytes");
  files["dep-1.0-none-any.whl"] = digestOf(Buffer.from("dep bytes"));

  const lock = {
    packages: {
      numpy: { name: "numpy", file_name: "numpy-1.0-none-any.whl", depends: ["dep"] },
      dep: { name: "dep", file_name: "dep-1.0-none-any.whl", depends: [] },
    },
  };
  const manifest = {
    pyodide: "314.0.6",
    manifestId: "id-1",
    digest: "sha256",
    complete: true,
    packages: ["numpy"],
    files,
  };
  return { dir, manifest, lock, write };
}

const verify = (r: ReturnType<typeof goodRuntime>) =>
  verifyRuntime({
    dir: r.dir,
    manifest: r.manifest,
    lock: r.lock,
    expectedManifestId: "id-1",
    packages: ["numpy"],
  });

describe("a runtime that is what it says it is", () => {
  it("passes", () => {
    expect(verify(goodRuntime())).toEqual([]);
  });
});

describe("a runtime that is not", () => {
  it("catches a file whose BYTES changed, not just its name", () => {
    const r = goodRuntime();
    r.write("numpy-1.0-none-any.whl", "numpy bytes, but truncat");
    expect(verify(r).join("\n")).toMatch(/numpy-1\.0-none-any\.whl does not match its recorded/);
  });

  it("calls an empty file empty, because that is a different accident", () => {
    const r = goodRuntime();
    r.write("numpy-1.0-none-any.whl", "");
    expect(verify(r).join("\n")).toMatch(/EMPTY - the file was never fully written/);
  });

  it("catches a corrupted WASM binary, which is the one nobody would diagnose", () => {
    const r = goodRuntime();
    r.write("pyodide.asm.wasm", "\0\0\0");
    expect(verify(r).join("\n")).toMatch(/pyodide\.asm\.wasm does not match/);
  });

  it("catches a missing core asset even if the manifest never mentioned it", () => {
    const r = goodRuntime();
    delete (r.manifest.files as Record<string, string>)["python_stdlib.zip"];
    const problems = verify(r);
    expect(problems.join("\n")).not.toMatch(/python_stdlib\.zip is named/);
    r.manifest.files = { "numpy-1.0-none-any.whl": digestOf(Buffer.from("numpy bytes")) };
    expect(verify(r)).toEqual([]);
  });

  it("catches a wheel that is in the CLOSURE but not in the directory", () => {
    const r = goodRuntime();
    delete (r.manifest.files as Record<string, string>)["dep-1.0-none-any.whl"];
    // The file itself is gone too - a dependency nobody named directly.
    writeFileSync(join(r.dir, "dep-1.0-none-any.whl"), "");
    const problems = verifyRuntime({
      dir: r.dir,
      manifest: r.manifest,
      lock: r.lock,
      expectedManifestId: "id-1",
      packages: ["numpy"],
    });
    expect(problems.join("\n")).toMatch(/dep|closure/);
  });

  it("refuses a manifest with no digests at all rather than passing it", () => {
    const r = goodRuntime();
    delete r.manifest.digest;
    expect(verify(r).join("\n")).toMatch(/cannot be verified/);
  });

  it("still reports an incomplete assembly and a mismatched package list", () => {
    const r = goodRuntime();
    r.manifest.complete = false;
    r.manifest.manifestId = "id-2";
    const problems = verify(r).join("\n");
    expect(problems).toMatch(/incomplete/);
    expect(problems).toMatch(/different package list/);
  });

  it("reports every problem at once, not the first one", () => {
    const r = goodRuntime();
    r.write("numpy-1.0-none-any.whl", "");
    r.write("pyodide.asm.wasm", "wrong");
    expect(verify(r).length).toBeGreaterThan(1);
  });
});
