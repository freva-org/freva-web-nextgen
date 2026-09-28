// `theme.backdrop.tail`: how the cosmos story ends after the last landing block. The browser
// measures the spacing (`browser-tests/cosmos-tail.mjs`); this settles the configuration.
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, codes, resolveFixture, tempRoot, writeSite } from "../helpers/fixture.js";
import { generateEntryModule } from "../../src/artifact/runtime-projection.js";

afterAll(cleanupFixtures);

async function resolve(theme: string, tail?: string) {
  const root = tempRoot("portal-tail-");
  writeSite(root, { theme, ...(tail ? { themeBackdrop: `    tail: ${tail}\n` } : {}) });
  return resolveFixture(root);
}

describe("theme.backdrop.tail", () => {
  it("is absent from the model for full, the default, and when unset", async () => {
    for (const tail of [undefined, "full"]) {
      const { model, diagnostics } = await resolve("cosmos", tail);
      expect(codes(diagnostics)).not.toContain("FP1228");
      expect(model?.theme.backdropTail).toBeUndefined();
    }
  });

  it.each(["short", "none"])("carries %s through on the cosmos preset", async (tail) => {
    const { model, diagnostics } = await resolve("cosmos", tail);
    expect(diagnostics.items.filter((d) => d.severity === "error")).toEqual([]);
    expect(model?.theme.backdropTail).toBe(tail);
    // Presentation only: the startup chain is the same as without it.
    const plain = await resolve("cosmos");
    expect(generateEntryModule(model!)).toBe(generateEntryModule(plain.model!));
  });

  it.each(["default", "contour", "waterpark"])(
    "is reported and ignored on the %s preset (FP1228)",
    async (preset) => {
      const { model, diagnostics } = await resolve(preset, "short");
      const found = diagnostics.items.filter((d) => d.code === "FP1228");
      expect(found).toHaveLength(1);
      expect(found[0]?.severity).toBe("warning");
      expect(found[0]?.pointer).toBe("/theme/backdrop/tail");
      expect(model?.theme.backdropTail).toBeUndefined();
    },
  );

  it("refuses a value outside full, short and none, and any other key", async () => {
    expect((await resolve("cosmos", "medium")).model).toBeUndefined();
    const root = tempRoot("portal-tail-");
    writeSite(root, { theme: "cosmos", themeBackdrop: "    height: 10px\n" });
    expect((await resolveFixture(root)).model).toBeUndefined();
  });
});
