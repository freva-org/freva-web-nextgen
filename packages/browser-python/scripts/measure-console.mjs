/**
 * What a consumer's bundle actually grows by, per entry point. `check-bytes.mjs` measures the files
 * this package EMITS, which is right for the headless engine and wrong for the console, which
 * brings jQuery, jQuery Terminal and Prism. It also asserts the boundary that matters most:
 * bundling the ROOT entry must not pull in a single byte of jQuery, which a stray `import` in a
 * shared module would break silently.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const ESBUILD = join(PKG, "..", "..", "node_modules", ".bin", "esbuild");
// Scratch INSIDE the package, not in /tmp. Node resolution walks up from the entry file, so an
// entry in the system temp directory cannot find `jquery` at all and the measurement fails with a
// resolution error rather than a number.
const scratch = join(PKG, ".measure");
mkdirSync(scratch, { recursive: true });

/** ~100 KiB gzip was the brief's target for the console layer. Reported either way. */
const CONSOLE_TARGET = 100 * 1024;

// The CEILING, as opposed to the target: exceeding this fails. The target cannot be met while the
// surface is jQuery Terminal, which arrives with jQuery beneath it - 91.7 KiB gzipped before a line
// of this package's console code. What is not allowed is letting the number drift, as it did when
// the README said 109.9 KiB and then 114.4 KiB. The ceiling is set close to the measurement on
// purpose, so a dependency bump fails here; raising it is a deliberate edit.
const CONSOLE_CEILING = 124 * 1024;

/** The headless engine must stay small enough that importing it is never a decision. */
const ROOT_CEILING = 8 * 1024;

function bundle(name, source) {
  const entry = join(scratch, `${name}.js`);
  const out = join(scratch, `${name}.bundle.js`);
  writeFileSync(entry, source);
  execFileSync(ESBUILD, [entry, "--bundle", "--format=esm", "--minify", `--outfile=${out}`], {
    cwd: PKG,
    stdio: "pipe",
  });
  const bytes = readFileSync(out);
  return {
    raw: bytes.length,
    gz: gzipSync(bytes, { level: 9 }).length,
    text: bytes.toString("utf8"),
  };
}

const pad = (v, n) => String(v).padStart(n);
const kib = (v) => `${(v / 1024).toFixed(1)} KiB`;

try {
  const engine = bundle(
    "engine",
    `import { createBrowserPython } from "../dist/index.js";\nglobalThis.x = createBrowserPython;\n`,
  );
  const consoleOnly = bundle(
    "console",
    `import { BrowserPythonConsole } from "../dist/console/index.js";\nglobalThis.x = BrowserPythonConsole;\n`,
  );
  const jq = bundle("jq", `import jQuery from "jquery";\nglobalThis.x = jQuery;\n`);
  const jqt = bundle(
    "jqt",
    `import jQuery from "jquery";\nimport t from "jquery.terminal";\nglobalThis.x = t(globalThis, jQuery);\n`,
  );
  const prism = bundle(
    "prism",
    `import P from "prismjs/components/prism-core.js";\nimport "prismjs/components/prism-clike.js";\nimport "prismjs/components/prism-python.js";\nglobalThis.x = P;\n`,
  );

  console.log("bundled per entry point (minified, gzipped):\n");
  const rows = [
    ["root  @freva-org/browser-python", engine],
    ["console  …/console", consoleOnly],
  ];
  for (const [name, r] of rows) {
    console.log(`  ${name.padEnd(38)} ${pad(kib(r.raw), 10)}   ${pad(kib(r.gz), 10)} gz`);
  }
  console.log("\n  of which, dependencies:");
  console.log(`  ${"jquery".padEnd(38)} ${pad(kib(jq.raw), 10)}   ${pad(kib(jq.gz), 10)} gz`);
  console.log(
    `  ${"+ jquery.terminal".padEnd(38)} ${pad(kib(jqt.raw), 10)}   ${pad(kib(jqt.gz), 10)} gz`,
  );
  console.log(
    `  ${"prism core + clike + python".padEnd(38)} ${pad(kib(prism.raw), 10)}   ${pad(kib(prism.gz), 10)} gz`,
  );

  const consoleDelta = consoleOnly.gz - engine.gz;
  console.log(`\n  console layer over the headless engine: ${kib(consoleDelta)} gz`);
  console.log(`  brief's target:                        ${kib(CONSOLE_TARGET)} gz`);
  if (consoleDelta > CONSOLE_TARGET) {
    console.log(
      `\n  OVER by ${kib(consoleDelta - CONSOLE_TARGET)} gz. The dependency responsible is\n` +
        `  jquery.terminal (${kib(jqt.gz - jq.gz)} gz) with jquery (${kib(jq.gz)} gz) beneath it -\n` +
        `  together ${kib(jqt.gz)} gz, before any of this package's own console code. Reported\n` +
        `  rather than hidden; the ConsoleSurfaceAdapter seam exists so this can be replaced.`,
    );
  }

  if (consoleDelta > CONSOLE_CEILING) {
    console.log(
      `\n  OVER THE CEILING of ${kib(CONSOLE_CEILING)} gz by ${kib(consoleDelta - CONSOLE_CEILING)} gz.\n` +
        `  This fails. Either find the growth, or raise the ceiling in this file deliberately -\n` +
        `  which is a decision about somebody's page-load budget, not a formality.`,
    );
    process.exitCode = 1;
  }
  if (engine.gz > ROOT_CEILING) {
    console.log(
      `\n  The ROOT entry is ${kib(engine.gz)} gz, over its ${kib(ROOT_CEILING)} gz ceiling.\n` +
        `  Importing the engine must never be a decision a consumer has to weigh.`,
    );
    process.exitCode = 1;
  }

  // THE boundary assertion. A `$`-shaped identifier proves nothing after minification, so this
  // looks for strings jQuery embeds that nothing else would: its version, and its own error text.
  const JQUERY_FINGERPRINTS = ["jQuery.Deferred exception", "jquery", "3.7.1"];
  const leaked = JQUERY_FINGERPRINTS.filter((f) => engine.text.includes(f));
  console.log(
    `\n  root entry contains no jQuery: ${leaked.length === 0 ? "confirmed" : `FAILED (${leaked.join(", ")})`}`,
  );
  if (leaked.length > 0) process.exitCode = 1;

  // `createBrowserPython` needs one generated boolean about optional add-ons, not the Worker's
  // complete supply-chain manifest. Importing `supportsOptional` through the public catalogue once
  // pulled every wheel URL and digest into the application bundle. Keep that architectural
  // boundary explicit even while the bundle remains below its broad size ceiling.
  const WORKER_PIN_FINGERPRINTS = ["files.pythonhosted.org", "natural-earth-vector"];
  const leakedPins = WORKER_PIN_FINGERPRINTS.filter((f) => engine.text.includes(f));
  console.log(
    `  root entry contains no worker-only add-on pins: ${
      leakedPins.length === 0 ? "confirmed" : `FAILED (${leakedPins.join(", ")})`
    }`,
  );
  if (leakedPins.length > 0) process.exitCode = 1;
  // The same numbers as data, for `scripts/check-docs-sizes.mjs`. Documentation that repeats a
  // measurement has to be checked against it, and that needs the measurement in a readable form.
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          rootEntryGz: engine.gz,
          consoleEntryGz: consoleOnly.gz,
          consoleLayerGz: consoleDelta,
          jqueryGz: jq.gz,
          jqueryTerminalGz: jqt.gz,
          prismGz: prism.gz,
        },
        null,
        2,
      ),
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
