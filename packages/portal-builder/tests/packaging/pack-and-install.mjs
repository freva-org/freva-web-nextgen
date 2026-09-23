// Packaging verification against the real tarball. A `files` list in package.json is a statement
// of intent; this runs `npm pack`, installs what npm produced into a clean project outside the
// workspace, and builds a fictional consumer with it. Schemas, Astro templates or island sources
// left out of the archive show up here as a failed build rather than as a consumer's bug report.
//
// Run with `npm run test:packaging -w @freva-org/portal-builder`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = resolve(PKG, "../..");

function packResult(printed) {
  const starts = [];
  if (printed.startsWith("[")) starts.push(0);
  for (let at = printed.indexOf("\n["); at !== -1; at = printed.indexOf("\n[", at + 1))
    starts.push(at + 1);
  for (const at of starts.reverse()) {
    try {
      const parsed = JSON.parse(printed.slice(at));
      if (Array.isArray(parsed) && typeof parsed[0]?.filename === "string") return parsed[0];
    } catch {
      // Not where the JSON starts. Keep looking.
    }
  }
  throw new Error(`npm pack --json printed no packed file:\n${printed}`);
}

const results = [];
/**
 * One check, which may be asynchronous. Every caller must `await` it: an async body whose
 * rejection is not awaited records a pass and then crashes the process later with an unhandled
 * rejection, which is the worst of both.
 */
const check = async (label, fn) => {
  try {
    await fn();
    results.push({ label, ok: true });
    console.log(`  ok   ${label}`);
  } catch (error) {
    results.push({ label, ok: false });
    console.error(`  FAIL ${label}\n       ${error.message.split("\n")[0]}`);
  }
};

const scratch = mkdtempSync(join(tmpdir(), "portal-builder-pack-"));

try {
  // pack
  execFileSync("npm", ["run", "build"], { cwd: PKG, stdio: "inherit" });
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], {
      cwd: PKG,
      encoding: "utf8",
    }),
  )[0];
  const tarball = join(scratch, packed.filename);
  const names = packed.files.map((f) => f.path);

  await check("the archive contains the CLI, the build engine and the schemas", () => {
    assert.ok(names.includes("bin/freva-portal-builder.mjs"), "the executable is missing");
    assert.ok(names.includes("dist/index.js"), "the build engine is missing");
    for (const schema of [
      "schema/portal.schema.json",
      "schema/landing.schema.json",
      "schema/subsite-policy.schema.json",
      "schema/portal-content-v1.profile.json",
      "schema/budgets.json",
    ]) {
      assert.ok(names.includes(schema), `${schema} is missing`);
    }
  });

  await check("the archive contains the page templates and the island sources", () => {
    assert.ok(
      names.some((n) => n === "astro/src/pages/[...route].astro"),
      "the dynamic page template is missing",
    );
    assert.ok(names.includes("astro/src/layouts/Shell.astro"), "the shell layout is missing");
    for (const sheet of [
      "astro/src/styles/freva-tokens.css",
      "astro/src/styles/freva-shell.css",
      "astro/src/styles/freva-stac.css",
    ]) {
      assert.ok(names.includes(sheet), `${sheet} is missing`);
    }
    for (const island of [
      "client/shell.ts",
      "client/components/databrowser.ts",
      "client/components/stac.ts",
      "client/components/auth.ts",
      "client/components/auth-callback.ts",
      // Both imported literally by the generated entry module, so a tarball without them builds
      // a portal that cannot mount its own footer badge or draw its own backdrop.
      "client/components/footer-badge.ts",
      "client/components/contour.ts",
      // The Cosmos island, the scene builder and the builder's declared boundary.
      "client/components/cosmos.ts",
      "client/components/cosmos/scene.js",
      "client/components/cosmos/scene.d.ts",
      "client/components/cosmos/dom.ts",
      // The dataset-tree island and the portal-side stylesheet it imports. Without the second
      // the block builds and renders unstyled - a break a file list catches and a smoke test
      // does not.
      "client/components/dataset-tree.ts",
      "client/components/dataset-tree.css",
      "client/components/dataset-tree-styles.ts",
      // The overlay transaction the maximized sheet is: without it a consumer's build has a
      // control that toggles an attribute and no sheet to show for it.
      "client/components/tree-maximize.ts",
      // Both source loaders. A consumer whose landing declares `s3:` and whose package shipped only
      // the snapshot one gets a tree that builds and cannot list anything.
      "client/components/tree-sources.ts",
      "client/components/tree-source-snapshot.ts",
      "client/components/tree-source-s3.ts",
      // The playground's two topologies and the separate-origin document's own entry. The two
      // chunk loaders make "the framed parent contains no console" a property of the emitted
      // graph, and a package missing either builds a portal that cannot decide which it is.
      "client/components/python-chunks.ts",
      "client/components/python-chunks-local.ts",
      "client/components/python-chunks-framed.ts",
      "client/playground-origin.ts",
      "client/components/python-ready.ts",
    ]) {
      assert.ok(names.includes(island), `${island} is missing`);
    }
  });

  await check("the archive carries the Cosmos sky art, and no object bodies", () => {
    const assets = names.filter((n) => n.startsWith("client/components/cosmos/scene/"));
    const webp = assets.filter((n) => n.endsWith(".webp")).sort();
    // No object bodies: the static scene draws no satellite, aircraft, vessel, sonde train or
    // buoy, so those WebP files are not shipped. An archive carrying bytes nothing can ask for
    // is an archive whose contents do not describe its behaviour. What remains is the sky's own
    // exported artwork, which the renderer names directly.
    assert.deepEqual(webp, [
      "client/components/cosmos/scene/sky/moon.webp",
      "client/components/cosmos/scene/sky/sky-sphere.webp",
      "client/components/cosmos/scene/sky/sun.webp",
    ]);
    assert.ok(
      assets.includes("client/components/cosmos/scene/sky/MANIFEST.json"),
      "the sky art manifest is missing",
    );
    // And the manifest that documents them travels with them.
    assert.ok(
      assets.includes("client/components/cosmos/scene/README.md"),
      "the asset README is missing",
    );
  });

  await check("the archive contains no test, fixture or source tree", () => {
    const unexpected = names.filter((n) => /^(tests|browser-tests|src|coverage)\//.test(n));
    assert.deepEqual(unexpected, [], `unexpected entries: ${unexpected.join(", ")}`);
  });

  await check("the archive declares its licence", () => {
    assert.ok(names.includes("LICENSE"), "LICENSE is missing");
    assert.ok(names.includes("README.md"), "README.md is missing");
  });

  // install
  //
  // The workspace dependencies are packed too: they are released together with the builder, and
  // installing the registry's older copies would test a combination that will never be published.
  //
  // This list has to hold every workspace package the builder depends on. It is not derived from
  // `package.json` on purpose - a tarball has to be *built* as well as packed, and not every
  // workspace can be - at the cost that adding a dependency and forgetting this line sends the
  // install to the public registry for a package that was never published, and it fails on a 404.
  const dependencyTarballs = [
    "freva-client-terminal",
    "databrowser",
    "ts-oidc-auth-client",
    "freva-badge",
    // Carried by the dataset-tree landing block, at a prerelease version the registry has never
    // published: leaving it out sends the install to the registry for a 404.
    "dataset-tree",
    // The interpreter behind the block's Python playground, on the same terms.
    "browser-python",
  ].map((name) => {
    const dir = join(REPO, "packages", name);
    execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "inherit" });
    // `npm pack --json` prints JSON, and a `prepack` script prints whatever it likes FIRST.
    // Every package here builds in `prepack`, and browser-python also runs its size gate, which
    // reports a table. Feeding all of that to `JSON.parse` fails with `Unexpected token 'p'`,
    // which names nothing and reads like a corrupt tarball.
    const printed = execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], {
      cwd: dir,
      encoding: "utf8",
    });
    const result = packResult(printed);
    return join(scratch, result.filename);
  });

  const project = join(scratch, "consumer");
  const source = join(project, "site");
  cpSync(join(REPO, "examples", "minimal-portal"), source, { recursive: true });
  execFileSync("npm", ["init", "-y"], { cwd: project, stdio: "ignore" });
  execFileSync("npm", ["install", "--no-audit", "--no-fund", ...dependencyTarballs, tarball], {
    cwd: project,
    stdio: "inherit",
  });

  await check("the installed package exposes its executable", () => {
    assert.ok(existsSync(join(project, "node_modules", ".bin", "freva-portal-builder")));
  });

  await check("the installed package builds a fictional consumer end to end", () => {
    const out = join(project, "build", "portal");
    execFileSync(
      join(project, "node_modules", ".bin", "freva-portal-builder"),
      [
        "build",
        "--source-root",
        source,
        "--config",
        join(source, "portal.yaml"),
        "--out",
        out,
        "--quiet",
      ],
      { cwd: project, stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
    );
    for (const file of [
      "index.html",
      "docs/guide/index.html",
      "portal-manifest.json",
      "checksums.sha256",
    ]) {
      assert.ok(existsSync(join(out, ...file.split("/"))), `${file} was not produced`);
    }
    const html = readFileSync(join(out, "index.html"), "utf8");
    assert.ok(html.includes("A portal with nothing switched on"), "the landing did not render");
  });

  // The dataset-tree block, built by an installed package from outside the checkout: the only
  // place the whole path is exercised as a consumer sees it. The schema in the tarball accepts
  // the block, the island in the tarball is imported, and the component comes from the
  // *installed* `@freva-org/dataset-tree` rather than the workspace symlink every other test in
  // the repository resolves through.
  await check("the installed package builds a consumer that uses the dataset-tree block", () => {
    writeFileSync(
      join(source, "archive.json"),
      JSON.stringify({
        schemaVersion: 1,
        roots: [
          {
            id: "cmip6",
            kind: "collection",
            name: "CMIP6",
            children: [{ id: "cmip6/tas", kind: "dataset", name: "tas", size: 1024 }],
          },
        ],
      }),
    );
    const landing = join(source, "landings", "home.yaml");
    writeFileSync(
      landing,
      `${readFileSync(landing, "utf8").trimEnd()}\n  - type: dataset-tree\n    catalog: ../archive.json\n    heading: Browse the archive\n`,
    );
    const out = join(project, "build", "portal-tree");
    execFileSync(
      join(project, "node_modules", ".bin", "freva-portal-builder"),
      [
        "build",
        "--source-root",
        source,
        "--config",
        join(source, "portal.yaml"),
        "--out",
        out,
        "--quiet",
      ],
      { cwd: project, stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
    );
    const html = readFileSync(join(out, "index.html"), "utf8");
    assert.ok(html.includes("data-portal-dataset-tree"), "the block did not render");
    assert.ok(html.includes("application/json"), "the catalogue was not embedded");
    const bundled = readdirSync(join(out, "_portal"))
      .filter((f) => f.endsWith(".js") || f.endsWith(".css"))
      .map((f) => readFileSync(join(out, "_portal", f), "utf8"))
      .join("\n");
    // Fingerprints taken from the SHIPPED strings: the filter's placeholder and a class in its
    // markup, both of which the component emits. A remembered label the component has stopped
    // saying turns this into a proof that the component is absent.
    assert.ok(bundled.includes("Filter datasets and paths"), "the component was not bundled");
    assert.ok(bundled.includes("dataset-tree__row"), "the component's markup was not bundled");
    assert.ok(bundled.includes("dataset-tree__row"), "the component stylesheet was not bundled");
    assert.ok(!bundled.includes("list-type=2"), "the S3 adapter reached a snapshot-mode portal");
  });

  await check("the consumer got THESE workspace versions, not the registry's older copies", () => {
    // The failure this exists for is quiet and expensive: npm resolves
    // `@freva-org/browser-python` from the public registry because the workspace copy was never
    // packed, and the build fails on an export that release does not have - or worse, succeeds
    // against an older protocol. The install above packs every workspace dependency; this checks
    // that the packed one is what landed.
    for (const name of [
      "browser-python",
      "dataset-tree",
      "freva-client-terminal",
      "databrowser",
      "ts-oidc-auth-client",
      "freva-badge",
    ]) {
      const workspace = JSON.parse(
        readFileSync(join(REPO, "packages", name, "package.json"), "utf8"),
      );
      const installed = JSON.parse(
        readFileSync(join(project, "node_modules", "@freva-org", name, "package.json"), "utf8"),
      );
      assert.equal(
        installed.version,
        workspace.version,
        `@freva-org/${name}: the consumer has ${installed.version}, the workspace is ${workspace.version}`,
      );
    }
  });

  await check(
    "the installed dependencies export what this release of the builder imports",
    async () => {
      // Named imports resolved from the CONSUMER's `node_modules`, not the workspace symlink. A
      // missing export is the exact shape of "an old registry package with the right version
      // range", and it fails here as a name rather than three layers down as `undefined is not a
      // function` inside a bundled chunk.
      const from = (specifier) =>
        import(pathToFileURL(join(project, "node_modules", "@freva-org", specifier)).href);
      const embed = await from("browser-python/dist/embed/index.js");
      for (const name of [
        "attachPlaygroundBridge",
        "createPlaygroundHost",
        "createExampleRegistry",
        "parseExampleManifest",
        "verifyExampleManifest",
        "saveFilePickerSink",
        "isBridgeOp",
        "boundTranscript",
        "MAX_TRANSCRIPT_CHARS",
        "EMBED_PROTOCOL_VERSION",
      ]) {
        assert.ok(name in embed, `@freva-org/browser-python/embed does not export ${name}`);
      }
      assert.equal(
        embed.EMBED_PROTOCOL_VERSION,
        3,
        "the installed embed protocol is not version 3",
      );

      const terminal = await from("freva-client-terminal/dist/index.js");
      for (const name of ["createTerminalWindow", "createTerminal", "TERM_THEMES"]) {
        assert.ok(name in terminal, `@freva-org/freva-client-terminal does not export ${name}`);
      }

      const tree = await from("dataset-tree/dist/index.js");
      assert.ok(
        "mountDatasetTree" in tree,
        "@freva-org/dataset-tree does not export mountDatasetTree",
      );
      const snapshot = await from("dataset-tree/dist/snapshot.js");
      for (const name of ["createSnapshotSource", "parseDatasetTreeCatalogV1"]) {
        assert.ok(name in snapshot, `@freva-org/dataset-tree/snapshot does not export ${name}`);
      }
    },
  );

  await check("the installed package builds a separate-origin playground artifact", () => {
    // The whole two-origin feature from a packed builder: the child document, its manifest and
    // the deployment list. A consumer that installs the tarball and configures a
    // `playgroundOrigin` must get all three without anything from this checkout.
    const landing = join(source, "landings", "home.yaml");
    const text = readFileSync(landing, "utf8");
    writeFileSync(
      landing,
      `${text.trimEnd()}\n    python:\n      enabled: true\n      profile: minimal\n      autostart: never\n      maxSessions: 2\n      playgroundOrigin: https://play.example.org\n      terminal:\n        style: freva-client-terminal\n        osControls: auto\n        alwaysOnTop: true\n        rememberAppearance: true\n`,
    );
    const out = join(project, "build", "portal-playground");
    execFileSync(
      join(project, "node_modules", ".bin", "freva-portal-builder"),
      [
        "build",
        "--source-root",
        source,
        "--config",
        join(source, "portal.yaml"),
        "--out",
        out,
        "--quiet",
      ],
      { cwd: project, stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
    );
    const child = readFileSync(join(out, "playground-origin", "index.html"), "utf8");
    assert.ok(child.includes("playground-examples"), "the child carries no example manifest");
    const deployment = JSON.parse(
      readFileSync(join(out, "playground-origin", "deploy.json"), "utf8"),
    );
    assert.equal(deployment.origin, "https://play.example.org");
    assert.ok(
      deployment.files.some((f) => f.includes("browser-python.worker")),
      "the deployment list omits the interpreter's Worker",
    );
    for (const file of deployment.files) {
      assert.ok(existsSync(join(out, ...file.split("/"))), `${file} is listed and missing`);
    }
  });

  await check("the installed package verifies its own artifact", () => {
    execFileSync(
      join(project, "node_modules", ".bin", "freva-portal-builder"),
      ["verify", "--dir", join(project, "build", "portal")],
      { cwd: project, stdio: "inherit" },
    );
  });

  await check("the archive contains the supported documentation", () => {
    // The playground recipe is the supported way to test consumer sources, so a package that
    // advertises it and does not ship it is advertising nothing.
    for (const doc of ["docs/consumer-guide.md", "docs/external-consumer-playground.md"]) {
      assert.ok(names.includes(doc), `${doc} is missing from the package`);
    }
  });

  await check("every packaged script's target is packaged too", () => {
    // A published package.json that names a file it does not ship advertises a command nobody
    // can run. Repository-only lifecycle scripts are exempt by name, in a short explicit list
    // rather than a pattern.
    const REPOSITORY_ONLY = new Set([
      "build",
      "prepack",
      "typecheck",
      "lint",
      "pretest",
      "test",
      "test:coverage",
      "test:browser",
      "test:browser:strict",
      "test:browser:python",
      // The two dataset-tree browser suites. A new browser suite has to be admitted by name, and
      // fails the packaging gate until it is: a pattern would also admit a published command
      // pointing at a file nobody ships.
      "test:browser:tree",
      "test:browser:tree:s3",
      "test:browser:runnable",
      "test:browser:terminal",
      // The generated policy against the freva-client profile, with a real interpreter behind a
      // real header. Not strict and not in the default gate: it needs a prepared Pyodide runtime
      // and a public package index, and skips when it has neither.
      "test:browser:package-index",
      "test:security",
      "test:packaging",
      "cosmos:acceptance",
    ]);
    const manifest = JSON.parse(
      readFileSync(
        join(project, "node_modules", "@freva-org", "portal-builder", "package.json"),
        "utf8",
      ),
    );
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      if (REPOSITORY_ONLY.has(name)) continue;
      for (const token of String(command).split(/\s+/)) {
        if (!/^[a-zA-Z0-9_./-]+\.(mjs|js|cjs|ts)$/.test(token)) continue;
        assert.ok(
          names.includes(token),
          `script '${name}' runs '${token}', which the package does not contain`,
        );
      }
    }
  });

  await check(
    "the installed smoke command builds an external consumer from outside the checkout",
    () => {
      // Run from a scratch directory with the framework checkout nowhere in sight: this is what
      // a consumer has after `npm install`.
      const smoke = join(scratch, "smoke");
      const external = join(smoke, "external");
      cpSync(join(REPO, "examples", "minimal-portal"), external, { recursive: true });
      const result = join(smoke, "smoke.json");
      execFileSync(
        join(project, "node_modules", ".bin", "freva-portal-builder"),
        [
          "smoke",
          "--stage",
          join(smoke, "stage"),
          "--copy",
          `${external}=site`,
          "--config",
          "site/portal.yaml",
          "--out",
          join(smoke, "out"),
          "--result",
          result,
        ],
        { cwd: smoke, stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
      );
      const parsed = JSON.parse(readFileSync(result, "utf8"));
      assert.equal(parsed.result, "pass", `smoke result was ${parsed.result}`);
      assert.deepEqual(parsed.failedChecks, []);
      assert.ok(/^sha256:[0-9a-f]{64}$/.test(parsed.inputManifestDigest ?? ""));
      assert.ok(existsSync(join(smoke, "out", "index.html")));
    },
  );

  await check("the installed smoke command fails when an input cannot be staged", () => {
    const smoke = join(scratch, "smoke-refused");
    const external = join(smoke, "external");
    cpSync(join(REPO, "examples", "minimal-portal"), external, { recursive: true });
    symlinkSync("/etc/hosts", join(external, "sneaky.txt"));
    const result = join(smoke, "smoke.json");
    let status = 0;
    try {
      execFileSync(
        join(project, "node_modules", ".bin", "freva-portal-builder"),
        [
          "smoke",
          "--stage",
          join(smoke, "stage"),
          "--copy",
          `${external}=site`,
          "--config",
          "site/portal.yaml",
          "--out",
          join(smoke, "out"),
          "--result",
          result,
        ],
        { cwd: smoke, stdio: "pipe", env: { ...process.env, SOURCE_DATE_EPOCH: "1760000000" } },
      );
    } catch (error) {
      status = error.status ?? 1;
    }
    assert.notEqual(status, 0, "a refused input must not exit zero");
    const parsed = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(parsed.result, "fail");
    assert.ok(parsed.failedChecks.includes("staging"));
  });

  await check("the published schemas are importable by their documented subpaths", () => {
    const schemaDir = join(project, "node_modules", "@freva-org", "portal-builder", "schema");
    const files = readdirSync(schemaDir);
    assert.ok(files.includes("portal.schema.json"));
    const schema = JSON.parse(readFileSync(join(schemaDir, "portal.schema.json"), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n[packaging] ${results.length - failed}/${results.length} passed`);
process.exit(failed > 0 ? 1 : 0);
