// All eight enablement combinations. "Disabled" is checked three ways, because only the
// combination is evidence: the route is absent from the artifact, the owned modules are absent
// from the recorded build graph, and the service URL appears in no shipped byte. A CSS rule that
// hides a component satisfies none of the three.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite, STAC_MATERIALS } from "../helpers/site.js";

afterAll(cleanupFixtures);

const COMBINATIONS = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => ({
  databrowser: Boolean(mask & 1),
  stac: Boolean(mask & 2),
  auth: Boolean(mask & 4),
}));

interface Evidence {
  components: {
    id: string;
    kind: string;
    enabled: boolean;
    modules: string[];
    copiedFiles: string[];
    routes: string[];
    emittedServiceIds: string[];
  }[];
}

function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

// The enablement matrix, minus the rows this checkout cannot build. A row with `stac: true`
// embeds the prepared third-party application, and a checkout that has never run the preparation
// stage has none - a supported state, because ordinary bootstrap does not fetch or compile it.
// Those rows skip; every disabled-STAC row runs, and those prove a disabled component emits
// nothing.
const RUNNABLE = COMBINATIONS.filter((c) => !c.stac || STAC_MATERIALS);
describe.each(RUNNABLE)("databrowser=$databrowser stac=$stac auth=$auth", (combination) => {
  it("emits exactly the routes, modules, assets and service projections it should", async () => {
    const root = writeMatrixSite(combination);
    const out = join(tempRoot("portal-matrix-out-"), "site");
    const result = await buildFixture(root, out);
    expect(result.diagnostics.errors).toEqual([]);
    expect(result.outDir).toBe(out);

    const files = listFiles(out);
    const html = readFileSync(join(out, "index.html"), "utf8");
    const evidence = JSON.parse(
      readFileSync(join(out, "component-evidence.json"), "utf8"),
    ) as Evidence;
    const portal = JSON.parse(readFileSync(join(out, "portal-manifest.json"), "utf8")) as {
      services: { id: string }[];
      routes: { path: string }[];
    };
    const shipped = files
      .filter((f) => f.endsWith(".js") || f.endsWith(".html") || f.endsWith(".css"))
      .map((f) => readFileSync(join(out, ...f.split("/")), "utf8"))
      .join("\n");

    // Routes that never depend on a component are always present.
    expect(existsSync(join(out, "index.html"))).toBe(true);
    expect(existsSync(join(out, "docs", "guide", "index.html"))).toBe(true);
    expect(existsSync(join(out, "404.html"))).toBe(true);

    // Data Browser
    expect(existsSync(join(out, "data", "index.html"))).toBe(combination.databrowser);
    expect(html.includes('href="/data/"')).toBe(combination.databrowser);
    const data = evidence.components.find((c) => c.id === "data")!;
    expect(data.enabled).toBe(combination.databrowser);
    expect(data.modules.length > 0).toBe(combination.databrowser);
    expect(portal.services.some((s) => s.id === "dataApi")).toBe(combination.databrowser);
    expect(shipped.includes("https://data.example.org/api")).toBe(combination.databrowser);
    // The landing search block only exists when its target does.
    expect(html.includes("portal-search")).toBe(combination.databrowser);

    // STAC Browser
    expect(existsSync(join(out, "catalog", "index.html"))).toBe(combination.stac);
    const catalog = evidence.components.find((c) => c.id === "catalog")!;
    expect(catalog.enabled).toBe(combination.stac);
    expect(files.some((f) => f.startsWith("stac/"))).toBe(combination.stac);
    expect(catalog.copiedFiles.length > 0).toBe(combination.stac);
    expect(shipped.includes("https://catalog.example.org/stac/")).toBe(combination.stac);
    expect(html.includes('href="/catalog/"')).toBe(combination.stac);

    // Auth
    const callback = join(out, "auth", "callback", "index.html");
    expect(existsSync(callback)).toBe(combination.auth);
    const login = evidence.components.find((c) => c.id === "login")!;
    expect(login.enabled).toBe(combination.auth);
    expect(login.modules.length > 0).toBe(combination.auth);
    expect(shipped.includes("https://auth.example.org/v2")).toBe(combination.auth);
    expect(html.includes("data-portal-account")).toBe(combination.auth);

    // Nothing owned by a disabled component survives anywhere.
    for (const component of evidence.components) {
      if (component.enabled) continue;
      expect(component.modules).toEqual([]);
      expect(component.copiedFiles).toEqual([]);
      expect(component.routes).toEqual([]);
      expect(component.emittedServiceIds).toEqual([]);
    }

    // The artifact is not merely missing a route: nothing is hidden by CSS.
    if (!combination.databrowser) {
      expect(shipped).not.toContain("portal-databrowser-mount");
    }
    if (!combination.stac) {
      expect(shipped).not.toContain("stac-browser-mount");
    }

    expect(statSync(join(out, "checksums.sha256")).size).toBeGreaterThan(0);
  }, 240_000);
});
