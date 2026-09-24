// The closed theme token set, and what happens to a value it accepts and does not use. Seven
// colour tokens validate and three reach the stylesheet. The other four drive properties the
// design owns in both themes, and the resolver drops them soundly: a preset states all seven
// because they describe its character, and three of the five state values true of one theme only
// - Cosmos's `colorBackground` is `#0b1522`, a night sky, and emitting that into `--bg` would
// repaint the light theme with it.
//
// Dropping a PRESET's value is right. Accepting a CONSUMER's in silence is not: the build
// succeeds, the stylesheet never sees the value, and there is no way to find that out.

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, codes, resolveFixture, tempRoot, writeSite } from "../helpers/fixture.js";
import { UNAPPLIED_TOKENS, resolveThemeCss } from "../../src/themes/registry.js";

afterAll(cleanupFixtures);

describe("the closed theme token set", () => {
  it("names exactly the four tokens it does not apply", () => {
    expect(Object.keys(UNAPPLIED_TOKENS).sort()).toEqual([
      "colorBackground",
      "colorSurface",
      "colorText",
      "colorTextMuted",
    ]);
  });

  it("reports a consumer's value for one of them, by name and pointer", async () => {
    const root = tempRoot();
    writeSite(root, {
      themeTokens: '    colorSurface: "#ffffff"\n    colorTextMuted: "#555555"',
    });
    const result = await resolveFixture(root);
    expect(result.diagnostics.errors).toEqual([]);
    expect(codes(result.diagnostics)).toContain("FP1212");

    const reported = result.diagnostics.items
      .filter((entry) => entry.code === "FP1212")
      .map((entry) => entry.pointer);
    expect(reported.sort()).toEqual(["/theme/tokens/colorSurface", "/theme/tokens/colorTextMuted"]);
    // The message names the property the value would have driven, so the reason is in the
    // report rather than only in a source comment.
    const message = result.diagnostics.items.find((entry) => entry.code === "FP1212")!.message;
    expect(message).toContain("colorSurface");
    expect(message).toContain("--surface");
  });

  it("says nothing when a consumer sets only the tokens that are applied", async () => {
    const root = tempRoot();
    writeSite(root, {
      themeTokens: '    colorAccent: "#0a6c74"\n    colorBorder: "#c6e0e0"',
    });
    const result = await resolveFixture(root);
    expect(codes(result.diagnostics)).not.toContain("FP1212");
  });

  // A preset's own values are not reported: every preset states all seven, so reporting them
  // would put four warnings on every build of every portal and mean nothing.
  it("says nothing about a preset's own values", () => {
    for (const preset of ["default", "freva", "contour", "cosmos", "waterpark"]) {
      expect(resolveThemeCss(preset, undefined).unapplied).toEqual([]);
    }
  });

  // And the reason the four are dropped, as a test that fails if they are wired up without
  // solving the two-theme problem first: the Cosmos preset's surface is a night sky.
  it("would repaint the light theme if a preset's values were emitted", () => {
    const cosmos = resolveThemeCss("cosmos", undefined);
    expect(cosmos.tokens.colorBackground).toBe("#0b1522");
    expect(cosmos.css).not.toContain("--bg: #0b1522");
    expect(cosmos.css).not.toContain("--surface: #101d2c");
  });
});
