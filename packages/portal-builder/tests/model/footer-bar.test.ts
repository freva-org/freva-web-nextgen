// `chrome.footer.bar`: a lead and one to three links in the collapsed footer bar. The browser
// gate (`browser-tests/footer-bar.mjs`) measures the bar; this settles the configuration.
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, codes, resolveFixture, tempRoot, writeSite } from "../helpers/fixture.js";

afterAll(cleanupFixtures);

const link = (label: string, target: string): string =>
  target.startsWith("landing:")
    ? `        - label: ${label}\n          landing: ${target.slice(8)}\n`
    : `        - label: ${label}\n          href: ${target}\n`;

async function resolve(bar: string, footer = "    enabled: true\n") {
  const root = tempRoot("portal-footer-bar-");
  writeSite(root, { extra: `chrome:\n  footer:\n${footer}    bar:\n${bar}` });
  return resolveFixture(root);
}

const WATERPARK =
  '      lead: "Need support?"\n' +
  "      links:\n" +
  link("waterpark@support.dkrz.de", "mailto:waterpark@support.dkrz.de") +
  link("Newsletter", "https://waterpark.dkrz.de/subscription/form");

describe("chrome.footer.bar", () => {
  it("resolves the Waterpark example: a lead, a mailto and an external link", async () => {
    const { model, diagnostics } = await resolve(WATERPARK);
    expect(diagnostics.items.filter((d) => d.severity === "error")).toEqual([]);
    expect(model?.chrome.footer.bar).toEqual({
      lead: "Need support?",
      links: [
        {
          label: "waterpark@support.dkrz.de",
          href: "mailto:waterpark@support.dkrz.de",
          external: true,
          newTab: false,
        },
        {
          label: "Newsletter",
          href: "https://waterpark.dkrz.de/subscription/form",
          external: true,
          newTab: true,
        },
      ],
    });
  });

  it("resolves an internal target like any footer link, with no lead", async () => {
    const { model } = await resolve("      links:\n" + link("Home", "landing:home"));
    expect(model?.chrome.footer.bar).toEqual({
      links: [expect.objectContaining({ label: "Home", external: false, newTab: false })],
    });
  });

  it("refuses a fourth link with its own code, FP1229", async () => {
    const four = ["a", "b", "c", "d"].map((x) => link(x, `https://${x}.example.org/`)).join("");
    const { model, diagnostics } = await resolve(`      links:\n${four}`);
    expect(model).toBeUndefined();
    const found = diagnostics.items.filter((d) => d.code === "FP1229");
    expect(found).toHaveLength(1);
    expect(found[0]?.pointer).toBe("/chrome/footer/bar/links");
    expect(found[0]?.hint).toContain("at most three");
    expect(codes(diagnostics)).not.toContain("FP1104");
  });

  it("refuses an href that is neither a site path, https:// nor mailto:", async () => {
    for (const href of ["http://insecure.example.org/", "javascript:alert(1)", "ftp://x.org/"]) {
      const { model, diagnostics } = await resolve("      links:\n" + link("Bad", href));
      expect(model, href).toBeUndefined();
      const found = diagnostics.items.filter((d) => d.code === "FP1201");
      expect(
        found.map((d) => d.pointer),
        href,
      ).toEqual(["/chrome/footer/bar/links/0"]);
    }
  });

  it("refuses a lead over 40 characters, no links, and an unknown key", async () => {
    const long = `      lead: "${"x".repeat(41)}"\n      links:\n${link("a", "https://a.org/")}`;
    for (const bar of [
      long,
      "      links: []\n",
      `      links:\n${link("a", "https://a.org/")}      extra: 1\n`,
    ]) {
      const { model, diagnostics } = await resolve(bar);
      expect(model).toBeUndefined();
      expect(codes(diagnostics)).toContain("FP1104");
    }
  });

  it("is absent when the footer is disabled, and when not configured", async () => {
    const off = await resolve(WATERPARK, "    enabled: false\n");
    expect(off.model?.chrome.footer.bar).toBeUndefined();
    const root = tempRoot("portal-footer-bar-");
    writeSite(root);
    expect((await resolveFixture(root)).model?.chrome.footer.bar).toBeUndefined();
  });
});
