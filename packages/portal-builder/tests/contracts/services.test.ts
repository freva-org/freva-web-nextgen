// Service kinds, URL semantics and the component dependency matrix. The trailing-slash
// assertions look pedantic and are not: a join base that keeps its slash and an exact resource
// URL that loses one are two different production incidents.

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, codes, resolveFixture, tempRoot, writeSite } from "../helpers/fixture.js";
import {
  joinEndpoint,
  normalizeAuthBase,
  normalizeDatabrowserBase,
  normalizeStacCatalogUrl,
  parseCanonicalUrl,
} from "../../src/model/urls.js";

afterAll(cleanupFixtures);

const components = (extra: string): string => extra;

describe("service URL semantics", () => {
  it("normalizes a Data Browser base to no trailing slash and rejects a query", () => {
    expect(normalizeDatabrowserBase("https://api.example.org/data/").value).toBe(
      "https://api.example.org/data",
    );
    expect(normalizeDatabrowserBase("/api/data/").value).toBe("/api/data");
    expect(normalizeDatabrowserBase("https://api.example.org/data?x=1").ok).toBe(false);
  });

  it("preserves a STAC catalog URL's trailing slash and query exactly", () => {
    const result = normalizeStacCatalogUrl("https://api.example.org/stac/?visible=a,b");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("https://api.example.org/stac/?visible=a,b");
    expect(normalizeStacCatalogUrl("/api/stac/").value).toBe("/api/stac/");
  });

  it.each([
    ["a fragment", "https://api.example.org/data#x"],
    ["user information", "https://user:pw@api.example.org/data"],
    ["a protocol-relative URL", "//api.example.org/data"],
    ["a backslash", "https://api.example.org\\data"],
    ["non-loopback HTTP", "http://api.example.org/data"],
  ])("rejects %s", (_name, url) => {
    expect(normalizeDatabrowserBase(url).ok).toBe(false);
    expect(normalizeAuthBase(url).ok).toBe(false);
  });

  it("allows plain HTTP only for a loopback host and only in dev", () => {
    expect(normalizeDatabrowserBase("http://localhost:7777/api").ok).toBe(false);
    expect(normalizeDatabrowserBase("http://localhost:7777/api", true).ok).toBe(true);
    expect(normalizeDatabrowserBase("http://example.org/api", true).ok).toBe(false);
  });

  it("joins endpoints through one helper rather than string addition", () => {
    expect(joinEndpoint("https://api.example.org/data", "search")).toBe(
      "https://api.example.org/data/search",
    );
    expect(joinEndpoint("https://api.example.org/data/", "/search")).toBe(
      "https://api.example.org/data/search",
    );
  });

  it("treats the canonical URL's pathname as the one and only base path", () => {
    const parsed = parseCanonicalUrl("https://portal.example.org/site/");
    expect(parsed.ok).toBe(true);
    expect(parsed.basePath).toBe("/site/");
    expect(parseCanonicalUrl("https://portal.example.org/site").ok).toBe(false);
    expect(parseCanonicalUrl("http://portal.example.org/").ok).toBe(false);
    expect(parseCanonicalUrl("https://portal.example.org/?x=1").ok).toBe(false);
  });
});

describe("component dependency matrix", () => {
  it("requires a valid service for an enabled component", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: components(`components:
  data:
    kind: databrowser
    enabled: true
    route: /data/
`),
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1203");
  });

  it("does not require a service for a disabled component", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: components(`components:
  data:
    kind: databrowser
    enabled: false
    route: /data/
`),
    });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    expect(result.model?.enabledComponents).toEqual([]);
  });

  it("rejects a component that references the wrong service kind", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: components(`services:
  catalog:
    kind: stac
    catalogUrl: /api/stac/
components:
  data:
    kind: databrowser
    enabled: true
    service: catalog
    route: /data/
`),
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1204");
  });

  it("requires auth when a Data Browser service declares authentication: required", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: components(`services:
  dataApi:
    kind: databrowser
    baseUrl: /api/data
    authentication: required
components:
  data:
    kind: databrowser
    enabled: true
    service: dataApi
    route: /data/
`),
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1203");
  });

  it("reports an unused service and does not emit it into the artifact", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: components(`services:
  dataApi:
    kind: databrowser
    baseUrl: /api/data
components:
  data:
    kind: databrowser
    enabled: false
`),
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1206");
    expect(result.model?.services).toEqual([]);
  });

  it("derives the auth redirect URI and the bearer-resource allowlist", async () => {
    const root = tempRoot();
    writeSite(root, {
      canonicalUrl: "https://portal.example.org/site/",
      extra: components(`services:
  dataApi:
    kind: databrowser
    baseUrl: https://api.example.org/data
    authentication: optional
  authBroker:
    kind: auth
    baseUrl: https://auth.example.org/v2
components:
  data:
    kind: databrowser
    enabled: true
    service: dataApi
    route: /data/
  login:
    kind: auth
    enabled: true
    service: authBroker
    options:
      additionalResourceOrigins:
        - https://jobs.example.org
`),
    });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    const auth = result.model?.components.find((c) => c.kind === "auth")?.options as {
      redirectUri: string;
      bearerResourceOrigins: string[];
      callbackPath: string;
    };
    expect(auth.callbackPath).toBe("/auth/callback/");
    expect(auth.redirectUri).toBe("https://portal.example.org/site/auth/callback/");
    expect(auth.bearerResourceOrigins).toEqual([
      "https://api.example.org",
      "https://auth.example.org",
      "https://jobs.example.org",
    ]);
  });

  it("refuses a credential-looking value in configuration", async () => {
    const root = tempRoot();
    writeSite(root, {
      extra: `services:
  dataApi:
    kind: databrowser
    baseUrl: https://api.example.org/data?client_secret=abc
`,
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).toContain("FP1210");
  });
});
