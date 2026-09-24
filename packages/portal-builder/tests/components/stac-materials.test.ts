// Prepared STAC materials and the adapter's option surface. Two separate claims.
//
// The prepared tree is *verified*, not merely read. It reaches a consumer build from a container
// image, an environment variable or a sibling workspace, and the build copies it verbatim into a
// published artifact, so a manifest that lies - or a tree that has grown a file, a symlink or a
// traversal since it was prepared - has to stop the build rather than steer it.
//
// And the adapter's mapping from closed portal options to upstream configuration is stable and
// reviewed. The fixtures pin what three shapes of configuration produce, and the contract test
// makes an upstream upgrade re-state its reviewed option list instead of inheriting it.

import { createHash } from "node:crypto";
import { STAC_MATERIALS } from "../helpers/site.js";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import {
  MANIFEST_NAME,
  loadStacMaterials,
  treeDigestOf,
  verifyMaterials,
  type StacMaterialsManifest,
} from "../../src/components/stac-browser/materials.js";
import { generateAdapterModule } from "../../src/components/stac-browser/adapter.js";
import type { StacAdapterInput } from "../../src/components/stac-browser/adapter.js";
import { PACKAGE_ROOT } from "../../src/util/package.js";

afterAll(cleanupFixtures);

const REPOSITORY_ROOT = join(PACKAGE_ROOT, "..", "..");

const digest = (bytes: string | Buffer): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

interface TreeSpec {
  [path: string]: string;
}

/**
 * Write a small but structurally complete materials tree, then let each test damage exactly one
 * thing. Deriving the manifest from the files means a test that damages a file tests detection
 * rather than an arranged mismatch.
 */
function prepared(files: TreeSpec, patch: (m: StacMaterialsManifest) => void = () => {}): string {
  const root = tempRoot("portal-stac-materials-");
  const entries: StacMaterialsManifest["files"] = [];
  for (const path of Object.keys(files).sort()) {
    const absolute = join(root, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, files[path]!);
    entries.push({
      path,
      digest: digest(files[path]!),
      bytes: Buffer.byteLength(files[path]!),
    });
  }
  const manifest: StacMaterialsManifest = {
    schemaVersion: 1,
    kind: "stac-browser-materials",
    upstream: {
      repository: "https://github.com/radiantearth/stac-browser.git",
      tag: "v5.0.0",
      commit: "ae1956e8cb2067ce27938b3ae70c00515ac0ff33",
    },
    patches: [{ name: "0001-mount-into-the-portal-host-element.patch", digest: digest("patch") }],
    entry: "assets/index.js",
    styles: ["assets/index.css"],
    mountId: "stac-browser-mount",
    files: entries,
    treeDigest: treeDigestOf(entries),
    producer: "test",
  };
  patch(manifest);
  writeFileSync(join(root, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

const SOUND: TreeSpec = {
  "assets/index.js": "export const ok = 1;\n",
  "assets/index.css": ":root { color: inherit; }\n",
  "LICENSES/stac-browser-ISC.txt": "ISC\n",
};

function load(root: string) {
  const previous = process.env.FREVA_PORTAL_STAC_MATERIALS;
  process.env.FREVA_PORTAL_STAC_MATERIALS = root;
  try {
    return loadStacMaterials();
  } finally {
    if (previous === undefined) delete process.env.FREVA_PORTAL_STAC_MATERIALS;
    else process.env.FREVA_PORTAL_STAC_MATERIALS = previous;
  }
}

function findings(root: string): string[] {
  const loaded = load(root);
  if (!loaded.materials) return loaded.diagnostics.map((d) => d.message);
  return verifyMaterials(loaded.materials).map((d) => d.message);
}

describe("the prepared materials manifest", () => {
  it("accepts a sound tree with no findings", () => {
    expect(findings(prepared(SOUND))).toEqual([]);
  });

  it("is validated against a closed schema, so an unknown field is refused", () => {
    const root = prepared(SOUND, (m) => {
      (m as unknown as Record<string, unknown>).runtimeConfig = "./runtime-config.js";
    });
    const loaded = load(root);
    expect(loaded.materials).toBeUndefined();
    expect(loaded.diagnostics.map((d) => d.code)).toContain("FP1604");
  });

  it.each([
    ["an absolute path", "/etc/passwd"],
    ["a traversal", "../outside.js"],
    ["an interior traversal", "assets/../../outside.js"],
    ["a backslash", "assets\\index.js"],
    ["a percent-encoded separator", "assets%2findex.js"],
    ["a trailing slash", "assets/"],
    ["an empty segment", "assets//index.js"],
  ])("refuses %s in the file list", (_name, path) => {
    const root = prepared(SOUND, (m) => {
      m.files = [...m.files, { path, digest: digest("x"), bytes: 1 }];
    });
    const loaded = load(root);
    expect(loaded.materials).toBeUndefined();
    expect(loaded.diagnostics.length).toBeGreaterThan(0);
  });

  it("refuses a manifest that is not valid JSON", () => {
    const root = prepared(SOUND);
    writeFileSync(join(root, MANIFEST_NAME), "{ not json\n");
    const loaded = load(root);
    expect(loaded.materials).toBeUndefined();
    expect(loaded.diagnostics[0]!.message).toContain("not valid JSON");
  });

  // There is no search path: a build consumes the directory it is given. Falling back through an
  // override, a well-known path in the builder image and a sibling workspace is unsafe, because a
  // leftover tree at a well-known location is internally consistent, verifies, and ships a STAC
  // nobody asked for. An explicit path is used literally; no path at all is a named failure.
  it("uses the directory it is given, and does not look anywhere else", () => {
    const root = prepared(SOUND);
    const empty = tempRoot("portal-stac-empty-");
    const previous = process.env.FREVA_PORTAL_STAC_MATERIALS;
    process.env.FREVA_PORTAL_STAC_MATERIALS = root;
    try {
      // The explicit argument wins over the environment, and an empty directory named explicitly
      // is an error - not a reason to fall through to somewhere that does have a manifest.
      expect(loadStacMaterials(root).materials?.root).toBe(root);
      const loaded = loadStacMaterials(empty);
      expect(loaded.materials).toBeUndefined();
      expect(loaded.diagnostics[0]!.code).toBe("FP1604");
      expect(loaded.diagnostics[0]!.message).toContain(empty);
      expect(loaded.diagnostics[0]!.message).toContain("materials.json is missing");
    } finally {
      if (previous === undefined) delete process.env.FREVA_PORTAL_STAC_MATERIALS;
      else process.env.FREVA_PORTAL_STAC_MATERIALS = previous;
    }
  });

  it("fails closed, with the two commands, when it is given nothing at all", () => {
    const previous = process.env.FREVA_PORTAL_STAC_MATERIALS;
    delete process.env.FREVA_PORTAL_STAC_MATERIALS;
    try {
      const loaded = loadStacMaterials();
      expect(loaded.materials).toBeUndefined();
      expect(loaded.diagnostics[0]!.code).toBe("FP1604");
      // The remedy names the preparation stage and the flag that hands its result over; "not
      // found" alone leaves an operator guessing where to put a directory.
      expect(loaded.diagnostics[0]!.hint).toContain("npm run prepare:upstream");
      expect(loaded.diagnostics[0]!.hint).toContain("--stac-materials");
    } finally {
      if (previous !== undefined) process.env.FREVA_PORTAL_STAC_MATERIALS = previous;
    }
  });

  it("reads FREVA_PORTAL_STAC_MATERIALS as the same explicit statement", () => {
    const root = prepared(SOUND);
    const previous = process.env.FREVA_PORTAL_STAC_MATERIALS;
    process.env.FREVA_PORTAL_STAC_MATERIALS = root;
    try {
      expect(loadStacMaterials().materials?.root).toBe(root);
    } finally {
      if (previous === undefined) delete process.env.FREVA_PORTAL_STAC_MATERIALS;
      else process.env.FREVA_PORTAL_STAC_MATERIALS = previous;
    }
  });
});

describe("verification of the prepared tree", () => {
  it("detects a file whose bytes changed", () => {
    const root = prepared(SOUND);
    writeFileSync(join(root, "assets", "index.js"), "export const ok = 2;\n");
    expect(findings(root).join("\n")).toContain("does not match its recorded digest");
  });

  it("detects a file whose recorded size disagrees with its bytes", () => {
    const root = prepared(SOUND, (m) => {
      const entry = m.files.find((f) => f.path === "assets/index.js")!;
      entry.bytes += 1;
    });
    // The tree digest covers path and content digest, not size, so this is a finding on its own
    // rather than a consequence of one.
    expect(findings(root).join("\n")).toContain("does not match its recorded size");
  });

  it("detects a declared file that is missing", () => {
    const root = prepared(SOUND);
    rmSync(join(root, "LICENSES", "stac-browser-ISC.txt"));
    expect(findings(root).join("\n")).toContain("is missing");
  });

  it("detects an undeclared file that was added to the tree", () => {
    const root = prepared(SOUND);
    writeFileSync(join(root, "assets", "extra.js"), "export const smuggled = 1;\n");
    expect(findings(root).join("\n")).toContain("which the manifest does not declare");
  });

  it("refuses a declared file that is a symbolic link", () => {
    const root = prepared(SOUND);
    const secret = join(tempRoot("portal-stac-outside-"), "secret.txt");
    mkdirSync(dirname(secret), { recursive: true });
    writeFileSync(secret, "not ours\n");
    rmSync(join(root, "assets", "index.js"));
    symlinkSync(secret, join(root, "assets", "index.js"));
    expect(findings(root).join("\n")).toContain("is a symbolic link");
  });

  it("refuses a symlinked parent directory, which no leaf check would catch", () => {
    const outside = tempRoot("portal-stac-elsewhere-");
    mkdirSync(join(outside, "assets"), { recursive: true });
    writeFileSync(join(outside, "assets", "index.js"), SOUND["assets/index.js"]!);
    writeFileSync(join(outside, "assets", "index.css"), SOUND["assets/index.css"]!);

    const root = prepared(SOUND);
    rmSync(join(root, "assets"), { recursive: true, force: true });
    symlinkSync(join(outside, "assets"), join(root, "assets"));

    const reported = findings(root).join("\n");
    // Both halves matter: the declared file resolves out of the tree, and the closure walk sees
    // a link where it expected a directory.
    expect(reported).toContain("resolves outside the materials root");
    expect(reported).toContain("'assets' is a symbolic link");
  });

  it("refuses two declared paths that collide under case folding", () => {
    const root = prepared(SOUND, (m) => {
      m.files = [...m.files, { path: "assets/INDEX.js", digest: digest("x"), bytes: 1 }].sort(
        (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      );
      m.treeDigest = treeDigestOf(m.files);
    });
    writeFileSync(join(root, "assets", "INDEX.js"), "x");
    expect(findings(root).join("\n")).toContain("collide under case");
  });

  it("refuses a duplicate entry", () => {
    const root = prepared(SOUND, (m) => {
      const entry = m.files.find((f) => f.path === "assets/index.js")!;
      m.files = [...m.files, { ...entry }].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      m.treeDigest = treeDigestOf(m.files);
    });
    expect(findings(root).join("\n")).toContain("listed more than once");
  });

  it("refuses a file list that is not in canonical code-point order", () => {
    const root = prepared(SOUND, (m) => {
      m.files = [...m.files].reverse();
    });
    expect(findings(root).join("\n")).toContain("canonical code-point order");
  });

  it("recomputes the tree digest rather than believing it", () => {
    const root = prepared(SOUND, (m) => {
      m.treeDigest = `sha256:${"0".repeat(64)}`;
    });
    expect(findings(root).join("\n")).toContain("but the listed files hash to");
  });

  it("requires the entry and the stylesheets to be listed files", () => {
    const missingEntry = prepared(SOUND, (m) => {
      m.entry = "assets/absent.js";
    });
    expect(findings(missingEntry).join("\n")).toContain("which is not a listed file");

    const missingStyle = prepared(SOUND, (m) => {
      m.styles = ["assets/absent.css"];
    });
    expect(findings(missingStyle).join("\n")).toContain("which is not a listed file");
  });

  it("reports every finding, not only the first", () => {
    const root = prepared(SOUND);
    writeFileSync(join(root, "assets", "index.js"), "changed\n");
    writeFileSync(join(root, "assets", "index.css"), "changed\n");
    expect(findings(root).length).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(!STAC_MATERIALS)("verifies the materials this repository actually ships", () => {
    const shipped = join(REPOSITORY_ROOT, "packages", "stac-browser", "materials");
    const loaded = load(shipped);
    expect(loaded.diagnostics).toEqual([]);
    expect(verifyMaterials(loaded.materials!)).toEqual([]);
  });
});

describe("the adapter option surface", () => {
  const fixtureDir = join(PACKAGE_ROOT, "tests", "fixtures", "stac-adapter");

  const extract = (source: string, name: string): unknown =>
    JSON.parse(new RegExp(`const ${name} = ([\\s\\S]*?);\\n`).exec(source)![1]!);

  it.each(["minimal", "standard", "all-options"])(
    "produces the recorded configuration for the %s case",
    (name) => {
      const golden = JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8")) as {
        input: StacAdapterInput;
        config: Record<string, unknown>;
        hiddenRelations: string[];
        canonicalizeAdvertisedRoot: boolean;
        entryUrl: string;
        styleUrls: string[];
        mountId: string;
      };
      const source = generateAdapterModule(golden.input);
      expect(extract(source, "CONFIG")).toEqual(golden.config);
      expect(extract(source, "HIDDEN_RELATIONS")).toEqual(golden.hiddenRelations);
      expect(extract(source, "CANONICALIZE_ROOT")).toEqual(golden.canonicalizeAdvertisedRoot);
      expect(extract(source, "ENTRY_URL")).toEqual(golden.entryUrl);
      expect(extract(source, "STYLE_URLS")).toEqual(golden.styleUrls);
      expect(extract(source, "MOUNT_ID")).toEqual(golden.mountId);
    },
  );

  it("emits the same module for the same input, byte for byte", () => {
    const golden = JSON.parse(readFileSync(join(fixtureDir, "standard.json"), "utf8")) as {
      input: StacAdapterInput;
    };
    expect(generateAdapterModule(golden.input)).toBe(generateAdapterModule(golden.input));
  });
});

// The contract and the pin live in the STAC Browser workspace, which this repository does not
// carry yet. Without it there is nothing to compare against, so the block skips rather than
// failing on a missing file.
const STAC_WORKSPACE = join(REPOSITORY_ROOT, "packages", "stac-browser");
const HAS_ADAPTER_CONTRACT =
  existsSync(join(STAC_WORKSPACE, "adapter-contract.json")) &&
  existsSync(join(STAC_WORKSPACE, "upstream.json"));

describe.skipIf(!HAS_ADAPTER_CONTRACT)("the upstream adapter contract", () => {
  const readJson = <T>(name: string): T =>
    JSON.parse(readFileSync(join(STAC_WORKSPACE, name), "utf8")) as T;
  const contract = HAS_ADAPTER_CONTRACT
    ? readJson<{
        upstream: { tag: string; commit: string };
        settable: string[];
        required: string[];
        namedTransforms: string[];
      }>("adapter-contract.json")
    : { upstream: { tag: "", commit: "" }, settable: [], required: [], namedTransforms: [] };
  const pin = HAS_ADAPTER_CONTRACT
    ? readJson<{ tag: string; commit: string }>("upstream.json")
    : { tag: "", commit: "" };

  it("is reviewed for exactly the pinned upstream, so an upgrade cannot inherit it", () => {
    expect(contract.upstream.tag).toBe(pin.tag);
    expect(contract.upstream.commit).toBe(pin.commit);
  });

  it("bounds the upstream keys the adapter may set, in every fixture", () => {
    const settable = new Set(contract.settable);
    for (const name of ["minimal", "standard", "all-options"]) {
      const golden = JSON.parse(
        readFileSync(
          join(PACKAGE_ROOT, "tests", "fixtures", "stac-adapter", `${name}.json`),
          "utf8",
        ),
      ) as { config: Record<string, unknown> };
      for (const key of Object.keys(golden.config)) {
        expect(settable, `${name} sets '${key}'`).toContain(key);
      }
      for (const key of contract.required) {
        expect(Object.keys(golden.config), `${name} omits '${key}'`).toContain(key);
      }
    }
  });

  it("keeps the named transforms closed", () => {
    const source = generateAdapterModule(
      JSON.parse(
        readFileSync(
          join(PACKAGE_ROOT, "tests", "fixtures", "stac-adapter", "standard.json"),
          "utf8",
        ),
      ).input as StacAdapterInput,
    );
    // Every function in the generated module taking a loaded STAC document as its first
    // argument, with or without a second: `projectRootPresentation(doc, isRoot)` is a transform.
    // Helpers that only READ a document name that parameter differently, so they are not counted.
    const declared = [...source.matchAll(/^function ([A-Za-z0-9_]+)\(doc[,)]/gm)].map((m) => m[1]!);
    expect(declared.sort()).toEqual([...contract.namedTransforms].sort());
  });
});
