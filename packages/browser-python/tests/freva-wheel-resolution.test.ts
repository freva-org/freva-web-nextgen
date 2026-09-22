/**
 * The derived Freva wheel, resolved against the real PyPI - the one test here that needs a
 * network, and the only one that can answer the questions the unit tests cannot.
 *
 * Everything else about the wheelhouse is checked against pins and synthetic fixtures, which is
 * right: a unit suite that downloaded thirty packages would be slow, flaky and a different kind
 * of test wearing a unit test's clothes. But the whole point of the one-wheel design is that
 * micropip RESOLVES the dependencies, and a pin written into metadata is only a claim until a
 * resolver has agreed with it. So this builds the real wheel and asks a real resolver.
 *
 * CPython's pip, not Pyodide's micropip. The question is what the DERIVED METADATA resolves to,
 * which is a property of the wheel and the index, not of the interpreter reading them - and pip
 * is here already, while a Pyodide runtime in Node needs a distribution this suite has no
 * business assembling. What only a browser can answer - that micropip fetches these over the
 * network the page's CSP permits - is `browser-tests/freva-client.mjs`.
 *
 * Opt-in through BROWSER_PYTHON_NETWORK=1, like every other suite that leaves this machine.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { prepareFrevaWheelhouse } from "../bin/freva-wheelhouse.mjs";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const PINS = JSON.parse(readFileSync(join(PKG, "bin/freva-wheelhouse.json"), "utf8")) as {
  frevaClient: {
    derived: { file: string };
    runtimePins: Record<string, string>;
    transitivePins: Record<string, string>;
  };
};

const NETWORK = process.env.BROWSER_PYTHON_NETWORK === "1";
const python = process.env.PYTHON ?? "python3";

let work = "";
afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/** Build the wheel once, into a temp directory. Never into the tree: it is not a fixture. */
async function wheel(): Promise<string> {
  work ||= mkdtempSync(join(tmpdir(), "freva-wheel-"));
  const out = join(work, "wheels");
  let failure = "";
  await prepareFrevaWheelhouse(
    { out },
    {
      fail: (message: string) => {
        failure = message;
      },
      log: () => {},
    },
  );
  if (failure) throw new Error(failure);
  return join(out, PINS.frevaClient.derived.file);
}

describe.skipIf(!NETWORK)("the derived wheel, resolved against the real index", () => {
  it("resolves every pinned dependency to exactly the version the metadata names", async () => {
    const path = await wheel();
    const report = join(work, "report.json");
    execFileSync(
      python,
      ["-m", "pip", "install", "--dry-run", "--quiet", "--report", report, path],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 },
    );
    const resolved = new Map<string, string>(
      (
        JSON.parse(readFileSync(report, "utf8")).install as { metadata: Record<string, string> }[]
      ).map((item) => [item.metadata.name!.toLowerCase(), item.metadata.version!] as const),
    );
    // BOTH MAPS. `runtimePins` gives an `==` to a requirement upstream declares; `transitivePins`
    // ADDS one it does not, which is the only way to hold a dependency-of-a-dependency still.
    // Iterating only the first would leave `shellingham` and `annotated-doc` free to float and
    // this test green while it happened.
    const pins = { ...PINS.frevaClient.runtimePins, ...PINS.frevaClient.transitivePins };
    expect(Object.keys(pins).length).toBeGreaterThanOrEqual(5);
    for (const [name, version] of Object.entries(pins)) {
      expect(resolved.get(name), `${name} is pinned in the derived metadata`).toBe(version);
    }
    // THE WHOLE REASON THE DERIVATION EXISTS. intake-esm requires a polars this runtime cannot
    // satisfy, so the extra is what keeps the resolver away from it - and a resolver that
    // reached it would report it here, one step before a browser did.
    expect(resolved.has("intake-esm")).toBe(false);
    expect(resolved.has("freva-client")).toBe(true);
  }, 900_000);

  it("installs, imports, and still refuses intake with the browser explanation", async () => {
    const path = await wheel();
    const site = join(work, "site");
    execFileSync(python, ["-m", "pip", "install", "--quiet", "--no-deps", "--target", site, path], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    });
    // `--no-deps`, and the overlay is loaded BY PATH rather than imported as
    // `freva_client.utils.lazy`: the package's `__init__` reaches for `py_oidc_auth_client`,
    // which the resolution test above covers and this one deliberately has not installed. The
    // overlay itself imports nothing outside the standard library.
    const probe = [
      "import json, importlib.util",
      `spec = importlib.util.spec_from_file_location("lazy", ${JSON.stringify(
        join(site, "freva_client", "utils", "lazy.py"),
      )})`,
      "lazy = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(lazy)",
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(site)})`,
      "import importlib.metadata as md",
      "out = {'version': md.version('freva-client'), 'raised': {}}",
      "for name in ('intake', 'intake_esm'):",
      "    try:",
      "        lazy.LazyModule(name).__getattr__('open_esm_datastore')",
      "        out['raised'][name] = None",
      "    except Exception as error:",
      "        out['raised'][name] = str(error)",
      "print(json.dumps(out))",
    ].join("\n");
    const result = JSON.parse(
      execFileSync(python, ["-c", probe], { encoding: "utf8", timeout: 120_000 }),
    ) as { version: string; raised: Record<string, string | null> };

    expect(result.version).toBe("2607.1.0+browser.1");
    for (const name of ["intake", "intake_esm"]) {
      expect(result.raised[name]).toContain("not included in the browser profile");
      expect(result.raised[name]).toContain("Use the standard Freva Python environment");
    }
  }, 900_000);
});
