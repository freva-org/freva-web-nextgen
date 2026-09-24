// Conventions that mainstream documentation toolchains use and this project's own fictional
// fixtures do not, so nothing else in the suite covers them. See
// docs/external-consumer-playground.md for the source of the material.

import { describe, expect, it, afterAll } from "vitest";
import { cleanupFixtures } from "../helpers/fixture.js";
import { errorCodes, renderOne } from "../helpers/render.js";

afterAll(cleanupFixtures);

const md = (body: string): string => `---\ntitle: T\n---\n\n${body}\n`;

describe("an image reference with a fragment", () => {
  it("resolves the file before the '#' and keeps the fragment in the URL", async () => {
    // Several themes select a light or dark variant with a fragment on the image URL. A
    // fragment is not part of a file path, so resolving the whole string as one rejects an
    // image that is plainly there.
    const outcome = await renderOne("page.md", md("![Diagram](/assets/logo.svg#only-dark)"));
    expect(errorCodes(outcome)).toEqual([]);
    expect(outcome.html).toContain('src="/assets/logo.svg#only-dark"');
  });

  it("still rejects a fragment on an image that does not exist", async () => {
    const outcome = await renderOne("page.md", md("![Diagram](/assets/absent.svg#only-dark)"));
    expect(errorCodes(outcome)).toContain("PC1010");
  });
});

describe("MathML presentation attributes", () => {
  it("keeps the attributes the pinned math renderer emits", async () => {
    // KaTeX writes `mathvariant` on operators and `accent` on `mover` for ordinary notation
    // such as a vector arrow or a bar, so rejecting them is the sanitizer rejecting its own
    // renderer's output.
    const outcome = await renderOne("page.md", md("$$\\bar{x} \\vec{v} \\bmod n$$"));
    expect(errorCodes(outcome)).toEqual([]);
    expect(outcome.html).toContain("<math");
    // Asserted by name, so the test answers for the allowlist rather than for KaTeX.
    expect(outcome.html).toContain('accent="true"');
    expect(outcome.html).toContain("mathvariant=");
  });

  it("still rejects an authored attribute that is not in the profile", async () => {
    const outcome = await renderOne(
      "page.md",
      md('<math><mi href="javascript:alert(1)">x</mi></math>'),
    );
    expect(errorCodes(outcome).length).toBeGreaterThan(0);
  });
});
