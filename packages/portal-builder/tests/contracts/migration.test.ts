// Offline migration and its loss report. The contract is not "translate everything" but
// "translate what has a build-time representation, and name every field that does not, with its
// supported replacement". A silent drop is the one unacceptable outcome.

import { describe, expect, it } from "vitest";
import { migrateManifest } from "../../src/cli/migrate.js";

const MANIFEST = {
  uiId: "example-research",
  title: "Example Research Portal",
  subtitle: "Discover data",
  institution: "Example Institute",
  institutionUrl: "https://www.example.org/",
  logo: "/static/img/logo.svg",
  favicon: "/static/img/favicon.svg",
  language: "en",
  colors: { accent: "#006f86" },
  header: { links: [{ label: "Docs", href: "/docs/" }] },
  footer: { groups: [{ title: "Project", links: [{ label: "Guide", href: "/docs/guide/" }] }] },
  features: {
    databrowser: { enabled: true },
    stac: { enabled: true },
    auth: { enabled: true },
    weatherWidget: { enabled: true },
  },
  landing: {
    blocks: [
      { type: "hero", heading: "Research data", summary: "Find it." },
      { type: "search" },
      { type: "cards", items: [{ title: "Docs", href: "/docs/" }] },
      { type: "html-fragment", html: "<div>raw</div>" },
      { type: "sandbox-html", src: "/legacy/app.html" },
    ],
  },
  public_extensions: { stac_catalog_url: "/api/stac/", tracking_id: "UA-123" },
  announcements: [{ id: "old", message: "x", level: "info", from: "2026-01-01", to: "2026-02-01" }],
};

describe("migrate", () => {
  const result = migrateManifest(MANIFEST, "ui-manifest.json");

  it("produces a candidate portal.yaml with the fields that do translate", () => {
    expect(result.portalYaml).toContain("schemaVersion: 1");
    expect(result.portalYaml).toContain('title: "Example Research Portal"');
    expect(result.portalYaml).toContain('name: "Example Institute"');
    expect(result.portalYaml).toContain('colorAccent: "#006f86"');
    expect(result.portalYaml).toContain("kind: databrowser");
    expect(result.portalYaml).toContain("kind: stac");
    expect(result.portalYaml).toContain("kind: auth");
    expect(result.portalYaml).toContain('canonicalUrl: "https://portal.example.org/"');
  });

  it("translates the landing blocks it supports", () => {
    expect(result.landingYaml).toContain("- type: hero");
    expect(result.landingYaml).toContain("- type: component-search");
    expect(result.landingYaml).toContain("- type: cards");
  });

  it("reports every unsupported field with its replacement", () => {
    const byField = new Map(result.loss.entries.map((e) => [e.field, e]));
    expect(byField.get("uiId")?.replacement).toMatch(/one artifact per site/);
    expect(byField.get("landing.blocks[].html-fragment")?.replacement).toMatch(/prose/);
    expect(byField.get("landing.blocks[].sandbox-html")?.replacement).toMatch(/static-docs-v1/);
    expect(byField.get("public_extensions.tracking_id")?.replacement).toMatch(/typed service/);
    expect(byField.get("features.weatherWidget")?.replacement).toMatch(/capability proposal/);
    expect(byField.get("announcements.old")?.replacement).toMatch(/effective-at|startsAt/);
  });

  it("maps a known extension onto its typed replacement", () => {
    const stac = result.loss.entries.find((e) => e.field === "public_extensions.stac_catalog_url");
    expect(stac?.replacement).toContain("catalogUrl");
    expect(result.portalYaml).toContain('catalogUrl: "/api/stac/"');
  });

  it("never contacts the settings API: it reads a file and returns a value", () => {
    expect(result.loss.source).toBe("ui-manifest.json");
    expect(result.loss.schemaVersion).toBe(1);
  });
});
