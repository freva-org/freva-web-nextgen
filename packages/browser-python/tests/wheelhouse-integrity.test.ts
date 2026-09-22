/**
 * The wheelhouse is checked against the PINNED PLAN, not against its own note to itself.
 *
 * Reading the manifest sitting in the directory and confirming each file it lists hashes to the
 * digest it records is a self-consistency check, and self-consistency is exactly what a wrong
 * directory has: drop a wheel along with its entry and there are no problems; put one
 * `unexpected.whl` in an empty directory with a manifest describing it and that verifies too.
 * `bin/freva-wheelhouse.json` is the plan, it ships with the package, and it is the only thing
 * entitled to say what a wheelhouse should contain.
 *
 * The wheelhouse itself is NOT shipped - the derived wheel is built from PyPI, and no `.whl` is
 * tracked by git - so every case below describes a SYNTHETIC wheelhouse and hands
 * `verifyWheelhouse` the matching synthetic plan through its second parameter. What is checked is
 * the verifier's reasoning, which is the part a wrong directory has to get past. The one thing
 * asserted about the real plan is its shape: one wheel, one recorded digest.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { verifyWheelhouse, plannedWheelhouse, plannedWheels } from "../bin/freva-wheelhouse.mjs";

/** The synthetic derived wheel these tests plan for, and the upstream it is derived from. */
const SOURCE = "synthetic_client-1.0.0-py3-none-any.whl";
const DERIVED = "synthetic_client-1.0.0+browser.1-py3-none-any.whl";
const BODY = "the bytes of a wheel that exists only for this test";

const made: string[] = [];
afterEach(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made.length = 0;
});

const sha = (body: Buffer | string) => createHash("sha256").update(body).digest("hex");

/** The plan under test: one derived wheel, exactly the shape the shipped plan has. */
const plan = () => [
  {
    file: DERIVED,
    sha256: sha(BODY),
    name: "synthetic-client",
    version: "1.0.0+browser.1",
    derivedFrom: SOURCE,
  },
];

/** A synthetic wheelhouse that satisfies that plan, which a test then breaks in one way. */
function wheelhouse(): {
  dir: string;
  manifest: () => Record<string, unknown>;
  write: (m: unknown) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "wheelhouse-"));
  made.push(dir);
  writeFileSync(join(dir, DERIVED), BODY);
  writeFileSync(
    join(dir, "MANIFEST.json"),
    JSON.stringify(
      {
        wheels: [
          {
            file: DERIVED,
            sha256: sha(BODY),
            name: "synthetic-client",
            version: "1.0.0+browser.1",
            derivedFrom: SOURCE,
          },
        ],
      },
      null,
      2,
    ),
  );
  const manifest = () => JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8"));
  const write = (m: unknown) =>
    writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify(m, null, 2));
  return { dir, manifest, write };
}

/** Everything wrong with `dir`, as one string, judged against the synthetic plan. */
const problemsIn = (dir: string) => verifyWheelhouse(dir, plan()).join("\n");

describe("a synthetic wheelhouse that is the plan", () => {
  it("rejects a wheel on disk that nobody declared", () => {
    // Neither the plan nor the manifest describes the DIRECTORY, and a static host serves what
    // is in it: a stale build's leftover sits beside the current wheel at a reachable URL, and a
    // check that walks only the plan and the manifest never looks at it.
    const { dir } = wheelhouse();
    writeFileSync(join(dir, "stale-0.9.0-py3-none-any.whl"), "an undeclared, stale wheel");
    expect(problemsIn(dir)).toMatch(/stale-0\.9\.0-py3-none-any\.whl/);
  });

  it("verifies", () => {
    const { dir } = wheelhouse();
    expect(verifyWheelhouse(dir, plan())).toEqual([]);
  });
});

describe("a wheelhouse that is not the plan", () => {
  it("rejects a missing wheel even when its manifest entry went with it", () => {
    const { dir, manifest, write } = wheelhouse();
    rmSync(join(dir, DERIVED));
    const m = manifest();
    m.wheels = (m.wheels as { file: string }[]).filter((w) => w.file !== DERIVED);
    write(m);
    expect(problemsIn(dir)).toMatch(/synthetic_client/);
  });

  it("rejects a directory holding one unexpected wheel that matches its own manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "wheelhouse-"));
    made.push(dir);
    writeFileSync(join(dir, "unexpected.whl"), "not a wheel this package installs");
    writeFileSync(
      join(dir, "MANIFEST.json"),
      JSON.stringify({
        wheels: [{ file: "unexpected.whl", sha256: sha("not a wheel this package installs") }],
      }),
    );
    const problems = problemsIn(dir);
    expect(problems).toMatch(/unexpected\.whl/);
    expect(problems).toMatch(/synthetic_client/);
  });

  it("rejects a stale version of a pinned wheel", () => {
    const { dir, manifest, write } = wheelhouse();
    const m = manifest();
    const entry = (m.wheels as { file: string; sha256: string; version?: string }[]).find((w) =>
      w.file.startsWith("synthetic_client"),
    )!;
    rmSync(join(dir, entry.file));
    writeFileSync(join(dir, "synthetic_client-0.9.0+browser.1-py3-none-any.whl"), "an older build");
    entry.file = "synthetic_client-0.9.0+browser.1-py3-none-any.whl";
    entry.sha256 = sha("an older build");
    entry.version = "0.9.0+browser.1";
    write(m);
    expect(problemsIn(dir)).toMatch(/synthetic_client/);
  });

  it("rejects a duplicated entry", () => {
    const { dir, manifest, write } = wheelhouse();
    const m = manifest();
    const wheels = m.wheels as unknown[];
    wheels.push(wheels[0]);
    write(m);
    expect(problemsIn(dir)).toMatch(/twice|duplicate/i);
  });

  it("rejects an extra entry nobody planned for", () => {
    const { dir, manifest, write } = wheelhouse();
    writeFileSync(join(dir, "extra-1.0-py3-none-any.whl"), "extra");
    const m = manifest();
    (m.wheels as unknown[]).push({ file: "extra-1.0-py3-none-any.whl", sha256: sha("extra") });
    write(m);
    expect(problemsIn(dir)).toMatch(/extra-1\.0/);
  });

  it("rejects a derived wheel that claims a different source", () => {
    const { dir, manifest, write } = wheelhouse();
    const m = manifest();
    const derived = (m.wheels as { file: string; derivedFrom?: string }[]).find((w) =>
      w.file.includes("+browser."),
    )!;
    derived.derivedFrom = "freva_client-9999.0.0-py3-none-any.whl";
    write(m);
    expect(problemsIn(dir)).toMatch(/derived|source/i);
  });

  it("rejects a wheel whose bytes do not match the pinned digest", () => {
    const { dir } = wheelhouse();
    writeFileSync(join(dir, DERIVED), "not the wheel the plan pins");
    expect(problemsIn(dir)).toMatch(/synthetic_client/);
  });

  it("rejects a traversal or absolute path in the manifest", () => {
    for (const bad of ["../escape.whl", "/etc/passwd", "nested/x.whl"]) {
      const { dir, manifest, write } = wheelhouse();
      const m = manifest();
      (m.wheels as { file: string }[])[0]!.file = bad;
      write(m);
      expect(problemsIn(dir), bad).toMatch(/plain file name|traversal|absolute/i);
    }
  });

  it("rejects a manifest that mentions no planned wheel at all", () => {
    const { dir, manifest, write } = wheelhouse();
    const m = manifest();
    (m.wheels as { file: string }[])[0]!.file = "someone_elses-1.0-py3-none-any.whl";
    write(m);
    expect(problemsIn(dir)).toMatch(/does not mention/i);
  });

  it("rejects a manifest that is missing entirely", () => {
    const { dir } = wheelhouse();
    rmSync(join(dir, "MANIFEST.json"));
    expect(verifyWheelhouse(dir, plan()).length).toBeGreaterThan(0);
  });

  it("rejects a manifest that is not valid JSON", () => {
    const { dir } = wheelhouse();
    writeFileSync(join(dir, "MANIFEST.json"), "{not json");
    expect(problemsIn(dir)).toMatch(/JSON/i);
  });
});

describe("the plan this package ships", () => {
  it("is one wheel with a recorded digest, and nothing mirrored beside it", () => {
    // The dependencies used to be mirrored here, one entry each. They are resolved from PyPI
    // now, and a second entry creeping back in is a second resolver nobody asked for.
    const shipped = plannedWheelhouse();
    expect(shipped).toHaveLength(1);
    expect(plannedWheels()).toHaveLength(1);
    expect(shipped[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the command reports what it verified, not what it planned", () => {
  it("exposes no way to record a derived digest from a production run", async () => {
    const source = readFileSync(
      fileURLToPath(new URL("../bin/freva-wheelhouse.mjs", import.meta.url)),
      "utf8",
    );
    // `--record-derived` lets a run whose derived wheel does not match the pinned digest write
    // it anyway - the one check between "the transformation changed" and "a wheelhouse that
    // verifies" - so a production command must not carry it. Comments are stripped first,
    // because the file EXPLAINS why the flag is gone.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/record-derived/);
  });
});
