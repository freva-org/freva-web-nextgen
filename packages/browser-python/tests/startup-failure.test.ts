/**
 * What a start failure says, and the two ways it can say less than it knows.
 *
 * FIRST: `Underlying error:` with nothing after it. `error.message.split("\n").pop()` returns the
 * empty string whenever a message ends in a newline - and Pyodide's do - printing the label anyway
 * and discarding the line that named the exception. SECOND: a sentence with a URL and a status in
 * it and nothing a reader could act on. Which option chooses that location, what command produces
 * the files, and whether Restart could help are the three things somebody fixing a deployment
 * needs; the last is worse than absent, because a 403 on a pinned artefact is a statement about a
 * deployment, not a moment, so inviting a retry gets the same answer.
 */

import { describe, expect, it } from "vitest";
import {
  describeFailure,
  describeFailures,
  lastMeaningfulLine,
  retryMayHelp,
  type StartupFailure,
} from "../src/worker/startup-failure.js";

describe("lastMeaningfulLine", () => {
  it("survives the trailing newline that used to empty it", () => {
    // Exactly the shapes `split("\n").pop()` returned "" for.
    expect(lastMeaningfulLine(new Error("ValueError: something went wrong\n"))).toBe(
      "ValueError: something went wrong",
    );
    expect(lastMeaningfulLine("Traceback...\nValueError: the real cause\n\n")).toBe(
      "ValueError: the real cause",
    );
    expect(lastMeaningfulLine("\n")).toBeUndefined();
  });

  it("returns the last line that says something, and trims it", () => {
    expect(lastMeaningfulLine("first\n  second  \n")).toBe("second");
    expect(lastMeaningfulLine("only one line")).toBe("only one line");
  });

  it("gives back undefined rather than an empty string, so a label can be omitted", () => {
    expect(lastMeaningfulLine("")).toBeUndefined();
    expect(lastMeaningfulLine("   \n\t\n")).toBeUndefined();
    expect(lastMeaningfulLine(undefined)).toBeUndefined();
    // And a rendered failure never prints the label with nothing after it.
    const rendered = describeFailure({
      resource: "addon",
      addon: "dask",
      kind: "install",
      url: "https://example.org/a/",
      artefact: "dask 2026.8.0",
    });
    expect(rendered).not.toMatch(/Underlying error:\s*$/m);
    expect(rendered).not.toContain("Underlying error:");
  });
});

describe("retryMayHelp", () => {
  const base = { resource: "addon", addon: "dask", url: "https://x/" } as const;

  it("is false for anything a fixed configuration reproduces exactly", () => {
    expect(retryMayHelp({ ...base, kind: "unavailable", status: 403 })).toBe(false);
    expect(retryMayHelp({ ...base, kind: "unavailable", status: 404 })).toBe(false);
    expect(
      retryMayHelp({
        ...base,
        kind: "mismatch",
        digests: { expected: "a", received: "b" },
      } as StartupFailure),
    ).toBe(false);
    expect(retryMayHelp({ ...base, kind: "install" })).toBe(false);
  });

  it("is true only for a transport failure, which genuinely can be transient", () => {
    expect(retryMayHelp({ ...base, kind: "unreachable" })).toBe(true);
  });
});

describe("describeFailure", () => {
  it("names the add-on, the URL, the status, the option, the command and the answer on retrying", () => {
    const text = describeFailure({
      resource: "addon",
      addon: "cartopy-natural-earth-110m",
      artefact: "ne_110m_coastline.shp",
      kind: "unavailable",
      status: 403,
      url: "https://cdn.example.org/python-addons/cartopy-natural-earth-110m/x.shp",
    });
    expect(text).toContain("cartopy-natural-earth-110m");
    expect(text).toContain("HTTP 403");
    expect(text).toContain("pythonPlayground.addonBaseUrl");
    expect(text).toContain("addonBaseURL in the API");
    expect(text).toContain("freva-browser-python prepare-addons");
    expect(text).toContain("Expected to be served at:");
    // THE SENTENCE THE OLD MESSAGE COULD NOT SAY.
    expect(text).toContain(
      "Restarting requests the same URL and gets the same answer; this needs the deployment fixed",
    );
  });

  it("says a restart may help when, and only when, it may", () => {
    const text = describeFailure({
      resource: "addon",
      addon: "dask",
      kind: "unreachable",
      url: "https://cdn.example.org/python-addons/dask/x.whl",
    });
    expect(text).toContain("network or CORS failure");
    expect(text).toContain("a restart may help");
  });

  it("names the wheelhouse's own option, not the add-on directory's", () => {
    const text = describeFailure({
      resource: "wheelhouse",
      kind: "install",
      url: "https://example.org/freva-wheels/",
      underlying: "ValueError: Can't fetch metadata",
    });
    expect(text).toContain("pythonPlayground.wheelhouseUrl");
    expect(text).toContain("wheelhouseURL in the API");
    expect(text).toContain("prepare-freva-wheelhouse");
    expect(text).toContain("Underlying error: ValueError: Can't fetch metadata");
  });

  it("prints both digests for a substitution, and says nothing was installed", () => {
    const text = describeFailure({
      resource: "addon",
      addon: "dask",
      artefact: "dask 2026.8.0",
      kind: "mismatch",
      url: "https://example.org/a/dask.whl",
      digests: { expected: "a".repeat(64), received: "b".repeat(64) },
    });
    expect(text).toContain(`expected sha256 ${"a".repeat(64)}`);
    expect(text).toContain(`received sha256 ${"b".repeat(64)}`);
    expect(text).toContain("has been installed");
  });

  it("marks an optional add-on as optional, so the sentence is about a capability", () => {
    const text = describeFailure({
      resource: "addon",
      addon: "cartopy-natural-earth-110m",
      optional: true,
      kind: "unavailable",
      status: 404,
      url: "https://example.org/a/x.shp",
    });
    expect(text).toContain("(optional)");
  });
});

describe("describeFailures", () => {
  it("reports several at once, with the advice given once rather than per failure", () => {
    // Preparation attempts every add-on rather than stopping at the first, so a deployment that
    // forgot to upload two directories learns about both in one run. The registry order makes that
    // matter: `cartopy-natural-earth-110m` is prepared BEFORE `dask`, so a portal whose unused
    // Cartopy data is missing would otherwise lose Dask too and be told only about Cartopy.
    const text = describeFailures([
      {
        resource: "addon",
        addon: "cartopy-natural-earth-110m",
        kind: "unavailable",
        status: 404,
        url: "https://example.org/a/x.shp",
      },
      {
        resource: "addon",
        addon: "dask",
        kind: "unavailable",
        status: 403,
        url: "https://example.org/a/dask.whl",
      },
    ]);
    expect(text).toContain("2 things this interpreter needs could not be prepared");
    expect(text).toContain("1. ");
    expect(text).toContain("2. ");
    expect(text).toContain("cartopy-natural-earth-110m");
    expect(text).toContain("dask");
  });

  it("renders a single failure as itself, with no list around it", () => {
    const one: StartupFailure = {
      resource: "addon",
      addon: "dask",
      kind: "unavailable",
      status: 404,
      url: "https://example.org/a/dask.whl",
    };
    expect(describeFailures([one])).toBe(describeFailure(one));
    expect(describeFailures([])).toBe("");
  });
});
