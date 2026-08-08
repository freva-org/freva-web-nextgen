// OS detection, shell dialects, host derivation, and host-aware commands.

import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAP_CONFIG } from "../src/map.js";
import {
  detectOS,
  defaultShellFor,
  deriveHost,
  bashQuote,
  psQuote,
  cmdQuote,
  SHELLS,
} from "../src/shell.js";
import { pythonCommand, createInitialState } from "../src/state.js";
import { cliCommand } from "../src/commands.js";
import type { ResolvedConfig } from "../src/types.js";

function cfg(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    map: DEFAULT_MAP_CONFIG,
    inspectorUrl: "",

    apiBase: "/api",
    flavour: "freva",
    devNotes: false,
    authEnabled: false,
    enableHeavyOps: false,
    enableStrictBBoxModes: false,
    metadata: {},
    metadataScriptUrl: null,
    features: {
      themeToggle: true,
      terminal: true,
      overview: true,
      export: true,
      details: true,
      search: true,
      lensSwitcher: true,
      inspect: true,
      brand: true,
      footer: true,
    },
    theme: {},
    brand: { title: "Freva", mark: "≈", description: "", showMark: true, showTitle: true },
    terminal: { host: null, shell: null, os: null },
    getAuthToken: () => null,
    getCsrfToken: () => null,
    ...over,
  } as ResolvedConfig;
}

test("detectOS: userAgentData wins, then platform, then userAgent; else unknown", () => {
  assert.equal(
    detectOS({ userAgentData: { platform: "Windows" }, platform: "MacIntel" }),
    "windows",
  );
  assert.equal(detectOS({ platform: "MacIntel" }), "mac");
  assert.equal(detectOS({ platform: "Linux x86_64" }), "linux");
  assert.equal(detectOS({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64)" }), "windows");
  assert.equal(detectOS({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)" }), "mac");
  assert.equal(detectOS({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "linux");
  assert.equal(detectOS({}), "unknown");
});

test("defaultShellFor: windows->powershell, everything else->bash", () => {
  assert.equal(defaultShellFor("windows"), "powershell");
  assert.equal(defaultShellFor("mac"), "bash");
  assert.equal(defaultShellFor("linux"), "bash");
  assert.equal(defaultShellFor("unknown"), "bash");
});

test("shell quoting is dialect-correct and injection-safe", () => {
  assert.equal(bashQuote("a'b"), "'a'\\''b'"); // POSIX '\'' idiom
  assert.equal(psQuote("a'b"), "'a''b'"); // PowerShell doubles the quote
  assert.equal(cmdQuote("a b"), '"a b"'); // cmd double-quotes whitespace
  assert.equal(bashQuote("$(rm -rf ~)"), "'$(rm -rf ~)'"); // expansion suppressed
  assert.equal(bashQuote("cmip6"), "cmip6"); // safe bare token unquoted
});

test("deriveHost: config override wins; relative base resolves against origin; absolute kept", () => {
  assert.equal(deriveHost("/api", "https://pinned.example/x"), "https://pinned.example/x");
  assert.equal(
    deriveHost("/api/freva-nextgen", null, "https://freva.dkrz.de"),
    "https://freva.dkrz.de/api/freva-nextgen",
  );
  assert.equal(deriveHost("https://host.example/api/", null), "https://host.example/api");
  assert.equal(deriveHost("", null), null);
});

test("cliCommand: shell-aware; --host is never emitted (freva-client resolves its own host)", () => {
  const s = createInitialState(cfg());
  s.selected = { project: ["cmip6"] };
  assert.equal(cliCommand(s), "freva-client databrowser data-search project=cmip6");
  const ps = cliCommand(s, { shell: "powershell" });
  assert.doesNotMatch(ps, /--host/, "no --host: the client reads ~/.config/freva/freva.toml");
  assert.match(ps, /project=cmip6/);
  // continuation/prompt live on the shell model
  assert.equal(SHELLS.powershell.cont, "`");
  assert.equal(SHELLS.powershell.prompt, "PS>");
});

test("pythonCommand: bare databrowser(...) call - no host, no `db =` binding", () => {
  const s = createInitialState(cfg());
  s.selected = { project: ["cmip6"] };
  const py = pythonCommand(s);
  assert.doesNotMatch(py, /host=/, "no host kwarg");
  assert.doesNotMatch(py, /db = /, "no redundant binding");
  assert.match(py, /^from freva_client import databrowser\ndatabrowser\(/);
});
