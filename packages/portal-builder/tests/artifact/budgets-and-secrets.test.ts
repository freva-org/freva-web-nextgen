// Size budgets and secret scanning.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite, STAC_MATERIALS } from "../helpers/site.js";
import { checkBudgets, loadBudgets, measureArtifact } from "../../src/artifact/budgets.js";
import type { ComponentEvidence } from "../../src/artifact/evidence.js";

afterAll(cleanupFixtures);

// The arithmetic of the budget model, on a synthetic artifact: that the pieces add up and the
// three groups stay separate, which a synthetic input can settle and a real build cannot
// isolate. `budget-model.test.ts` measures the real thing against a consumer-shaped portal.
describe("size budgets", () => {
  /** A throwaway artifact directory whose pages ask for the assets named. */
  function artifact(pages: Record<string, string[]>): string {
    const dir = tempRoot("portal-budget-synth-");
    for (const [page, assets] of Object.entries(pages)) {
      const links = assets
        .map((a) =>
          a.endsWith(".css")
            ? `<link rel="stylesheet" href="/${a}">`
            : `<script type="module" src="/${a}"></script>`,
        )
        .join("");
      write(dir, page, `<!doctype html><html><head>${links}</head><body></body></html>`);
    }
    return dir;
  }

  it("charges a component for the modules it owns, not for the chunk it lands in", () => {
    const components = [
      {
        id: "data",
        kind: "databrowser",
        enabled: true,
        modules: ["pkg:npm/x@1#a.js", "pkg:npm/x@1#b.js"],
        chunks: [],
      },
    ] as unknown as ComponentEvidence[];
    const diagnostics = checkBudgets({
      files: [{ path: "_portal/entry.js", bytes: 900_000 }],
      artifactDir: artifact({ "index.html": ["_portal/entry.js"] }),
      components,
      moduleBytes: { "pkg:npm/x@1#a.js": 10, "pkg:npm/x@1#b.js": 20 },
      preparedRoots: [],
    });
    // The component is charged 30 bytes, not the whole 900 kB chunk.
    expect(diagnostics.filter((d) => d.message.includes("Component 'data'"))).toEqual([]);
  });

  it("fails when the base page is over, naming the page and the reviewed file", () => {
    const budgets = loadBudgets();
    const diagnostics = checkBudgets({
      files: [{ path: "_portal/entry.js", bytes: budgets.basePage.javascript + 1 }],
      artifactDir: artifact({ "index.html": ["_portal/entry.js"] }),
      components: [],
      moduleBytes: {},
      preparedRoots: [],
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("FP1407");
    expect(diagnostics[0]?.message).toContain("index.html");
    expect(diagnostics[0]?.hint).toContain("schema/budgets.json");
  });

  it("bounds the HEAVIEST page, not the sum of every page", () => {
    // A budget on the sum charges one visitor for a page they will never open, and turns
    // "publish another documentation page" into a bundle-size decision.
    const budgets = loadBudgets();
    const most = Math.floor(budgets.basePage.javascript * 0.6);
    const diagnostics = checkBudgets({
      files: [
        { path: "_portal/a.js", bytes: most },
        { path: "_portal/b.js", bytes: most },
      ],
      artifactDir: artifact({
        "index.html": ["_portal/a.js"],
        "docs/index.html": ["_portal/b.js"],
      }),
      components: [],
      moduleBytes: {},
      preparedRoots: [],
    });
    expect(diagnostics).toEqual([]);
  });

  it("counts an asset no page asks for as lazy - separately, and still", () => {
    const budgets = loadBudgets();
    const report = measureArtifact({
      files: [
        { path: "_portal/entry.js", bytes: 1000 },
        { path: "_portal/console.js", bytes: 400_000 },
      ],
      artifactDir: artifact({ "index.html": ["_portal/entry.js"] }),
      components: [],
      moduleBytes: {},
      preparedRoots: [],
    });
    expect(report.pages[0]?.javascript).toBe(1000);
    expect(report.lazyTotals.javascript).toBe(400_000);

    // …and going over the LAZY budget is still a failure, not an exemption.
    const diagnostics = checkBudgets({
      files: [
        { path: "_portal/entry.js", bytes: 1000 },
        { path: "_portal/console.js", bytes: budgets.lazy.javascript + 1 },
      ],
      artifactDir: artifact({ "index.html": ["_portal/entry.js"] }),
      components: [],
      moduleBytes: {},
      preparedRoots: [],
    });
    expect(diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining("Lazily loaded JavaScript"),
    ]);
    // And it says where the bytes are. "983497 is above 983040" is true and answers nothing in
    // somebody else's CI: the number sums every optional feature in the build, each with a
    // different answer, and the report already knows the split.
    expect(diagnostics[0]?.hint).toContain("Where it is:");
    expect(diagnostics[0]?.hint).toContain("unattributed");
  });

  it("gives a named feature its own ceiling, charged from the evidence", () => {
    const budgets = loadBudgets();
    expect(budgets.lazy.features["python-playground"]?.javascript ?? 0).toBeGreaterThan(0);
    const components = [
      {
        id: "python-playground",
        kind: "python-playground",
        enabled: true,
        modules: [],
        chunks: ["_portal/entry.js", "_portal/console.js"],
        ownedEmittedNames: ["browser-python.worker"],
      },
    ] as unknown as ComponentEvidence[];
    const report = measureArtifact({
      files: [
        { path: "_portal/entry.js", bytes: 1000 },
        { path: "_portal/console.js", bytes: 400_000 },
        { path: "_portal/browser-python.worker-abc.js", bytes: 130_000 },
      ],
      artifactDir: artifact({ "index.html": ["_portal/entry.js"] }),
      components,
      moduleBytes: {},
      preparedRoots: [],
    });
    // The Worker counts. It is emitted BESIDE the module graph rather than in it, so neither the
    // chunk list nor the module list mentions one, and nothing else would charge the feature for
    // its interpreter.
    expect(report.features["python-playground"]?.javascript).toBe(530_000);
    // The eager entry chunk is shared, and is charged to the base page rather than to the feature.
    expect(report.pages[0]?.javascript).toBe(1000);
  });

  it("excludes prepared third-party materials from every group", () => {
    const diagnostics = checkBudgets({
      files: [{ path: "stac/assets/huge.js", bytes: 20_000_000 }],
      artifactDir: artifact({ "index.html": [] }),
      components: [],
      moduleBytes: {},
      preparedRoots: ["stac"],
    });
    expect(diagnostics).toEqual([]);
  });

  // The framework's own largest configuration, measured against the reviewed number, two-sided:
  // over the limit is a regression, and a long way under it means the limit has stopped
  // describing anything and should be lowered.
  it("keeps the largest supported configuration inside the reviewed base-page budget", async () => {
    const root = writeMatrixSite({
      databrowser: true,
      stac: Boolean(STAC_MATERIALS),
      auth: true,
      theme: "cosmos",
      datasetTree: true,
    });
    const out = join(tempRoot("portal-budget-max-"), "site");
    const result = await buildFixture(root, out);
    expect(result.diagnostics.errors).toEqual([]);

    const report = measureArtifact({
      files: (result.files ?? []).map((f) => ({ path: f.path, bytes: f.bytes })),
      artifactDir: out,
      components: [],
      moduleBytes: {},
      preparedRoots: [],
    });
    const budgets = loadBudgets();
    const heaviest = report.pages[0];
    expect(heaviest).toBeTruthy();
    expect(heaviest?.css ?? 0).toBeLessThanOrEqual(budgets.basePage.css);
    // Headroom, not slack: a budget three times the real figure fails nothing.
    expect(heaviest?.css ?? 0).toBeGreaterThan(budgets.basePage.css * 0.5);
  }, 240_000);
});

describe("secret scanning", () => {
  it("refuses a credential-looking value in configuration", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: `services:
  authBroker:
    kind: auth
    baseUrl: https://auth.example.org/v2
  dataApi:
    kind: databrowser
    baseUrl: https://api.example.org/data
    apiKey: abc
`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics).some((c) => c === "FP1104" || c === "FP1210")).toBe(true);
  });

  it("refuses a bearer token pasted into prose-adjacent configuration", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: `chrome:
  header:
    enabled: true
    links:
      - label: Admin
        href: https://api.example.org/x?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0
`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1210");
  });
});

describe("the built artifact", () => {
  let out: string;

  beforeAll(async () => {
    const source = writeMatrixSite({ databrowser: true, stac: false, auth: true });
    write(source, "content/guide.md", "---\ntitle: Guide\n---\n\nOrdinary prose.\n");
    out = join(tempRoot("portal-secrets-"), "site");
    const result = await buildFixture(source, out);
    expect(result.diagnostics.errors).toEqual([]);
  }, 120_000);

  it("contains no credential-looking string", () => {
    const files: string[] = [];
    const walk = (prefix: string): void => {
      for (const entry of readdirSync(join(out, prefix), { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(rel);
        else if (/\.(html|js|css|json|sha256)$/.test(rel)) files.push(rel);
      }
    };
    walk("");
    const patterns = [
      /client_secret/i,
      /private[_-]?key/i,
      /BEGIN [A-Z ]*PRIVATE KEY/,
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
    ];
    for (const file of files) {
      const text = readFileSync(join(out, ...file.split("/")), "utf8");
      for (const pattern of patterns) {
        expect(`${file}: ${pattern.test(text)}`).toBe(`${file}: false`);
      }
    }
  });

  it("writes no token into build output: auth credentials are runtime only", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).not.toMatch(/authorization/i);
    expect(html).not.toMatch(/bearer /i);
  });

  it("leaves the previous artifact untouched when a later build fails", async () => {
    const before = readFileSync(join(out, "checksums.sha256"), "utf8");
    const broken = writeMatrixSite({ databrowser: true, stac: false, auth: true });
    writeFileSync(join(broken, "content", "guide.md"), "no title, no heading\n");
    const result = await buildFixture(broken, out);
    expect(result.diagnostics.errors.length).toBeGreaterThan(0);
    expect(result.outDir).toBeUndefined();
    expect(readFileSync(join(out, "checksums.sha256"), "utf8")).toBe(before);
  }, 120_000);
});
