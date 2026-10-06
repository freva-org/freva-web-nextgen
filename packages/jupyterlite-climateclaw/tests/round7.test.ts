// Saved figures, the new chat's page, voice text, names from the token, the cell label.
import { describe, expect, it } from "vitest";

import { tokenClaims } from "../src/auth.js";
import { cardHint, iconFor, pickGreeting } from "../src/empty-chat.js";
import { fetchFigure, figureMarkdown, savedFigures } from "../src/figures.js";
import { labelOutput } from "../src/runfix.js";
import { normalizeCodeOutput, threadToTurns } from "../src/stream.js";
import { speakableText } from "../src/voice.js";

const saved = {
  stdout: "",
  stderr: "",
  result_repr: "",
  display_data: [],
  error: "",
  created_files: [
    {
      path: "plots/era5.png",
      mime_type: "image/png",
      preview_url: "https://gems.dkrz.de/static/preview/climateclaw/T/plots/era5.png",
    },
    { path: "data.csv", mime_type: "text/csv", preview_url: "https://gems.dkrz.de/x/data.csv" },
    { path: "evil.png", preview_url: "javascript:alert(1)" },
  ],
};

describe("figures the code saved", () => {
  it("are the image files with a preview address (never another scheme)", () => {
    const figures = savedFigures(normalizeCodeOutput(saved));
    expect(figures).toEqual([
      {
        name: "plots/era5.png",
        url: "https://gems.dkrz.de/static/preview/climateclaw/T/plots/era5.png",
        mime: "image/png",
      },
    ]);
  });

  it("are read as base64, and not read when the browser may not (CORS, type, size)", async () => {
    const figure = { name: "a.png", url: "https://x.example/a.png", mime: "image/png" };
    const ok = (async () =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      })) as unknown as typeof fetch;
    expect(await fetchFigure(figure, { fetch: ok })).toBe(btoa("\x89PNG"));
    const cors = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await fetchFigure(figure, { fetch: cors, retryDelaysMs: [1] })).toBeNull();
    const html = (async () =>
      new Response("<html>", {
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    expect(await fetchFigure(figure, { fetch: html })).toBeNull();
  });

  it("a figure not there yet (404, no answer) is read again a little later", async () => {
    const figure = { name: "a.png", url: "https://x.example/a.png", mime: "image/png" };
    let calls = 0;
    const late = (async () => {
      calls += 1;
      if (calls === 1) return new Response("not yet", { status: 404 });
      if (calls === 2) throw new TypeError("Failed to fetch");
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;
    expect(await fetchFigure(figure, { fetch: late, retryDelaysMs: [1, 1, 1] })).toBe(
      btoa("\x89PNG"),
    );
    expect(calls).toBe(3);
    // Not retried: what will not change (its type), and a stop.
    calls = 0;
    const html = (async () => {
      calls += 1;
      return new Response("<html>", { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    expect(await fetchFigure(figure, { fetch: html, retryDelaysMs: [1, 1] })).toBeNull();
    expect(calls).toBe(1);
    // No answer twice (a CORS refusal looks the same): given up, not tried for seconds.
    calls = 0;
    const refused = (async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await fetchFigure(figure, { fetch: refused, retryDelaysMs: [1, 1, 1] })).toBeNull();
    expect(calls).toBe(2);
    const stop = new AbortController();
    stop.abort();
    expect(await fetchFigure(figure, { fetch: late, signal: stop.signal })).toBeNull();
  });

  it("show embedded when read, by their address otherwise, always with a link", () => {
    const figure = { name: "p/era5.png", url: "https://x.example/era5.png", mime: "image/png" };
    expect(figureMarkdown(figure, "AAA")).toBe(
      "![era5.png](data:image/png;base64,AAA)\n\n[era5.png ↗](https://x.example/era5.png)",
    );
    expect(figureMarkdown(figure, null)).toContain("![era5.png](https://x.example/era5.png)");
    expect(figureMarkdown(figure, null, "https://x.example")).toContain("![era5.png]");
    // From an origin the page may not show pictures from: the link only, no broken picture.
    const linked = figureMarkdown(figure, null, "https://freva.example.org");
    expect(linked).not.toContain("![");
    expect(linked).toContain("[era5.png ↗](https://x.example/era5.png)");
    // Read, it is embedded wherever it came from.
    expect(figureMarkdown(figure, "AAA", "https://freva.example.org")).toContain("data:image/png");
  });

  it("a stored conversation shows them by their address", () => {
    const { turns } = threadToTurns([
      { variant: "User", content: "plot" },
      { variant: "CodeOutput", content: saved, id: "c" },
    ]);
    expect(turns[1]!.text).toContain(
      "![era5.png](https://gems.dkrz.de/static/preview/climateclaw/T/plots/era5.png)",
    );
  });
});

describe("a new chat's page", () => {
  it("greets by first name with a climate line, or without a name", () => {
    expect(pickGreeting("Mo Hadizadeh", () => 0)).toBe(
      "Mo is back! The atmosphere kept busy while you were away.",
    );
    const anonymous = pickGreeting(null, () => 0.99);
    expect(anonymous).not.toContain("{name}");
    expect(anonymous.length).toBeGreaterThan(10);
    for (let i = 0; i < 20; i += 1) expect(pickGreeting("Jane", () => i / 20)).toContain("Jane");
    // An account id or an e-mail is not a name.
    expect(pickGreeting("k202187", () => 0)).not.toContain("k202187");
    expect(pickGreeting("jane@example.org", () => 0)).not.toContain("jane@");
  });

  it("gives each example card an icon and a short hint", () => {
    expect(iconFor({ title: "First map", prompt: "Plot a global map of tas" })).toBe("map");
    expect(iconFor({ title: "Which level?", prompt: "Which HEALPix level for Europe?" })).toBe(
      "layers",
    );
    expect(iconFor({ title: "Global mean", prompt: "Compute the global mean of tas" })).toBe(
      "chart",
    );
    expect(iconFor({ title: "Find data", prompt: "Find CMIP6 precipitation" })).toBe("data");
    expect(cardHint("a ".repeat(60), 20).length).toBeLessThanOrEqual(20);
  });
});

describe("voice and names", () => {
  it("reads a reply aloud without markup, code or markers", () => {
    expect(
      speakableText(
        '<!-- climateclaw:thread=T -->\n**Done**: the mean is 2.0.\n```python\nx=1\n```\n<span class="x">DKRZ</span> [link](https://a)',
      ),
    ).toBe("Done : the mean is 2.0. (code) DKRZ link");
  });

  it("reads a name from the token when userinfo has none (display only)", () => {
    const payload = btoa(JSON.stringify({ given_name: "Mo", family_name: "Hadizadeh" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(tokenClaims(`h.${payload}.s`)).toEqual({ given_name: "Mo", family_name: "Hadizadeh" });
    expect(tokenClaims("not-a-jwt")).toEqual({});
  });

  it("labels a DKRZ run with what ran it, when, and what that means for the kernel", () => {
    const label = labelOutput("gpt-4.1", new Date(2026, 9, 4, 14, 32));
    const md = String((label as { data: Record<string, unknown> }).data["text/markdown"]);
    // The time in the reader's locale (14:32, or 02:32 PM).
    expect(md).toMatch(/^\*\*Ran at DKRZ\*\* · ClimateClaw · gpt-4\.1 · (14:32|0?2:32\s?PM)/);
    expect(md).toContain("is not in this notebook's kernel");
  });
});

describe("signed out", () => {
  it("in ClimateClaw's panel the reply asks to sign in (a button), not an error", async () => {
    const { ClimateClawModel, SIGN_IN_MARKER } = await import("../src/model.js");
    const model = new ClimateClawModel("m", {
      api: () => ({}) as never,
      signInProblem: () => "Sign in with Freva",
      signedOut: () => true,
      hideCode: () => false,
      scopeNote: () => "",
    });
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    });
    const parts: Array<{ type: string; delta?: string }> = [];
    const reader = stream.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) parts.push(r.value);
    expect(parts.some((p) => p.type === "error")).toBe(false);
    const text = parts.map((p) => p.delta ?? "").join("");
    expect(text).toContain(SIGN_IN_MARKER);
    expect(text).toContain('class="jp-ClimateClaw-signInLink"');
    // Elsewhere (jupyterlite-ai's panel) it stays an error with the reason.
    const plain = new ClimateClawModel("m", {
      api: () => ({}) as never,
      signInProblem: () => "Sign in with Freva",
      hideCode: () => false,
      scopeNote: () => "",
    });
    await expect(
      plain.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "q" }] }] }),
    ).rejects.toThrow("Sign in with Freva");
  });
});
