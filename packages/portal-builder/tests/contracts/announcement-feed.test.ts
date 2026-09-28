// Live announcements: `announcementFeed.url`, read by the page at load.
//
// Build-time announcements are decided against `--effective-at`; nothing in the browser can invent
// one. The feed is the opt-in exception for notices that cannot wait for a deployment, held to the
// rules of live data: a declared URL, its origin in `connect-src`, text only, and nothing of it in
// an artifact that did not ask.

import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, codes, resolveFixture, tempRoot, writeSite } from "../helpers/fixture.js";
import { generateEntryModule } from "../../src/artifact/runtime-projection.js";
import { hostPolicy } from "../../src/artifact/manifests.js";
import { parseFeed } from "../../client/components/announcement-feed-core.js";

afterAll(cleanupFixtures);

function site(feed: string): string {
  const root = tempRoot("announcement-feed-");
  writeSite(root, { extra: feed });
  return root;
}

const NOW = Date.parse("2026-09-26T12:00:00Z");

describe("the feed document", () => {
  it("reads Waterpark's existing file as it is", () => {
    const waterpark = {
      announcements: [
        {
          id: "storage-migration",
          text: "The archive is read-only until the migration finishes.",
          level: "outage",
          expires: "2026-09-27T00:00:00Z",
          link: "https://status.example.org/",
          link_text: "Status",
        },
        {
          id: "later",
          text: "Not yet.",
          starts: "2026-10-01T00:00:00Z",
          expires: "2026-10-02T00:00:00Z",
        },
      ],
    };
    expect(parseFeed(waterpark, NOW)).toEqual([
      {
        id: "storage-migration",
        message: "The archive is read-only until the migration finishes.",
        level: "critical",
        dismissible: true,
        endsAt: Date.parse("2026-09-27T00:00:00Z"),
        link: { href: "https://status.example.org/", label: "Status" },
      },
    ]);
  });

  it("reads the portal's own field names, and a bare array", () => {
    const entries = parseFeed(
      [
        {
          id: "a",
          message: "Hello",
          level: "warning",
          dismissible: false,
          startsAt: "2026-09-26T00:00:00Z",
          endsAt: "2026-09-26T18:00:00Z",
        },
      ],
      NOW,
    );
    expect(entries.map((e) => [e.id, e.level, e.dismissible])).toEqual([["a", "warning", false]]);
  });

  it("drops what it cannot trust: no expiry, expired, bad id, too long, unsafe link", () => {
    const entries = parseFeed(
      {
        announcements: [
          { id: "no-end", text: "Forever" },
          { id: "old", text: "Gone", expires: "2026-09-01T00:00:00Z" },
          { id: "bad id!", text: "x", expires: "2026-12-01T00:00:00Z" },
          { id: "long", text: "x".repeat(501), expires: "2026-12-01T00:00:00Z" },
          {
            id: "js",
            text: "Click",
            expires: "2026-12-01T00:00:00Z",
            link: "javascript:alert(1)",
          },
          {
            id: "plain-http",
            text: "Click",
            expires: "2026-12-01T00:00:00Z",
            link: "http://example.org/",
          },
          { id: "html", text: "<b>bold</b>", expires: "2026-12-02T00:00:00Z" },
        ],
      },
      NOW,
    );
    expect(entries.map((e) => e.id)).toEqual(["js", "plain-http", "html"]);
    // The unsafe links are dropped, the notice kept; markup stays text (rendered with textContent).
    expect(entries.find((e) => e.id === "js")?.link).toBeUndefined();
    expect(entries.find((e) => e.id === "plain-http")?.link).toBeUndefined();
    expect(entries.find((e) => e.id === "html")?.message).toBe("<b>bold</b>");
  });

  it("ignores anything that is not a feed", () => {
    expect(parseFeed(null, NOW)).toEqual([]);
    expect(parseFeed({ items: [] }, NOW)).toEqual([]);
    expect(parseFeed("text", NOW)).toEqual([]);
  });
});

describe("the configuration", () => {
  it("adds nothing when absent", async () => {
    const { model } = await resolveFixture(site(""));
    expect(model!.announcementFeed).toBeUndefined();
    expect(generateEntryModule(model!)).not.toContain("announcement-feed");
    const plan = model!.componentEvidencePlan.find((p) => p.id === "announcement-feed");
    expect(plan?.enabled).toBe(false);
  });

  it("reads a same-origin feed without widening the policy", async () => {
    const { model, diagnostics } = await resolveFixture(
      site("announcementFeed:\n  url: /api/announcements\n"),
    );
    expect(codes(diagnostics.errors)).toEqual([]);
    expect(model!.announcementFeed).toEqual({ url: "/api/announcements", origin: "" });
    expect(generateEntryModule(model!)).toContain(
      "initAnnouncementFeed(RUNTIME.announcementFeed.url)",
    );
    const policy = hostPolicy({
      model: model!,
      evidence: {} as never,
      files: [],
      rstUsed: false,
    }) as {
      csp: { portal: Record<string, string> };
    };
    expect(policy.csp.portal["connect-src"]).toBe("'self'");
  });

  it("adds another origin to connect-src, and only there", async () => {
    const { model } = await resolveFixture(
      site("announcementFeed:\n  url: https://status.example.org/portal.json\n"),
    );
    const policy = hostPolicy({
      model: model!,
      evidence: {} as never,
      files: [],
      rstUsed: false,
    }) as {
      csp: { portal: Record<string, string> };
    };
    expect(policy.csp.portal["connect-src"]).toBe("'self' https://status.example.org");
    expect(policy.csp.portal["script-src"]).not.toContain("status.example.org");
  });

  it("refuses plain http and a relative path", async () => {
    for (const url of ["http://status.example.org/a.json", "api/announcements"]) {
      const { diagnostics } = await resolveFixture(site(`announcementFeed:\n  url: ${url}\n`));
      expect(codes(diagnostics.errors)).toContain("FP1205");
    }
  });
});
