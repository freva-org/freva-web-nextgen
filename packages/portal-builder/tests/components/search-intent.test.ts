// The landing-to-Data-Browser handoff is a *value in a URL*, produced by the Data Browser
// package's own typed helper: no DOM selector, no global, no in-memory state a reload erases.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  parseSearchIntentV1,
  serializeSearchIntentV1,
  SEARCH_INTENT_VERSION,
  textToFacetValue,
} from "@freva-org/databrowser/intent";
import { cleanupFixtures, tempRoot } from "../helpers/fixture.js";
import { buildFixture, writeMatrixSite } from "../helpers/site.js";

afterAll(cleanupFixtures);

describe("SearchIntentV1", () => {
  it("round-trips through the URL", () => {
    const intent = {
      v: 1 as const,
      q: "sea surface temperature",
      flavour: "freva",
      facets: { project: ["example"], experiment: ["historical"] },
    };
    const query = serializeSearchIntentV1(intent);
    const parsed = parseSearchIntentV1(query);
    expect(parsed.intent.flavour).toBe("freva");
    expect(parsed.intent.facets?.project).toEqual(["example"]);
    expect(parsed.intent.facets?.experiment).toEqual(["historical"]);
    // Free text becomes a wildcard value on the uniq key, which the search API supports
    // directly rather than inventing a second query language.
    expect(parsed.intent.facets?.file).toEqual([textToFacetValue(intent.q)]);
  });

  it("keeps the reserved intent keys out of the component's facet vocabulary", () => {
    const parsed = parseSearchIntentV1("siv=1&q=temperature&project=example");
    expect(parsed.normalizedSearch).not.toContain("siv=");
    expect(parsed.normalizedSearch).not.toContain("q=");
    expect(parsed.normalizedSearch).toContain("project=example");
    expect(parsed.intent.q).toBe("temperature");
  });

  it("escapes Lucene metacharacters in free text but keeps its own wildcards", () => {
    expect(textToFacetValue("a:b c")).toBe("*a\\:b*c*");
    expect(textToFacetValue("   ")).toBe("");
  });

  it("reports an intent version this build does not accept, without discarding the query", () => {
    const parsed = parseSearchIntentV1("siv=99&project=example");
    expect(parsed.unsupportedVersion).toBe(99);
    expect(parsed.intent.facets?.project).toEqual(["example"]);
    expect(SEARCH_INTENT_VERSION).toBe(1);
  });

  it("serializes the intent into a plain GET form that works without JavaScript", async () => {
    const root = writeMatrixSite({ databrowser: true, stac: false, auth: false });
    const out = join(tempRoot("portal-intent-out-"), "site");
    const result = await buildFixture(root, out);
    expect(result.diagnostics.errors).toEqual([]);
    const html = readFileSync(join(out, "index.html"), "utf8");

    expect(html).toContain('<form class="portal-search-form" method="get" action="/data/"');
    expect(html).toContain('role="search"');
    expect(html).toContain('name="q"');
    expect(html).toContain('<input type="hidden" name="siv" value="1">');
    expect(html).toContain('<input type="hidden" name="flavour" value="freva">');
    // The handoff needs no script: the suggestion island reads the service from these
    // attributes, which are inert without it.
    const formSection = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
    expect(formSection).not.toContain("<script");
    expect(formSection).toContain("data-portal-search-api=");
    expect(formSection).toContain('data-portal-search-flavour="freva"');
    expect(existsSync(join(out, "data", "index.html"))).toBe(true);
  }, 120_000);
});
