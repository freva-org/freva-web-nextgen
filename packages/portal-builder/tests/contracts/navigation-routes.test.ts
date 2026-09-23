// Typed targets, route derivation and collisions. The disabled-component rule is the one worth
// stating: a reference to a *known but disabled* component is omitted with a diagnostic, while a
// reference to an unknown name is an error - which makes enable/disable a one-field operation
// without also accepting typos.

import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  codes,
  resolveFixture,
  tempRoot,
  write,
  writeSite,
} from "../helpers/fixture.js";
import {
  applyPathOverride,
  derivePageRoute,
  RouteCollision,
  RouteRegistry,
} from "../../src/routes/derive.js";

afterAll(cleanupFixtures);

const WITH_DATA = `services:
  dataApi:
    kind: databrowser
    baseUrl: /api/data
components:
  data:
    kind: databrowser
    enabled: ENABLED
    service: dataApi
    route: /data/
navigation:
  header:
    - component: data
      label: Data
    - landing: home
      label: Home
`;

describe("route derivation", () => {
  it.each([
    ["index.md", "/docs/"],
    ["guide.md", "/docs/guide/"],
    ["guide/index.rst", "/docs/guide/"],
    ["guide/install.md", "/docs/guide/install/"],
  ])("maps %s to %s", (source, route) => {
    expect(derivePageRoute("/docs/", source)).toBe(route);
  });

  it("keeps a frontmatter path override under its source mount", () => {
    expect(applyPathOverride("/docs/", "/docs/elsewhere/")).toBe("/docs/elsewhere/");
    expect(applyPathOverride("/docs/", "/other/")).toBeUndefined();
    expect(applyPathOverride("/docs/", "/docs/../escape/")).toBeUndefined();
  });

  it.each([
    ["exact duplicates", "/docs/guide/", "/docs/guide/"],
    ["case-only differences", "/docs/Guide/", "/docs/guide/"],
  ])("refuses %s", (_name, first, second) => {
    const registry = new RouteRegistry();
    registry.add(first, "a");
    expect(() => registry.add(second, "b")).toThrow(RouteCollision);
  });

  it("refuses two sources that derive the same route", async () => {
    const root = tempRoot();
    write(root, "content/guide.md", "---\ntitle: A\n---\n");
    write(root, "content/guide/index.md", "---\ntitle: B\n---\n");
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1208");
  });
});

describe("typed navigation targets", () => {
  it("resolves landing, component, internal and external targets", async () => {
    const root = tempRoot();
    write(root, "content/guide.md", "---\ntitle: Guide\n---\n");
    writeSite(root, {
      extra: `rendering:
  profile: portal-content-v1
  sources:
    - root: ./content
      mount: /docs/
${WITH_DATA.replace("ENABLED", "true")}    - href: /docs/guide/
      label: Guide
    - href: https://www.example.org/
      label: Institute
`,
    });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    const header = result.model!.navigation.header;
    expect(header.map((l) => l.href)).toEqual([
      "/data/",
      "/",
      "/docs/guide/",
      "https://www.example.org/",
    ]);
    expect(header.at(-1)?.external).toBe(true);
  });

  it("omits a reference to a disabled component and keeps the rest", async () => {
    const root = tempRoot();
    writeSite(root, { extra: WITH_DATA.replace("ENABLED", "false") });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    expect(codes(result.diagnostics)).toContain("FP1202");
    expect(result.model!.navigation.header.map((l) => l.href)).toEqual(["/"]);
  });

  it("refuses a reference to an unknown component", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: "navigation:\n  header:\n    - component: nope\n      label: Nope\n",
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1201");
  });

  it("refuses a raw internal href to a missing route", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: "navigation:\n  header:\n    - href: /nowhere/\n      label: Nowhere\n",
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1201");
  });

  it("prefixes every generated internal href with the base path exactly once", async () => {
    const root = tempRoot();
    writeSite(root, {
      canonicalUrl: "https://portal.example.org/site/",
      extra: WITH_DATA.replace("ENABLED", "true"),
    });
    const result = await resolveFixture(root);
    expect(result.model!.navigation.header.map((l) => l.href)).toEqual(["/site/data/", "/site/"]);
    // A root-relative service URL is an origin-root URL and is never prefixed.
    expect(result.model!.services[0]?.url).toBe("/api/data");
  });
});
