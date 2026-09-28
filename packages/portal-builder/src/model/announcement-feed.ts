// Live announcements: the one opt-in exception to "announcements are decided at build time".
// Build-time `announcements:` suit anything planned, but not a notice an operator needs up in
// minutes ("the archive is read-only until the migration finishes"). So a deployment may name a
// feed: a JSON document on a server it controls, read by the page at load and treated as live
// data - a declared URL, its origin in `connect-src`, text only, absent unless configured.
//
// Accepted fields: the portal's (`message`, `startsAt`, `endsAt`) and a MkDocs-era Waterpark
// file's (`text`, `starts`, `expires`, `link`, `link_text`), so a migrating site keeps its file.

export const ANNOUNCEMENT_FEED_EVIDENCE = {
  id: "announcement-feed",
  kind: "announcement-feed" as const,
  ownedModuleRoots: [
    // A prefix: the island, its DOM-free core and its stylesheet.
    "builder:client/components/announcement-feed",
  ],
  allowedSharedModules: ["builder:client/shell.ts"],
};
