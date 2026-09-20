/**
 * The sunset check: every patch in `freva_client_compat.py` must still be NEEDED.
 *
 * A compatibility layer that outlives its problem keeps reaching into internals upstream has
 * since fixed, and nobody deletes it because nobody remembers what it was for. Each patch
 * carries a removal condition in prose; this makes it executable. Read as text rather than
 * exercised, the patches only applying inside Pyodide: the file must still declare the versions
 * it was written against, every patch must still state its removal condition, and the pinned
 * versions must match the wheels the profile installs.
 */
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FREVA_CLIENT_WHEEL } from "../src/worker/pyodide-runtime.js";

const COMPAT = readFileSync(
  fileURLToPath(new URL("../src/python/freva_client_compat.py", import.meta.url)),
  "utf8",
);

/**
 * py-oidc-auth-client is not mirrored any more: micropip resolves it from PyPI, and the version
 * it is allowed to resolve is written into the derived wheel's metadata from `runtimePins`. So
 * the pin in the plan IS the version the profile installs, and it is what the adapter has to
 * have been read against.
 */
const PINS = JSON.parse(
  readFileSync(fileURLToPath(new URL("../bin/freva-wheelhouse.json", import.meta.url)), "utf8"),
) as { frevaClient: { runtimePins: Record<string, string> } };

/** Every patch the adapter declares, by its identifier. */
const PATCHES = [
  "CONFIG_GET_DIRS",
  "AUTH_CONFIG_PORTS",
  "CONFIG_FLAVOUR",
  "INTAKE_CATALOGUE",
  "AUTHENTICATE_ASYNC",
  "TOKEN_BRIDGE",
];

describe("freva_client_compat is documented for its own deletion", () => {
  for (const patch of PATCHES) {
    it(`${patch} states an upstream problem and a removal condition`, () => {
      const start = COMPAT.indexOf(`# PATCH  ${patch}`);
      const header =
        start === -1
          ? COMPAT.slice(COMPAT.indexOf(`# PATCH  AUTHENTICATE_ASYNC`))
          : COMPAT.slice(start, start + 4000);
      expect(header, `${patch} has no PATCH block`).not.toBe("");
      expect(header).toMatch(/Upstream problem/);
      expect(header).toMatch(/Removal condition/);
    });
  }

  it("names the exact upstream versions it was written against", () => {
    expect(COMPAT).toMatch(/SUPPORTED_FREVA_CLIENT = \{[^}]+\}/);
    expect(COMPAT).toMatch(/SUPPORTED_OIDC_CLIENT = \{[^}]+\}/);
  });

  // The drift that would quietly disable everything: bump the wheel, forget the pin, and
  // `install()` raises CompatError on a profile that used to work - or worse, someone widens the
  // pin without re-reading the patches.
  it("pins the freva-client version the profile actually installs", () => {
    const version = FREVA_CLIENT_WHEEL.match(/freva_client-([^-]+)-py3/)?.[1];
    expect(version, "could not read a version out of FREVA_CLIENT_WHEEL").toBeTruthy();
    expect(
      COMPAT,
      `The profile installs freva-client ${version}, which freva_client_compat.py does not list ` +
        `in SUPPORTED_FREVA_CLIENT. Re-read every patch against that version before adding it.`,
    ).toContain(String(version));
  });

  it("pins the py-oidc-auth-client version the profile actually installs", () => {
    const version = PINS.frevaClient.runtimePins["py-oidc-auth-client"];
    expect(version, "the wheelhouse no longer carries py_oidc_auth_client").toBeTruthy();
    expect(
      COMPAT,
      `The profile installs py-oidc-auth-client ${version}, which is not in SUPPORTED_OIDC_CLIENT.`,
    ).toContain(String(version));
  });

  // The transport that is deliberately absent. httpx was measured working in the Worker before
  // any transport was written, so a PyFetch transport would be a second implementation of a
  // working one. This asserts the adapter has not quietly grown one.
  it("contains no HTTPX transport, because httpx works natively here", () => {
    expect(COMPAT).not.toMatch(/AsyncBaseTransport/);
    expect(COMPAT).not.toMatch(/pyodide_http/);
    expect(COMPAT).toMatch(/httpx was tested in this Worker/);
  });
});

// The isolation claim, made executable. The module's header says it is "the ONLY place in
// @freva-org/browser-python that knows anything about Freva's internals", and that claim is why
// the removal conditions can be honest: a patch that leaked a second copy of itself into the
// worker cannot be deleted by deleting the file that documents it. COMMENTS ARE STRIPPED BEFORE
// SCANNING, because the worker's own explanation names `databrowser_utils`, and knowing a
// symbol's name in prose is not reaching for it in code.
const UPSTREAM_INTERNALS = [
  "databrowser_utils",
  "intake_catalogue",
  "auth_headers",
  "choose_token_strategy",
  "redirect_ports",
  "get_dirs",
  "_auth_config",
];

/** Source with comments and docstrings removed, so only executable text is scanned. */
function code(source: string, language: "ts" | "py"): string {
  if (language === "ts") {
    return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }
  return source.replace(/"""[\s\S]*?"""/g, " ").replace(/#.*$/gm, "");
}

describe("the adapter is the only thing that knows Freva's internals", () => {
  const files = globSync("**/*.{ts,py}", {
    cwd: fileURLToPath(new URL("../src", import.meta.url)),
  })
    .filter((name) => !name.endsWith("freva_client_compat.py"))
    .filter((name) => !name.endsWith("python-sources.generated.ts"));

  it("finds the package's sources, so an empty scan cannot pass by accident", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const symbol of UPSTREAM_INTERNALS) {
    it(`no other source reaches for ${symbol}`, () => {
      const offenders = files.filter((name) => {
        const source = readFileSync(
          fileURLToPath(new URL(`../src/${name}`, import.meta.url)),
          "utf8",
        );
        return code(source, name.endsWith(".py") ? "py" : "ts").includes(symbol);
      });
      expect(offenders).toEqual([]);
    });
  }
});
