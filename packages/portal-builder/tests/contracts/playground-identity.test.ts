/**
 * ONE PORTAL, ONE PLAYGROUND - across pages, not only within one.
 *
 * A portal emits a single playground: one child artifact when `playgroundOrigin` is set, built
 * from whichever page the walk reaches first, and one site-wide `csp.portal` whose `connect-src`
 * is the UNION of every page's package origins. Two pages asking for different profiles is
 * therefore not two configurations - it is one artifact that is wrong in both directions, and
 * neither page can tell:
 *
 *   - the page asking for `freva-client` gets a child prepared for the other profile, and no
 *     package index, so its interpreter fails at metadata lookup;
 *   - the page asking for the narrower profile gets a header permitting an index that its own
 *     help panel, rendered from its own narrower policy, says is not enabled.
 *
 * The per-page check (`FP1215`, in `python-playground.ts`) cannot see this: it compares the
 * blocks of one document with each other. These tests are about the pass that compares pages.
 */
import { describe, expect, it } from "vitest";
import { resolveFixture, tempRoot, write, writeSite } from "../helpers/fixture.js";
import { catalogue } from "../helpers/consumer.js";

/** A landing carrying one dataset-tree block with a `python` stanza on the named profile. */
const landing = (title: string, profile: string, origin?: string): string =>
  `schemaVersion: 1
title: ${title}
blocks:
  - type: dataset-tree
    catalog: ../data/archive.json
    heading: Browse the archive
    summary: Expand a collection.
    python:
      enabled: true
      profile: ${profile}
      autostart: never
      maxSessions: 2
${origin ? `      playgroundOrigin: ${origin}\n` : ""}      terminal:
        style: freva-client-terminal
        osControls: auto
        alwaysOnTop: true
        rememberAppearance: true
`;

const CATALOG = JSON.stringify(catalogue(), null, 2);

function twoLandings(first: string, second: string, origin?: string): string {
  const root = tempRoot("portal-identity-");
  writeSite(root, {
    landing: landing("Home", first, origin),
    extra: "  other:\n    path: /other/\n    source: ./landings/other.yaml\n",
  });
  write(root, "landings/other.yaml", landing("Other", second, origin));
  write(root, "data/archive.json", CATALOG);
  return root;
}

const messages = (errors: readonly { code: string; message: string }[]): string =>
  errors.map((e) => `${e.code} ${e.message}`).join("\n");

describe("two pages cannot ask for two playgrounds", () => {
  it("refuses a portal whose pages name different profiles", async () => {
    const result = await resolveFixture(twoLandings("xarray-zarr", "freva-client"));
    const errors = result.diagnostics.errors;
    expect(messages(errors)).toMatch(/FP1215/);
    expect(messages(errors)).toMatch(/profile/);
    // The freva-client profile is the one that would have silently lost its package index.
    expect(messages(errors)).toMatch(/freva-client/);
  });

  it("refuses it on a separate playground origin too, where the child is built from one page", async () => {
    const result = await resolveFixture(
      twoLandings("xarray-zarr", "freva-client", "https://play.example.org"),
    );
    expect(messages(result.diagnostics.errors)).toMatch(/FP1215/);
  });

  it("reports it against the page that differs, not the one it is compared with", async () => {
    const result = await resolveFixture(twoLandings("xarray-zarr", "freva-client"));
    const fp1215 = result.diagnostics.errors.filter((e) => e.code === "FP1215");
    expect(fp1215.length).toBeGreaterThan(0);
    // `other.yaml` is the second page. Pointing at `home.yaml` would send an author to the file
    // they did not change.
    expect(fp1215.every((e) => String(e.file ?? "").includes("other"))).toBe(true);
  });

  it("accepts a portal whose pages agree", async () => {
    const result = await resolveFixture(twoLandings("freva-client", "freva-client"));
    expect(result.diagnostics.errors.filter((e) => e.code === "FP1215")).toEqual([]);
  });
});
