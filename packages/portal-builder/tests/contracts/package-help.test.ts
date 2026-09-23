// The help a visitor is shown, and the documentation an operator reads, against the policy
// itself. These string assertions are load-bearing because the failure mode is a TRUE mechanism
// described falsely: a panel offering `await micropip.install("name")` on a deployment whose
// Content-Security-Policy names no package index fails at metadata lookup; a panel saying there
// is "no disk" contradicts a runtime that reports a disk-backed `/workspace` whenever OPFS is
// available; and one implying that installing imports claims something that never happens.
//
// So this suite reads the source of the panel and the operator guide and checks the specific
// claims, not that the word "micropip" appears somewhere - which a wrong panel also satisfies.
//
// The rendered panel, in a real browser against a real interpreter, is
// `browser-tests/python-playground.mjs`. The policy value and the built headers are two other
// suites.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const PANEL = read("../../client/components/python-playground.ts");
const GUIDE = read("../../docs/python-playground.md");

/**
 * The panel's source with its commentary removed. The module's own comments quote the wordings it
 * must not render, so an absence assertion over the raw file would be satisfied by a comment.
 * Presence assertions use the raw text; this crude stripper - it also cuts `//` inside string
 * literals, which does not matter for absence - only ever proves something is NOT rendered.
 */
const CODE = PANEL.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");

describe("1. the terminal's package panel", () => {
  it("is no longer called 'Installing packages'", () => {
    // Nothing in this deployment installs by name, so that title would be untrue.
    expect(CODE).not.toContain('"Installing packages"');
    expect(PANEL).toContain('label: "Python packages"');
    expect(PANEL).toContain('title: "Python packages"');
  });

  it("offers a name-based install only where the resolved policy is the open one", () => {
    // Open mode makes the command real for deployments that asked for it, so the guard is that
    // the example sits INSIDE the branch on the resolved policy rather than being printed
    // unconditionally beside it. A restricted deployment cannot see a command it cannot run.
    const open = CODE.indexOf('const open = config.packagePolicy.kind === "open";');
    expect(open).toBeGreaterThan(-1);
    for (const match of CODE.matchAll(/micropip\.install\(\s*(["'`])([^"'`\n]*)\1/g)) {
      const literal = match[2] ?? "";
      if (/^(https?|emfs):/.test(literal)) continue;
      // A bare name is permitted, and only after the branch that decides the policy is open.
      expect(match.index ?? -1).toBeGreaterThan(open);
    }
  });

  it("keeps micropip itself, because the curated installs run on it", () => {
    // micropip is what a visitor can INSPECT with, and the mechanism the Freva wheels and the
    // add-ons are installed through, so removing it is not the goal.
    expect(PANEL).toContain('"import micropip"');
    expect(PANEL).toContain('"micropip.list()"');
  });

  it("states the RESTRICTED policy in words a visitor can act on", () => {
    expect(PANEL).toContain("This playground uses a curated Python environment");
    expect(PANEL).toContain("load automatically when you import them");
    // Written as adjacent string literals in the source, so the sentence is matched in halves.
    expect(PANEL).toContain("Additional packages such ");
    expect(PANEL).toContain(
      "as Freva or Dask are installed only when the portal operator has enabled",
    );
    expect(PANEL).toContain("Installing packages by name from a public index is not enabled by");
  });

  it("states the OPEN policy as a starting environment rather than a limit", () => {
    expect(PANEL).toContain("a working STARTING environment, not a limit");
    // What a visitor can act on: the command, and what to expect of it.
    expect(PANEL).toContain("await micropip.install(");
    expect(PANEL).toContain("pure-Python wheels usually work");
    expect(PANEL).toContain("compiled");
    // And the way back, named exactly as the menu names it.
    expect(PANEL).toContain("`Restart session` gives you the starting environment back");
  });

  it("says what actually ends an interpreter, and claims nothing beyond it", () => {
    // Close HIDES the window and the session keeps running, so a panel saying that closing ends
    // the interpreter tells a visitor their variables are gone when they are not.
    expect(PANEL).toContain("Closing this window only hides it - the ");
    // The halves again: this sentence is split across the `+` at exactly this point, so the whole
    // phrase is not in the file and an assertion for it would be satisfied by a COMMENT saying
    // the same thing - which is what happened, until the comment was reworded.
    expect(PANEL).toContain("session keeps running and its variables are still there");
    expect(PANEL).toContain("`Restart session` replaces it");
    // Against the comment-stripped source, so the module's own note may quote the wording it
    // forbids.
    expect(CODE).not.toContain("closing the window ends the");
    // And it does not overclaim in the other direction either.
    expect(CODE).not.toMatch(/erases? all browser storage/i);
  });

  it("keeps the micropip link, framed for whichever policy is in force", () => {
    expect(PANEL).toContain("https://micropip.pyodide.org/");
    // Restricted: the caveat stays, because the page IS stricter than the documentation.
    expect(PANEL).toMatch(/describes micropip in general; this site is stricter/);
    // Open: the caveat would itself be the untrue sentence, so it is dropped.
    expect(PANEL).toContain('? "micropip documentation"');
  });

  it("is generated from the resolved policy rather than written beside it", () => {
    // The row exists so that the sentence and the `connect-src` header have one author.
    expect(PANEL).toContain("config.packagePolicy");
    expect(PANEL).toContain('"packages come from"');
  });

  it("reports the environment it observed, instead of restating the configuration", () => {
    expect(PANEL).toContain('rows.push(["profile", config.profile]);');
    expect(PANEL).toContain('"add-ons"');
    expect(PANEL).toContain("report.packages");
    expect(PANEL).toContain("report.addons");
    expect(PANEL).toContain("report.workspace.available");
  });

  it("no longer claims there is no disk, and no longer implies installing imports", () => {
    expect(CODE).not.toContain("no subprocess and no disk");
    expect(CODE).not.toContain("fetch a wheel and import it");
    // What it says instead is conditional on what the interpreter reported.
    expect(PANEL).toContain("disk-backed");
    expect(PANEL).toContain("files stay in this tab's memory");
  });

  it("says what a session keeps and what replaces it - which is not the same claim", () => {
    // "Nothing survives the session" is two errors in one sentence: it appears on a window whose
    // CLOSE action only hides the interpreter, and it claims more than ending an interpreter does
    // - a restart clears no browser storage and cannot unsend a request that already left.
    expect(CODE).not.toMatch(/Nothing survives the session/);
    expect(PANEL).toContain("Anything you install lives in this interpreter");
    expect(PANEL).toContain("reloading the page replaces the whole document");
  });
});

describe("2. the operator guide", () => {
  it("describes the three, and only three, sources of a package", () => {
    expect(GUIDE).toContain("## Packages: a curated environment");
    expect(GUIDE).toContain("runtimeIndexUrl");
    expect(GUIDE).toContain("wheelhouseUrl");
    expect(GUIDE).toContain("addonBaseUrl");
    // Per PROFILE now: `freva-client` resolves its dependencies from the index, every other
    // profile has no fall-through to one. A guide giving a single answer for the whole builder
    // would be wrong in whichever direction it chose.
    expect(GUIDE).toMatch(/Every other\s+profile still has no fall-through to an index/);
    expect(GUIDE).toMatch(/no longer fully curated/i);
  });

  it("says that a content author cannot contribute a package, a URL or a command", () => {
    expect(GUIDE).toMatch(/A content author cannot change any of this/);
    expect(GUIDE).toMatch(/no `data-\*` attribute the page reads carries|nowhere in the authoring/);
  });

  it("explains that the panel and the header are one decision", () => {
    expect(GUIDE).toContain("src/model/package-policy.ts");
    expect(GUIDE).toMatch(/cannot drift/);
    expect(GUIDE).toContain("REFUSED_PACKAGE_ORIGINS");
  });

  it("documents the open mode, including what it does NOT change", () => {
    expect(GUIDE).toContain('<h3 id="open-mode-network-https">');
    expect(GUIDE).toContain("network: https");
    // The widening, stated as the one directive it is.
    expect(GUIDE).toMatch(/`https:` — the [_*]scheme[_*] — is added to\s*\n?`connect-src`/);
    expect(GUIDE).toMatch(/deliberately not `\*`/);
    // The things it leaves alone, which is the half an operator is most likely to assume wrongly.
    expect(GUIDE).toMatch(/still digest-checked|still pinned/);
    expect(GUIDE).toMatch(/does not lower the bar on what/);
    // And the decision it is entangled with.
    expect(GUIDE).toMatch(/credential boundary/i);
    expect(GUIDE).toMatch(/supply chain/i);
  });

  it("says where the widening actually lands in each hosting topology", () => {
    // And for the right reason. "CSP has no per-Worker `connect-src`" is false: a dedicated
    // Worker loaded from a URL is governed by the policy delivered on its own script response.
    // The page carries the scheme in the same-origin arrangement because this artifact records
    // ONE policy and hosts send it on every response - a hosting contract, not a limit of CSP. A
    // wrong reason in an operator guide is how a later reader concludes a redesign is impossible.
    expect(GUIDE).toMatch(
      /governed\s*\n?by the Content-Security-Policy delivered on \*\*its own script response\*\*/,
    );
    expect(GUIDE).not.toMatch(/no per-Worker `connect-src`/);
    expect(GUIDE).toMatch(/hosting.{0,80}decision/s);
    expect(GUIDE).toContain(
      "so that policy carries the scheme and therefore the page carries it too",
    );
    expect(GUIDE).toContain("with `playgroundOrigin` set");
  });

  it("does not tell an operator that a warning dialog would do instead", () => {
    expect(GUIDE).toMatch(/A warning dialog is\s*\n?not a control here|not a control/);
  });
});
