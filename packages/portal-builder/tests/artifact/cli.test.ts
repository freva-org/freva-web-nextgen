// The CLI surface. The commands are a public API, so the assertions that matter are about what
// they refuse: an unknown option, a missing trust anchor, an invented mode.

import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, MINIMAL_EXAMPLE, tempRoot } from "../helpers/fixture.js";
import { run } from "../../src/cli/index.js";
import { parseArgs, ArgumentError } from "../../src/cli/args.js";

afterAll(cleanupFixtures);

function capture(): {
  io: { out(t: string): void; err(t: string): void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, out, err };
}

describe("argument parsing", () => {
  it("refuses an option that does not exist", () => {
    expect(() => parseArgs(["build", "--runtime"])).toThrow(ArgumentError);
    expect(() => parseArgs(["build", "--api-settings", "x"])).toThrow(ArgumentError);
  });

  it("accepts both `--flag value` and `--flag=value`", () => {
    expect(parseArgs(["build", "--out", "x"]).flags.out).toBe("x");
    expect(parseArgs(["build", "--out=x"]).flags.out).toBe("x");
    expect(parseArgs(["build", "--quiet"]).flags.quiet).toBe(true);
  });
});

describe("commands", () => {
  it("prints help and a version", async () => {
    const help = capture();
    expect(await run(["help"], help.io)).toBe(0);
    expect(help.out.join("")).toContain("freva-portal-builder");
    expect(help.out.join("")).toContain("There is no --runtime");

    const version = capture();
    expect(await run(["version"], version.io)).toBe(0);
    expect(version.out.join("")).toMatch(/@freva-org\/portal-builder \d+\.\d+\.\d+/);
  });

  it("requires an explicit trusted source root for validate", async () => {
    const io = capture();
    expect(await run(["validate", "--config", join(MINIMAL_EXAMPLE, "portal.yaml")], io.io)).toBe(
      2,
    );
    expect(io.err.join("")).toContain("--source-root is required");
  });

  it("validates the minimal fictional consumer", async () => {
    const io = capture();
    const code = await run(
      [
        "validate",
        "--source-root",
        MINIMAL_EXAMPLE,
        "--config",
        join(MINIMAL_EXAMPLE, "portal.yaml"),
      ],
      io.io,
    );
    expect(code).toBe(0);
    expect(io.out.join("")).toMatch(/^ok: \d+ routes/m);
  });

  it("emits machine-readable diagnostics for CI", async () => {
    const io = capture();
    await run(
      [
        "validate",
        "--source-root",
        MINIMAL_EXAMPLE,
        "--config",
        join(MINIMAL_EXAMPLE, "portal.yaml"),
        "--diagnostics",
        "json",
      ],
      io.io,
    );
    const text = io.out.join("");
    const payload = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as {
      schemaVersion: number;
      diagnostics: unknown[];
    };
    expect(payload.schemaVersion).toBe(1);
    expect(Array.isArray(payload.diagnostics)).toBe(true);
  });

  it("refuses a config outside the source root", async () => {
    const io = capture();
    const other = tempRoot();
    const code = await run(
      ["validate", "--source-root", other, "--config", join(MINIMAL_EXAMPLE, "portal.yaml")],
      io.io,
    );
    expect(code).toBe(1);
    expect(io.err.join("")).toContain("FP1001");
  });

  it("reports an unknown command rather than guessing", async () => {
    const io = capture();
    expect(await run(["deploy"], io.io)).toBe(2);
    expect(io.err.join("")).toContain("Unknown command 'deploy'");
  });

  it("migrates a saved manifest into a candidate tree and a loss report", async () => {
    const io = capture();
    const from = join(tempRoot(), "ui-manifest.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      from,
      JSON.stringify({
        title: "Legacy",
        features: { databrowser: { enabled: true } },
        uiId: "legacy",
      }),
    );
    const out = join(tempRoot(), "portal");
    expect(await run(["migrate", "--from", from, "--out", out], io.io)).toBe(0);
    expect(io.out.join("")).toContain("migration-loss-report.json");
  });
});
