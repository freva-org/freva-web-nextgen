/**
 * The PRODUCTION preparation, and what a warm cache is allowed to prove. The command verifies the
 * tarball's SHA-256 before unpacking, but after the first run only a stamp file and a list of
 * filenames stand between a directory of placeholder bytes and `--full` announcing "already
 * prepared". In CI that is the only code path that runs. The other half is atomicity: unpacking
 * into the destination lets an interrupted download replace a working runtime with a broken one.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPreparedRuntime, RUNTIME_STAMP, coreOf } from "../bin/runtime-verify.mjs";

const made: string[] = [];
afterEach(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made.length = 0;
});

const sha = (body: string) => createHash("sha256").update(body).digest("hex");

// These fixtures are SYNTHETIC - four-byte files standing in for a 350 MB distribution - so they
// cannot claim to be a version this package pins. Everything but the pinned-version check below
// runs against an unpinned version, where the stamp is the only record there is.
const UNPINNED = "999.0.0";
const UNPINNED_ARCHIVE = "c".repeat(64);

/** A directory that looks exactly like a healthy prepared runtime, and is one. */
function preparedRuntime({
  version = UNPINNED,
  packages = {
    numpy: { file_name: "numpy-1.0-none-any.whl", sha256: sha("numpy bytes") },
  } as Record<string, { file_name: string; sha256: string }>,
  bodies = { "numpy-1.0-none-any.whl": "numpy bytes" } as Record<string, string>,
  core = {
    "pyodide.mjs": "loader",
    "pyodide.asm.wasm": "wasm",
    "pyodide.asm.mjs": "glue",
    "python_stdlib.zip": "stdlib",
  },
  full = true,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-cli-"));
  made.push(dir);
  const lock = JSON.stringify({ packages });
  const files: Record<string, string> = { ...core, ...bodies, "pyodide-lock.json": lock };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const digests: Record<string, string> = {};
  for (const name of [...Object.keys(core), "pyodide-lock.json"]) digests[name] = sha(files[name]!);
  writeFileSync(
    join(dir, RUNTIME_STAMP),
    JSON.stringify({
      version,
      sha256: UNPINNED_ARCHIVE,
      full,
      packages: Object.keys(packages).length,
      digests,
      preparedAt: new Date().toISOString(),
    }),
  );
  return dir;
}

const verify = (dir: string, options = {}) =>
  verifyPreparedRuntime({ dir, version: UNPINNED, full: true, ...options });

describe("a warm runtime is verified, not believed", () => {
  it("accepts a runtime that is what its stamp says it is", () => {
    expect(verify(preparedRuntime())).toEqual([]);
  });

  it("rejects placeholder bytes behind a matching stamp", () => {
    const dir = preparedRuntime();
    writeFileSync(join(dir, "pyodide.asm.wasm"), "not the wasm you verified");
    expect(verify(dir).join("\n")).toMatch(/pyodide\.asm\.wasm/);
  });

  it("rejects ONE corrupted wheel, checked against the lock file's own digest", () => {
    const dir = preparedRuntime();
    writeFileSync(join(dir, "numpy-1.0-none-any.whl"), "numpy bytes, but truncat");
    expect(verify(dir).join("\n")).toMatch(/numpy-1\.0-none-any\.whl/);
  });

  it("rejects an empty lock file under --full, instead of reporting 0 of 0", () => {
    const dir = preparedRuntime({ packages: {}, bodies: {} });
    expect(verify(dir).join("\n")).toMatch(/no packages|empty/i);
  });

  it("rejects a lock file that is not even JSON", () => {
    const dir = preparedRuntime();
    writeFileSync(join(dir, "pyodide-lock.json"), "{not json");
    expect(verify(dir).length).toBeGreaterThan(0);
  });

  it("rejects a stamp for a different version", () => {
    expect(verify(preparedRuntime(), { version: "888.0.0" }).join("\n")).toMatch(/version/i);
  });

  it("rejects a runtime with no digests recorded at all - it cannot be verified", () => {
    const dir = preparedRuntime();
    const stamp = JSON.parse(readFileSync(join(dir, RUNTIME_STAMP), "utf8"));
    delete stamp.digests;
    writeFileSync(join(dir, RUNTIME_STAMP), JSON.stringify(stamp));
    expect(verify(dir).join("\n")).toMatch(/cannot be verified|no digests/i);
  });

  it("rejects a missing wheel as well as a corrupt one", () => {
    const dir = preparedRuntime();
    rmSync(join(dir, "numpy-1.0-none-any.whl"));
    expect(verify(dir).join("\n")).toMatch(/numpy/);
  });

  it("passes without --full when packages are absent, but never with core files missing", () => {
    const dir = preparedRuntime();
    rmSync(join(dir, "numpy-1.0-none-any.whl"));
    expect(verify(dir, { full: false })).toEqual([]);
    rmSync(join(dir, "pyodide.asm.wasm"));
    expect(verify(dir, { full: false }).join("\n")).toMatch(/pyodide\.asm\.wasm/);
  });
});

// THE STAMP DECIDES WHAT IS CHECKED, AND THAT IS THE HOLE. Hashing "every file recorded in the
// stamp" is only a verification if the stamp is complete: all the right filenames, corrupt bytes in
// `pyodide.asm.wasm`, and a stamp listing only `pyodide.mjs` would pass `--full`.
describe("the stamp is checked for completeness, not consulted for a to-do list", () => {
  it("rejects a stamp that omits a core asset, even when nothing else is wrong", () => {
    const dir = preparedRuntime();
    const stamp = JSON.parse(readFileSync(join(dir, RUNTIME_STAMP), "utf8"));
    delete stamp.digests["pyodide.asm.wasm"];
    writeFileSync(join(dir, RUNTIME_STAMP), JSON.stringify(stamp));
    expect(verify(dir).join("\n")).toMatch(/pyodide\.asm\.wasm/);
  });

  it("catches corrupt bytes in a file the stamp forgot - the reported reproduction", () => {
    const dir = preparedRuntime();
    const stamp = JSON.parse(readFileSync(join(dir, RUNTIME_STAMP), "utf8"));
    stamp.digests = { "pyodide.mjs": stamp.digests["pyodide.mjs"] };
    writeFileSync(join(dir, RUNTIME_STAMP), JSON.stringify(stamp));
    writeFileSync(join(dir, "pyodide.asm.wasm"), "corrupt bytes behind a valid name");
    expect(verify(dir).length).toBeGreaterThan(0);
  });

  it("requires the lock file itself to be digested", () => {
    const dir = preparedRuntime();
    const stamp = JSON.parse(readFileSync(join(dir, RUNTIME_STAMP), "utf8"));
    delete stamp.digests["pyodide-lock.json"];
    writeFileSync(join(dir, RUNTIME_STAMP), JSON.stringify(stamp));
    expect(verify(dir).join("\n")).toMatch(/pyodide-lock\.json/);
  });

  it("rejects a malformed digest rather than comparing against nonsense", () => {
    for (const bad of ["", "not-a-digest", "AB".repeat(32), "a".repeat(63), 42]) {
      const dir = preparedRuntime();
      const stamp = JSON.parse(readFileSync(join(dir, RUNTIME_STAMP), "utf8"));
      stamp.digests["pyodide.mjs"] = bad;
      writeFileSync(join(dir, RUNTIME_STAMP), JSON.stringify(stamp));
      expect(verify(dir).join("\n"), `digest ${JSON.stringify(bad)}`).toMatch(
        /not a SHA-256|64 hexadecimal/i,
      );
    }
  });

  it("rejects an entry that is not a plain filename in this directory", () => {
    for (const bad of ["../escape.wasm", "/etc/passwd", "nested/file.wasm", ""]) {
      const dir = preparedRuntime();
      const stamp = JSON.parse(readFileSync(join(dir, RUNTIME_STAMP), "utf8"));
      stamp.digests[bad] = sha("anything");
      writeFileSync(join(dir, RUNTIME_STAMP), JSON.stringify(stamp));
      expect(verify(dir).join("\n"), `entry ${JSON.stringify(bad)}`).toMatch(
        /plain file name|traversal|absolute/i,
      );
    }
  });

  it("rejects an entry naming a file that is not part of a Pyodide distribution", () => {
    const dir = preparedRuntime();
    const stamp = JSON.parse(readFileSync(join(dir, RUNTIME_STAMP), "utf8"));
    stamp.digests["surprise.wasm"] = sha("surprise");
    writeFileSync(join(dir, "surprise.wasm"), "surprise");
    writeFileSync(join(dir, RUNTIME_STAMP), JSON.stringify(stamp));
    expect(verify(dir).join("\n")).toMatch(/surprise\.wasm/);
  });

  it("anchors the PINNED release's core digests to package data, not to the local stamp", () => {
    // For the version this package pins, the expected digests are known independently of the
    // directory being checked - derived from the verified release archive and shipped. A stamp that
    // disagrees is a stamp that was edited, and a cache-local file cannot be its own trust anchor.
    const dir = preparedRuntime({ version: "314.0.6" });
    const problems = verifyPreparedRuntime({ dir, version: "314.0.6", full: true });
    // Synthetic bytes cannot be Pyodide 314.0.6, and no stamp written beside them can say they are.
    expect(problems.join("\n")).toMatch(/this package pins|release archive/i);
  });

  // For a version this package PINS, the shipped manifest is the whole answer - the exact filenames
  // and digests of the release archive whose own digest is pinned - so nothing is decided from the
  // directory itself. It is injected here because a test cannot produce 350 MB of real Pyodide; the
  // REAL entry is exercised by `pins the shipped release table`.
  describe("a pinned runtime is measured against the release manifest, not the directory", () => {
    const PINNED = "888.0.0";
    const BODIES: Record<string, string> = {
      "pyodide.mjs": "loader",
      "pyodide.asm.wasm": "wasm",
      "pyodide.asm.mjs": "glue",
      "python_stdlib.zip": "stdlib",
      "pyodide-lock.json": JSON.stringify({ packages: {} }),
    };
    const ARCHIVE = "d".repeat(64);
    const releases = {
      [PINNED]: {
        sha256: ARCHIVE,
        core: Object.fromEntries(Object.entries(BODIES).map(([n, b]) => [n, sha(b)])),
      },
    };

    /** A directory whose bytes really do hash to the manifest's recorded core digests. */
    const pinnedRuntime = (over: Record<string, string | null> = {}) => {
      const dir = mkdtempSync(join(tmpdir(), "runtime-pinned-"));
      made.push(dir);
      const digests: Record<string, string> = {};
      const write = (name: string, body: string) => {
        writeFileSync(join(dir, name), body);
        digests[name] = sha(body);
      };
      for (const [name, body] of Object.entries(BODIES)) {
        const chosen = name in over ? over[name] : body;
        if (chosen === null) continue; // absent on purpose
        write(name, chosen);
      }
      for (const [name, body] of Object.entries(over)) {
        if (name in BODIES || body === null) continue;
        write(name, body);
      }
      writeFileSync(
        join(dir, RUNTIME_STAMP),
        JSON.stringify({
          version: PINNED,
          sha256: ARCHIVE,
          full: true,
          packages: 0,
          digests,
          preparedAt: new Date().toISOString(),
        }),
      );
      return dir;
    };

    const check = (dir: string, options = {}) =>
      verifyPreparedRuntime({ dir, version: PINNED, full: false, releases, ...options });

    it("accepts a directory whose core files hash to exactly what the release shipped", () => {
      expect(check(pinnedRuntime())).toEqual([]);
    });

    it("refuses the historical loader name for a release that does not ship it", () => {
      // `pyodide.asm.js` was the Emscripten glue for years and `pyodide.asm.mjs` is the current
      // one, so for an unrecorded version the only workable rule is to accept EITHER. For a pinned
      // one the manifest says which name this release ships.
      const dir = pinnedRuntime({ "pyodide.asm.mjs": null, "pyodide.asm.js": "old glue" });
      expect(check(dir).join("\n")).toMatch(/pyodide\.asm\.mjs/);
    });

    it("…and says so even when the historical name sits BESIDE the right one", () => {
      const dir = pinnedRuntime({ "pyodide.asm.js": "old glue" });
      expect(check(dir).join("\n")).toMatch(/pyodide\.asm\.js/);
    });

    it("requires every file the manifest names, with no stamp entry able to excuse one", () => {
      const dir = pinnedRuntime({ "python_stdlib.zip": null });
      expect(check(dir).join("\n")).toMatch(/python_stdlib\.zip/);
    });

    it("checks the pinned digests with NO stamp present at all", () => {
      // Core-digest checks inside `if (stamp)` would leave `requireStamp: false` - which the CLI
      // uses for a directory prepared elsewhere - verifying nothing about the core files beyond
      // their names.
      const good = pinnedRuntime();
      rmSync(join(good, RUNTIME_STAMP));
      expect(check(good, { requireStamp: false })).toEqual([]);

      const bad = pinnedRuntime({ "pyodide.asm.wasm": "not the wasm you verified" });
      rmSync(join(bad, RUNTIME_STAMP));
      expect(check(bad, { requireStamp: false }).join("\n")).toMatch(/pyodide\.asm\.wasm/);
    });

    it("never falls back to the stamp's own digest for a pinned release", () => {
      // The stamp records sha("tampered loader") for it, so the directory is self-consistent - and
      // `anchored?.[name] ?? recorded` would compare the file against exactly that.
      const dir = pinnedRuntime({ "pyodide.mjs": "tampered loader" });
      expect(check(dir).join("\n")).toMatch(/pyodide\.mjs/);
    });

    // A RECORDED VERSION WITH A BROKEN INVENTORY MUST FAIL CLOSED. `coreOf` answers `null` for
    // "nothing recorded", which unlocks the weaker rules - historical filename alternatives, and
    // the directory's own stamp as the anchor - and must not also answer `null` for a recorded
    // version whose `core` entry is `{}`, `[]`, `null` or nonsense.
    const broken = (core: unknown) => ({
      [PINNED]: { sha256: ARCHIVE, core },
    });

    it.each([
      ["an empty object", {}],
      ["an array", []],
      ["null", null],
      ["a string", "pyodide.asm.mjs"],
      ["a digest that is not one", { "pyodide.mjs": "not-a-digest" }],
      ["a traversal filename", { "../../etc/passwd": "e".repeat(64) }],
      ["an inventory missing the current loader", { "pyodide.mjs": "e".repeat(64) }],
    ])("refuses a recorded version whose core inventory is %s", (_label, core) => {
      const dir = pinnedRuntime();
      const problems = verifyPreparedRuntime({
        dir,
        version: PINNED,
        full: false,
        releases: broken(core) as never,
      });
      expect(problems.join("\n")).toMatch(/runtime-releases\.json/);
      expect(problems.length).toBeGreaterThan(0);
    });

    it("…and never falls back to the historical loader name for such a version", () => {
      // The exact substitution a fallback would permit: a directory carrying the old Emscripten
      // glue instead of the new one, under a version whose manifest was emptied.
      const dir = pinnedRuntime({ "pyodide.asm.mjs": null, "pyodide.asm.js": "old glue" });
      const problems = verifyPreparedRuntime({
        dir,
        version: PINNED,
        full: false,
        releases: broken({}) as never,
      });
      expect(problems.length).toBeGreaterThan(0);
    });

    it("…and never accepts the directory's own stamp as the digest anchor for one", () => {
      // The fixture's stamp records the digest of whatever bytes are on disk, so under the TOFU
      // rules a tampered file verifies against its own tampered digest. For a recorded version that
      // must be impossible whatever shape its manifest entry is in.
      const dir = pinnedRuntime({ "pyodide.asm.wasm": "not the wasm you verified" });
      const problems = verifyPreparedRuntime({
        dir,
        version: PINNED,
        full: false,
        releases: broken(null) as never,
      });
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join("\n")).toMatch(/runtime-releases\.json/);
    });

    it("still treats a version nobody recorded as trust-on-first-use", () => {
      // The documented explicit-digest path: no entry at all, so the stamp is the only record
      // there is and the historical alternatives are the only workable rule.
      const dir = pinnedRuntime();
      expect(verifyPreparedRuntime({ dir, version: PINNED, full: false, releases: {} })).toEqual(
        [],
      );
    });

    it("pins the shipped release table: exact names, exact digests, no alternatives", () => {
      // The rules above are only worth anything if what ships actually records a core inventory.
      // This checks the shipped data rather than a fixture.
      const core = coreOf("314.0.6");
      expect(core).toBeTruthy();
      expect(Object.keys(core!).sort()).toEqual([
        "pyodide-lock.json",
        "pyodide.asm.mjs",
        "pyodide.asm.wasm",
        "pyodide.mjs",
        "python_stdlib.zip",
      ]);
      for (const digest of Object.values(core!)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(core!["pyodide.asm.js"]).toBeUndefined();
    });
  });

  it("rejects a stamp whose `full` disagrees with the mode being asked for", () => {
    const dir = preparedRuntime({ full: false });
    expect(verify(dir).join("\n")).toMatch(/--full/);
  });

  it("rejects a lock entry with no file name or a malformed digest under --full", () => {
    for (const packages of [
      { numpy: { sha256: sha("numpy bytes") } },
      { numpy: { file_name: "numpy-1.0-none-any.whl", sha256: "nope" } },
      { numpy: { file_name: "../numpy.whl", sha256: sha("numpy bytes") } },
    ] as unknown as Record<string, { file_name: string; sha256: string }>[]) {
      const dir = preparedRuntime({ packages });
      expect(verify(dir).length, JSON.stringify(packages)).toBeGreaterThan(0);
    }
  });
});

describe("the CLI itself", () => {
  const cli = new URL("../bin/freva-browser-python.mjs", import.meta.url).pathname;
  const run = (args: string[]) => {
    try {
      return {
        status: 0,
        out: execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }),
      };
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { status: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  it("refuses a poisoned warm cache instead of announcing it is already prepared", () => {
    const dir = preparedRuntime();
    writeFileSync(join(dir, "pyodide.asm.wasm"), "placeholder");
    const result = run([
      "prepare-runtime",
      "--version",
      UNPINNED,
      "--sha256",
      UNPINNED_ARCHIVE,
      "--out",
      dir,
      "--full",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.out).not.toMatch(/already prepared/);
    expect(result.out).toMatch(/pyodide\.asm\.wasm/);
  });

  it("refuses an empty lock under --full rather than reporting 0 packages", () => {
    const dir = preparedRuntime({ packages: {}, bodies: {} });
    const result = run([
      "prepare-runtime",
      "--version",
      UNPINNED,
      "--sha256",
      UNPINNED_ARCHIVE,
      "--out",
      dir,
      "--full",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.out).not.toMatch(/0 packages listed, 0 absent/);
  });

  it("accepts a healthy warm cache without downloading anything", () => {
    const dir = preparedRuntime();
    const result = run([
      "prepare-runtime",
      "--version",
      UNPINNED,
      "--sha256",
      UNPINNED_ARCHIVE,
      "--out",
      dir,
      "--full",
    ]);
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/already prepared/);
  });

  it("leaves a healthy runtime untouched when a preparation fails", () => {
    const dir = preparedRuntime();
    const before = readFileSync(join(dir, "pyodide.asm.wasm"), "utf8");
    // A version with no recorded digest and no --sha256: the command must refuse before touching
    // anything, rather than emptying the destination on its way to failing.
    const result = run(["prepare-runtime", "--version", "1.2.3", "--out", dir, "--force"]);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(dir, RUNTIME_STAMP))).toBe(true);
    expect(readFileSync(join(dir, "pyodide.asm.wasm"), "utf8")).toBe(before);
  });
});
