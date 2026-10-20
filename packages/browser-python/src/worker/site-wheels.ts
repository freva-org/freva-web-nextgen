/**
 * Wheels a site pins and serves itself: a WebAssembly build of a library its examples need that
 * the pinned runtime does not carry. Kept apart from the two sources this package curates (the
 * derived Freva client, the add-ons) because the digests here are the site's.
 *
 * As with an add-on, every wheel is fetched and verified before any is installed, installed from
 * the verified bytes (`emfs:`, never a second download) with `deps=False`, and any failure fails
 * the start with a message naming the wheel, the URL and both digests.
 */

import { RuntimeError, type PyodideApi } from "./pyodide-runtime.js";
import { describeFailures, lastMeaningfulLine, type StartupFailure } from "./startup-failure.js";

/** Where verified site wheels are staged in the interpreter's filesystem. */
export const SITE_WHEEL_ROOT = "/freva-site-wheels";

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The wheel's file name, from its URL. The engine already checked it names a wheel. */
export function siteWheelFile(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
}

async function fetchVerified(wheel: {
  url: string;
  sha256: string;
}): Promise<{ file: string; bytes: Uint8Array } | StartupFailure> {
  const file = siteWheelFile(wheel.url);
  const base = { resource: "site-wheel" as const, artefact: file, url: wheel.url };
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return {
      ...base,
      kind: "unsupported",
      underlying:
        "this context has no Web Crypto, so a wheel cannot be verified - serve the site over " +
        "HTTPS, or from localhost. An unverified wheel is not installed.",
    };
  }
  let response: Response;
  try {
    response = await fetch(wheel.url, { credentials: "omit" });
  } catch (cause) {
    const underlying = lastMeaningfulLine(cause);
    return { ...base, kind: "unreachable", ...(underlying ? { underlying } : {}) };
  }
  if (!response.ok) return { ...base, kind: "unavailable", status: response.status };
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = hex(await subtle.digest("SHA-256", bytes));
  if (digest !== wheel.sha256) {
    return { ...base, kind: "mismatch", digests: { expected: wheel.sha256, received: digest } };
  }
  return { file, bytes };
}

/**
 * Fetch, verify and install every site wheel, in order. Returns the installed file names. Throws a
 * `RuntimeError` describing every wheel that could not be obtained, before anything is installed.
 */
export async function installSiteWheels(
  pyodide: PyodideApi,
  wheels: readonly { url: string; sha256: string }[],
  onStatus?: (message: string) => void,
): Promise<string[]> {
  if (wheels.length === 0) return [];
  onStatus?.("fetching the site's wheels");
  const results = await Promise.all(wheels.map((wheel) => fetchVerified(wheel)));
  const failures = results.filter((r): r is StartupFailure => "kind" in r);
  if (failures.length > 0) {
    throw new RuntimeError(describeFailures(failures), "packages-unreachable");
  }
  const installed: string[] = [];
  for (const result of results as { file: string; bytes: Uint8Array }[]) {
    const path = `${SITE_WHEEL_ROOT}/${result.file}`;
    pyodide.FS.mkdirTree(SITE_WHEEL_ROOT);
    pyodide.FS.writeFile(path, result.bytes);
    onStatus?.(`installing ${result.file}`);
    try {
      await pyodide.runPythonAsync(
        `import micropip\nawait micropip.install(${JSON.stringify(`emfs:${path}`)}, deps=False)\n`,
      );
    } catch (cause) {
      const underlying = lastMeaningfulLine(cause);
      throw new RuntimeError(
        describeFailures([
          {
            resource: "site-wheel",
            artefact: result.file,
            kind: "install",
            ...(underlying ? { underlying } : {}),
          },
        ]),
        "packages-unreachable",
      );
    }
    installed.push(result.file);
  }
  return installed;
}
