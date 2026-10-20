// @vitest-environment jsdom
// The code figures' markup contract (src/ui/code-figure.html), mounted as a page would mount it:
// the run control appears only because the id, the digest and the source agree, and the figure
// becomes editable. A change to what /ui/code reads must change the contract file too - which the
// figures' generators (portal-builder, Waterpark) test against.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The package directory: where vitest runs this suite (jsdom gives import.meta.url no file path).
const contract = readFileSync(join(process.cwd(), "src", "ui", "code-figure.html"), "utf8");

describe("the code figure contract", () => {
  it("is what /ui/code enables, and nothing less", async () => {
    document.body.innerHTML = contract;
    const { mountRunnableCode } = await import("../src/ui/code-run.js");
    await mountRunnableCode();
    const run = document.querySelector<HTMLButtonElement>("button[data-portal-run]")!;
    expect(run.hidden).toBe(false);
    expect(document.querySelector(".portal-code-gutter")?.textContent).toBe("1");
    expect(document.querySelector(".portal-code-editable")).toBeTruthy();
  });

  it("keeps the control hidden when the source no longer hashes to the digest", async () => {
    document.body.innerHTML = contract.replace(
      'data-portal-copy="print(&quot;hello&quot;)"',
      'data-portal-copy="print(&quot;bye&quot;)"',
    );
    const { mountRunnableCode } = await import("../src/ui/code-run.js");
    await mountRunnableCode();
    expect(document.querySelector<HTMLButtonElement>("button[data-portal-run]")!.hidden).toBe(true);
  });
});
