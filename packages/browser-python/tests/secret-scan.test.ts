// gitleaks scans `git log -p -U0 <log-opts>`, which omits merge diffs unless told otherwise.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CI = join(ROOT, ".github/workflows/ci.yml");
const MARKER = "MERGE_ONLY_MARKER_7f3a";

function scanScript(): string {
  const workflow = readFileSync(CI, "utf8");
  const job = workflow.slice(workflow.indexOf("\n  secrets:\n"));
  const end = job.indexOf("\n  workflow-lint:\n");
  return end >= 0 ? job.slice(0, end) : job;
}

function workflowOptions(): { merges: string; opts: string[] } {
  const script = scanScript();
  const merges = /MERGES="([^"]+)"/.exec(script)?.[1] ?? "";
  const opts = [...script.matchAll(/(?:^|[\s)])opts="([^"]*)"/gm)].map((match) => match[1] ?? "");
  return { merges, opts };
}

let repo: string;
let base: string;

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });

const gitleaksInput = (opts: string) => git("log", "-p", "-U0", ...opts.split(" "));

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "secret-scan-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "config.txt"), "value = one\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  base = git("rev-parse", "HEAD").trim();

  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "config.txt"), "value = feature\n");
  git("commit", "-q", "-am", "feature side");

  git("checkout", "-q", "main");
  writeFileSync(join(repo, "config.txt"), "value = main\n");
  git("commit", "-q", "-am", "main side");

  try {
    git("merge", "-q", "feature");
  } catch {
    // the expected conflict
  }
  writeFileSync(join(repo, "config.txt"), `value = ${MARKER}\n`);
  git("add", "config.txt");
  git("commit", "-q", "--no-edit");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("the secret scan sees what a merge resolution adds", () => {
  it("is a real gap without merge diffs", () => {
    expect(gitleaksInput(`${base}..HEAD`)).not.toContain(MARKER);
  });

  it("passes merge diffs in every case the workflow builds", () => {
    const { merges, opts } = workflowOptions();
    expect(merges).toBe("--diff-merges=first-parent");
    expect(opts.length).toBeGreaterThanOrEqual(4);
    for (const option of opts) expect(option.startsWith("$MERGES ")).toBe(true);
  });

  it("finds the merge-only line with the workflow's options", () => {
    const { merges } = workflowOptions();
    expect(gitleaksInput(`${merges} ${base}..HEAD`)).toContain(MARKER);
    expect(gitleaksInput(`${merges} --full-history --all`)).toContain(MARKER);
  });

  it("builds no option string that would hand git an empty argument", () => {
    for (const option of workflowOptions().opts) {
      expect(option).not.toMatch(/^\s|\s$|\s\s/);
    }
  });
});
