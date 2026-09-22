// Build the static `/freva-wheels/` directory the `freva-client` profile loads.
//
// ONE WHEEL. The directory holds the derived freva-client wheel and a manifest, and nothing else:
// the profile installs it WITH dependency resolution, so micropip fetches the ordinary
// dependencies from PyPI. Mirroring them here would be a second resolver, pinned by hand, whose
// answers go stale without anyone noticing.
//
// A SHIPPED COMMAND because the npm package publishes only `bin`, `dist`, README and LICENSE: a
// consumer following the README otherwise has no supported way to produce the directory the
// README tells them to serve. It downloads the pinned upstream wheel, verified against a recorded
// SHA-256, and builds the derived one. It prepares into a staging directory, verifies and swaps,
// so an interrupted run cannot leave a half-built wheelhouse where a working one was, and writes
// a manifest of the source and the result.
//
// WHY THE DERIVED WHEEL EXISTS. `freva-client` requires `intake_esm` unconditionally, and this
// runtime cannot satisfy that: Pyodide 314.0.6 ships polars 1.33.1, intake-esm requires polars
// >=1.24,<1.33. Rebuilding Polars is not the answer and pinning an older one would fight the
// runtime, so the browser profile omits intake-esm and `intake_catalogue()` says so in a sentence
// rather than failing with a resolver error.
//
// WHAT IS CHANGED, and nothing else: the unconditional `Requires-Dist: intake_esm` becomes an
// extra, so `pip install freva-client[intake]` still means what it meant; the two requirements in
// `runtimePins` are given `==` specifiers, because the resolver would otherwise take whatever is
// newest and `freva_client_compat.py` supports one exact py-oidc-auth-client; a PEP 440 local
// segment is added, because a wheel whose contents differ from upstream must not claim to BE
// upstream; and `freva_client/utils/lazy.py` is overlaid so touching `intake`/`intake_esm` raises
// the documented sentence - upstream already routes both through a `LazyModule` seam, so this
// replaces a message and changes no control flow.
//
// REMOVAL CONDITION. Delete the derived wheel and this transformation once upstream freva-client
// makes `intake_esm` optional; the published wheel then installs unmodified and the profile omits
// the extra. Track https://github.com/freva-org/freva-nextgen -> freva-client/pyproject.toml.
// `rewriteMetadata` throws when the upstream METADATA no longer carries the unconditional
// requirement, so every build enforces the condition rather than remembering it.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readZip, writeZip } from "./zip.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PINS = JSON.parse(readFileSync(join(HERE, "freva-wheelhouse.json"), "utf8"));

/** Written last, so a directory carrying it is one that finished. */
export const WHEELHOUSE_MANIFEST = "MANIFEST.json";

/** The sentence a visitor sees if they reach for intake in this profile. */
const UNSUPPORTED_MESSAGE =
  "intake_catalogue() is not included in the browser profile because\n" +
  "intake-esm's dependency set is incompatible with this Pyodide runtime.\n" +
  "Use the standard Freva Python environment for this feature.";

/** Upstream's own LazyModule, with one branch added for the two modules this profile omits. */
const LAZY_OVERLAY = `"""Lazy load 'slow' deps.

BROWSER OVERLAY - built by @freva-org/browser-python's prepare-freva-wheelhouse command.

Upstream file: freva_client/utils/lazy.py
Change:        \`intake\` and \`intake_esm\` raise a specific, actionable message instead of a generic
               "Optional dependency ... is required for this feature."
Why:           this profile deliberately does not ship intake-esm (its polars pin conflicts with the
               polars the runtime ships), so the failure is expected and should read as a decision
               rather than as a broken install.
Remove when:   upstream makes intake_esm an optional dependency; then no overlay is needed at all.
"""

from importlib import import_module as _mod
from types import ModuleType
from typing import Generic, Optional, TypeVar

LazyType = TypeVar("LazyType", bound=ModuleType)

_BROWSER_UNSUPPORTED = {
    "intake": ${JSON.stringify(UNSUPPORTED_MESSAGE)},
    "intake_esm": ${JSON.stringify(UNSUPPORTED_MESSAGE)},
}


class LazyModule(Generic[LazyType]):
    def __init__(self, module_name: str):
        self._module_name = module_name
        self._module: Optional[LazyType] = None

    def _load(self) -> LazyType:
        if self._module is None:
            unsupported = _BROWSER_UNSUPPORTED.get(self._module_name)
            if unsupported is not None:
                raise NotImplementedError(unsupported)
            try:
                self._module = _mod(self._module_name)  # type: ignore[assignment]
            except ImportError as error:
                raise ImportError(
                    f"Optional dependency '{self._module_name}' is "
                    "required for this feature."
                ) from error
        return self._module

    def __getattr__(self, item: str):
        return getattr(self._load(), item)


intake = LazyModule("intake")
intake_esm = LazyModule("intake_esm")
pd = LazyModule("pandas")
xr = LazyModule("xarray")
`;

const OVERLAYS = { "freva_client/utils/lazy.py": Buffer.from(LAZY_OVERLAY, "utf8") };

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** `sha256=<urlsafe base64, unpadded>`, which is what a wheel's RECORD carries. */
const recordDigest = (buffer) =>
  `sha256=${createHash("sha256").update(buffer).digest("base64url").replace(/=+$/, "")}`;

/** A requirement name as PEP 503 compares them: case-folded, runs of `-_.` collapsed to `-`. */
const canonical = (name) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, "-");

/**
 * Move `Requires-Dist: intake_esm` under an extra, pin the requirements in `runtimePins`, and
 * stamp the local version. Refuses if the unconditional intake requirement is not there: that is
 * the REMOVAL CONDITION for this transformation, and a build that silently did nothing would hide
 * the day it arrived. Refuses too if a pinned name is not a requirement at all, or already
 * carries a specifier - either means upstream's requirements moved under a pin written for the
 * shape they used to have.
 */
export function rewriteMetadata(text, version, browserVersion, pins = {}, transitivePins = {}) {
  const out = [];
  let sawRequirement = false;
  const wanted = new Map(Object.entries(pins).map(([name, v]) => [canonical(name), v]));
  const pinned = new Set();
  for (const line of text.split("\n")) {
    if (line.trim() === `Version: ${version}`) {
      out.push(`Version: ${browserVersion}`);
      continue;
    }
    if (/^Requires-Dist:\s*intake[-_]esm\s*$/.test(line)) {
      out.push("Requires-Dist: intake_esm ; extra == 'intake'");
      sawRequirement = true;
      continue;
    }
    // Only a BARE requirement is pinned: one that already carries a specifier or a marker is
    // upstream saying something this transformation is not entitled to overwrite.
    const bare = /^Requires-Dist:\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/.exec(line);
    if (bare && wanted.has(canonical(bare[1]))) {
      const key = canonical(bare[1]);
      out.push(`Requires-Dist: ${bare[1]}==${wanted.get(key)}`);
      pinned.add(key);
      continue;
    }
    out.push(line);
  }
  const unpinned = [...wanted.keys()].filter((name) => !pinned.has(name));
  if (unpinned.length > 0) {
    throw new Error(
      `runtimePins names ${unpinned.join(", ")}, which the upstream METADATA does not carry as a ` +
        `bare requirement. Upstream's requirements have moved; re-read them before re-pinning.`,
    );
  }
  // TRANSITIVE PINS, added as requirements upstream does not declare. A dependency of a
  // dependency is not in this METADATA, so there is no line to rewrite - and left unpinned the
  // resolver takes whatever is newest, so two deployments built a month apart get different
  // interpreters from the same digest. Declaring them here constrains the resolution without
  // mirroring a single wheel. Refused if upstream already declares one: that is upstream's line
  // to own, and `runtimePins` is where it would then belong.
  for (const name of Object.keys(transitivePins)) {
    const already = out.some((line) => {
      const bare = /^Requires-Dist:\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
      return bare ? canonical(bare[1]) === canonical(name) : false;
    });
    if (already) {
      throw new Error(
        `transitivePins names ${name}, which the upstream METADATA now declares itself. Move it ` +
          `to runtimePins, where an existing requirement is pinned rather than added.`,
      );
    }
  }
  const lastRequirement = out.map((line) => line.startsWith("Requires-Dist:")).lastIndexOf(true);
  const added = Object.entries(transitivePins).map(([name, v]) => `Requires-Dist: ${name}==${v}`);
  if (added.length > 0) out.splice(lastRequirement + 1, 0, ...added);
  if (!sawRequirement) {
    throw new Error(
      "The upstream METADATA no longer carries an unconditional `Requires-Dist: intake_esm`.\n" +
        "That is the removal condition for this transformation: the published wheel can now be\n" +
        "served unmodified, and the derived wheel should be deleted rather than rebuilt.",
    );
  }
  const extraAt = out.findIndex((line) => line.startsWith("Provides-Extra:"));
  if (extraAt >= 0) out.splice(extraAt, 0, "Provides-Extra: intake");
  else out.push("Provides-Extra: intake");
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * Build the browser wheel from an upstream wheel's bytes. Deterministic: same input, same output.
 */
export function buildBrowserWheel(
  sourceBytes,
  { version, localVersion, runtimePins = {}, transitivePins = {} },
) {
  const entries = readZip(sourceBytes);
  const distInfo = entries
    .map((entry) => entry.name)
    .find((name) => name.endsWith(".dist-info/METADATA"))
    ?.replace(/\/METADATA$/, "");
  if (!distInfo) throw new Error("the source wheel has no .dist-info/METADATA");
  const [name] = distInfo.replace(/\.dist-info$/, "").split(/-(?=[^-]*$)/);
  const browserVersion = `${version}+${localVersion}`;
  const newDistInfo = `${name}-${browserVersion}.dist-info`;

  const built = [];
  const applied = new Set();
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.endsWith("/")) continue;
    if (entry.name === `${distInfo}/RECORD`) continue; // rebuilt below
    const target = entry.name.replace(distInfo, newDistInfo);
    let data = entry.data;
    if (entry.name === `${distInfo}/METADATA`) {
      data = Buffer.from(
        rewriteMetadata(
          data.toString("utf8"),
          version,
          browserVersion,
          runtimePins,
          transitivePins,
        ),
        "utf8",
      );
    } else if (OVERLAYS[entry.name]) {
      data = OVERLAYS[entry.name];
      applied.add(entry.name);
    }
    built.push({ name: target, data });
  }
  const expected = Object.keys(OVERLAYS);
  if (applied.size !== expected.length) {
    throw new Error(
      `Overlay target(s) missing from the wheel: ${expected.filter((n) => !applied.has(n)).join(", ")}.\n` +
        "Upstream moved or renamed the file; the overlay must be re-pointed, not silently skipped.",
    );
  }

  const record = built
    .map(({ name: target, data }) => `${target},${recordDigest(data)},${data.length}`)
    .concat(`${newDistInfo}/RECORD,,`)
    .join("\n");
  built.push({ name: `${newDistInfo}/RECORD`, data: Buffer.from(`${record}\n`, "utf8") });

  return { file: `${name}-${browserVersion}-py3-none-any.whl`, bytes: writeZip(built) };
}

/** A plain file name in this directory: no separators, no traversal, no absolute path. */
const isPlainName = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("/") &&
  !value.includes("\\") &&
  value !== "." &&
  value !== ".." &&
  !/^[a-zA-Z]:/.test(value);

const isDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/**
 * The plan: exactly which wheels, in which order, with which digests. Derived from
 * `freva-wheelhouse.json`, which ships with the package, and authoritative over the manifest in
 * the directory being checked, which is written by whatever last prepared it.
 */
export function plannedWheelhouse() {
  return [
    {
      file: PINS.frevaClient.derived.file,
      sha256: PINS.frevaClient.derived.sha256,
      name: "freva-client",
      version: `${PINS.frevaClient.version}+${PINS.frevaClient.localVersion}`,
      derivedFrom: PINS.frevaClient.source.file,
    },
  ];
}

/**
 * Everything wrong with a prepared wheelhouse, as sentences.
 *
 * CHECKED AGAINST THE PLAN, not against the manifest found in the directory. Confirming that each
 * file the local manifest lists hashes to the digest that same manifest records is
 * self-consistency, which is what a wrong directory has: a directory holding one `unexpected.whl`
 * with a manifest describing it would verify. The manifest is still read, but as evidence about
 * provenance rather than authority over contents.
 *
 * `plan` defaults to the shipped one and exists so the unit tests can describe a synthetic wheel:
 * no real or derived production wheel is committed to this repository, so a test that needed the
 * pinned bytes to be on disk could not run at all.
 */
export function verifyWheelhouse(dir, plan = plannedWheelhouse()) {
  const problems = [];
  const planned = new Map(plan.map((wheel) => [wheel.file, wheel]));

  // the bytes, against the plan
  for (const wheel of plan) {
    const path = join(dir, wheel.file);
    if (!existsSync(path)) {
      problems.push(`${wheel.file} is part of the pinned wheelhouse and is not on disk.`);
      continue;
    }
    const actual = sha256(readFileSync(path));
    if (!isDigest(wheel.sha256)) {
      problems.push(
        `${wheel.file} has no pinned digest in freva-wheelhouse.json, so it cannot be verified. ` +
          `A derived wheel needs its digest recorded before it can be shipped.`,
      );
      continue;
    }
    if (actual !== wheel.sha256) {
      problems.push(
        `${wheel.file} does not match the digest this package pins ` +
          `(${wheel.sha256.slice(0, 12)}… != ${actual.slice(0, 12)}…).`,
      );
    }
  }

  // THE DIRECTORY ITSELF, which neither the plan nor the manifest describes. A wheel on disk
  // that nobody declared is served by the same static host as the one that was: a stale build's
  // leftover sits beside the current wheel, is reachable at a URL, and is invisible to a check
  // that only walks the plan and the manifest. Reading the directory is the only way to say
  // "this is the wheelhouse" rather than "the wheelhouse is in here somewhere".
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".whl") || planned.has(file)) continue;
    problems.push(
      `${file} is in the directory and is not part of the pinned wheelhouse. A wheel nobody ` +
        `declared is still served; remove it, or prepare this directory again from scratch.`,
    );
  }

  // the manifest, which describes what is there
  const manifestPath = join(dir, WHEELHOUSE_MANIFEST);
  if (!existsSync(manifestPath)) {
    problems.push(`${WHEELHOUSE_MANIFEST} is missing, so this directory was never finished.`);
    return problems;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    problems.push(`${WHEELHOUSE_MANIFEST} is not valid JSON.`);
    return problems;
  }

  const listed = Array.isArray(manifest.wheels) ? manifest.wheels : [];
  if (listed.length === 0) problems.push("the manifest lists no wheels at all.");
  const seen = new Set();
  for (const wheel of listed) {
    if (!wheel || typeof wheel !== "object" || !isPlainName(wheel.file)) {
      problems.push(
        `the manifest lists ${JSON.stringify(wheel?.file ?? wheel).slice(0, 60)}, which is not a ` +
          `plain file name in this directory. A traversal or absolute path is not something to ` +
          `follow.`,
      );
      continue;
    }
    if (seen.has(wheel.file)) {
      problems.push(`the manifest lists ${wheel.file} twice.`);
      continue;
    }
    seen.add(wheel.file);
    const expected = planned.get(wheel.file);
    if (!expected) {
      problems.push(
        `the manifest lists ${wheel.file}, which is not part of the pinned wheelhouse. This ` +
          `directory holds something the profile does not install.`,
      );
      continue;
    }
    if (wheel.sha256 !== expected.sha256) {
      problems.push(
        `the manifest records a different digest for ${wheel.file} than this package pins.`,
      );
    }
    if (expected.derivedFrom && wheel.derivedFrom !== expected.derivedFrom) {
      problems.push(
        `${wheel.file} is recorded as derived from ${String(wheel.derivedFrom)}, but this ` +
          `package builds it from ${expected.derivedFrom}.`,
      );
    }
  }
  for (const wheel of plan) {
    if (!seen.has(wheel.file)) {
      problems.push(`the manifest does not mention ${wheel.file}, which the profile installs.`);
    }
  }

  return problems;
}

/** The one wheel the profile installs. */
export function plannedWheels() {
  return [
    `freva_client-${PINS.frevaClient.version}+${PINS.frevaClient.localVersion}-py3-none-any.whl`,
  ];
}

async function fetchPinned(pin) {
  const response = await fetch(pin.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${pin.url} responded ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== pin.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${pin.file}\n  expected  ${pin.sha256}\n  got       ${digest}\n\n` +
        "The artifact was not written. This is a mirror, a re-cut release or a truncated download.",
    );
  }
  return bytes;
}

export async function prepareFrevaWheelhouse(args, { fail, log = console.log }) {
  const out = typeof args.out === "string" ? resolve(args.out) : "";
  if (!out) {
    fail("--out is required: the directory to serve as /freva-wheels/.");
    return;
  }

  // a warm, verified cache
  if (!args.force && existsSync(join(out, WHEELHOUSE_MANIFEST))) {
    const problems = verifyWheelhouse(out);
    if (problems.length === 0) {
      // The count comes from what was VERIFIED, so it cannot announce six wheels over one.
      log(`The Freva wheelhouse in ${out} is already prepared and verified.`);
      log(`  ${plannedWheelhouse().length} wheels verified against the pinned plan`);
      return;
    }
    log(`The wheelhouse in ${out} did not verify, so it is being rebuilt:`);
    for (const problem of problems.slice(0, 5)) log(`  - ${problem}`);
  }

  const staging = `${out}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    const wheels = [];
    const sources = [];

    log(`  fetching ${PINS.frevaClient.source.file}`);
    const sourceBytes = await fetchPinned(PINS.frevaClient.source);
    sources.push({
      file: PINS.frevaClient.source.file,
      url: PINS.frevaClient.source.url,
      sha256: PINS.frevaClient.source.sha256,
      origin: "upstream",
    });

    const derived = buildBrowserWheel(sourceBytes, {
      version: PINS.frevaClient.version,
      localVersion: PINS.frevaClient.localVersion,
      runtimePins: PINS.frevaClient.runtimePins ?? {},
      transitivePins: PINS.frevaClient.transitivePins ?? {},
    });
    const derivedDigest = sha256(derived.bytes);
    // NO BYPASS. A switch that let a run whose derived wheel did not match the pinned digest
    // write it anyway would remove the one check standing between "the transformation or its
    // input changed" and "a wheelhouse that verifies". Re-recording a digest is a deliberate edit
    // to `freva-wheelhouse.json`, made by someone who has looked at why it moved.
    const recorded = PINS.frevaClient.derived.sha256;
    if (!recorded) {
      throw new Error(
        "bin/freva-wheelhouse.json records no digest for the derived freva-client wheel, so a " +
          "consumer could not tell whether the wheel they are serving is the one this version " +
          "builds. Record it before shipping.",
      );
    }
    if (recorded !== derivedDigest) {
      throw new Error(
        `The derived wheel does not match its recorded digest.\n` +
          `  expected  ${recorded}\n  got       ${derivedDigest}\n\n` +
          `The transformation or its input has changed. If that was intended, re-record the digest\n` +
          `in bin/freva-wheelhouse.json; if it was not, this is the check doing its job.`,
      );
    }
    writeFileSync(join(staging, derived.file), derived.bytes);
    wheels.push({
      file: derived.file,
      sha256: derivedDigest,
      name: "freva-client",
      version: `${PINS.frevaClient.version}+${PINS.frevaClient.localVersion}`,
      derivedFrom: PINS.frevaClient.source.file,
    });

    writeFileSync(
      join(staging, WHEELHOUSE_MANIFEST),
      `${JSON.stringify(
        {
          preparedBy: "@freva-org/browser-python prepare-freva-wheelhouse",
          preparedAt: new Date().toISOString(),
          wheels,
          sources,
          derivation: {
            file: derived.file,
            from: PINS.frevaClient.source.file,
            changes: [
              "Requires-Dist: intake_esm moved under `extra == 'intake'`",
              ...Object.entries(PINS.frevaClient.runtimePins ?? {}).map(
                ([name, version]) => `Requires-Dist: ${name} pinned to ==${version}`,
              ),
              ...Object.entries(PINS.frevaClient.transitivePins ?? {}).map(
                ([name, version]) => `Requires-Dist: ${name}==${version} added to pin a transitive`,
              ),
              `Version: ${PINS.frevaClient.version} -> ${PINS.frevaClient.version}+${PINS.frevaClient.localVersion}`,
              "freva_client/utils/lazy.py overlaid so intake raises a documented message",
            ],
            removeWhen:
              "upstream freva-client makes intake_esm an optional dependency rather than a " +
              "hard requirement; then serve the published wheel unmodified.",
          },
        },
        null,
        2,
      )}\n`,
    );

    const problems = verifyWheelhouse(staging);
    if (problems.length > 0) {
      throw new Error(`The wheelhouse did not verify:\n  - ${problems.join("\n  - ")}`);
    }

    const previous = `${out}.previous-${process.pid}`;
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(out)) renameSync(out, previous);
    try {
      renameSync(staging, out);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, out);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });

    log(`\nPrepared ${readdirSync(out).filter((f) => f.endsWith(".whl")).length} wheels in ${out}`);
    log(`  derived ${derived.file}`);
    log(`  sha256  ${derivedDigest}`);
    log(`\nServe this directory as static files and pass it as wheelhouseURL:\n\n  ${out}\n`);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    fail(`${error.message}\n\nNothing was written to ${out}.`);
  }
}
