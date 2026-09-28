// Live announcements, read from the deployment's own feed at page load (see
// `src/model/announcement-feed.ts`). Fetches one JSON document without credentials, keeps the
// well-formed entries live NOW and renders each as a build-time `portal-announcement` row - text
// only, same session-scoped dismissal. Every entry must say when it ends: a notice nothing can
// clear is the failure this prevents.
//
// An unreachable, empty or malformed feed shows nothing: a docs site that works while its backend
// is down beats a banner saying so.

import "./announcement-feed.css";
import { dismissed, remember } from "../shell.js";

import { parseFeed, type FeedAnnouncement } from "./announcement-feed-core.js";

export { parseFeed };

function row(entry: FeedAnnouncement, onDismiss: () => void): HTMLElement {
  const element = document.createElement("div");
  element.className = "portal-announcement portal-announcement-live";
  element.dataset.level = entry.level;
  // Namespaced, so a live notice and a build-time one that share an id stay two notices.
  element.dataset.portalAnnouncement = `feed:${entry.id}`;
  const paragraph = document.createElement("p");
  paragraph.className = "portal-announcement-text";
  paragraph.textContent = entry.message;
  if (entry.link) {
    paragraph.append(" ");
    const link = document.createElement("a");
    link.className = "portal-announcement-link";
    link.href = entry.link.href;
    link.textContent = entry.link.label;
    paragraph.append(link);
  }
  element.append(paragraph);
  if (entry.dismissible) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "portal-icon-button portal-announcement-dismiss";
    button.setAttribute("aria-label", "Dismiss this announcement");
    button.textContent = "✕";
    button.addEventListener("click", onDismiss);
    element.append(button);
  }
  return element;
}

export async function initAnnouncementFeed(url: string): Promise<void> {
  const host = document.getElementById("portal-announcements");
  if (!host) return;
  let entries: FeedAnnouncement[];
  try {
    const response = await fetch(url, {
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    entries = parseFeed(await response.json(), Date.now());
  } catch {
    return;
  }
  const gone = dismissed();
  for (const entry of entries) {
    const key = `feed:${entry.id}`;
    if (gone.has(key)) continue;
    const element = row(entry, () => {
      element.remove();
      const now = dismissed();
      now.add(key);
      remember(now);
    });
    host.append(element);
  }
}
