/**
 * The portal's adapter for the Freva footer badge.
 *
 * Everything the badge *is* - its markup, its motion, its stylesheet, its copy - belongs to
 * `@freva-org/freva-badge`. This file does four portal-shaped things and nothing else:
 *
 *   1. tells the badge where its assets were published, which depends on the site's base path and
 *      is therefore the portal's to know;
 *   2. loads the vendored runtime as ordinary same-origin scripts, so the artifact's
 *      `script-src 'self'` needs no widening and the compiler never touches bytes that are meant
 *      to be replaced wholesale later;
 *   3. moves the badge into the portal's overlay layer;
 *   4. tells it the footer's real geometry, and reserves its footprint in the footer bar - both
 *      the width it takes in the bar and the height it stands above it, which is what surfaces
 *      that end at the bar have to clear.
 *
 * The third: the badge mounts itself into `document.body`, which is right for a plain page and
 * wrong here, because the portal's header and footer sit in a stacking context above the body's -
 * so a correctly `position: fixed` panel is still painted underneath them. Moving the badge's own
 * root into the overlay layer keeps every listener and every bit of state it set up.
 *
 * The fourth: the badge is `position: fixed`, so it is out of the bar's flow and the institution
 * name lays out straight underneath it. The badge cannot fix that - it does not know there is an
 * institution - so the portal reserves the space, measured rather than guessed, and hands the
 * badge the two lengths that are the page's to decide: where the content column starts, and how
 * tall the footer is on this view.
 */

interface BadgeGlobals {
  FrevaBadgeOptions?: { assetBase: string; quality?: string; liveMark?: string };
  FrevaBadge?: { mount(target?: Element): void };
}

/** One `<script src>` per file, in order, resolved when it has run. */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const element = document.createElement("script");
    element.src = src;
    element.async = false;
    element.addEventListener("load", () => resolve());
    element.addEventListener("error", () => reject(new Error(`badge script failed: ${src}`)));
    document.head.append(element);
  });
}

export async function mountFooterBadge(): Promise<void> {
  const anchor = document.getElementById("portal-footer-badge");
  if (!anchor) return;
  const assetBase = anchor.dataset.portalBadgeAssets;
  if (!assetBase) return;
  // `_badge/assets/` is a sibling of the two scripts; deriving one from the other keeps a single
  // source of truth for the base path.
  const runtimeBase = assetBase.replace(/assets\/$/, "");

  const globals = window as unknown as BadgeGlobals;
  globals.FrevaBadgeOptions = {
    assetBase,
    ...(anchor.dataset.portalBadgeQuality ? { quality: anchor.dataset.portalBadgeQuality } : {}),
    // The animated mark the Data Browser carries, lent to the badge as its resting state. The
    // badge keeps its own still and uses it when this is absent or motion is reduced.
    ...(anchor.dataset.portalBadgeLive ? { liveMark: anchor.dataset.portalBadgeLive } : {}),
  };

  try {
    await loadScript(`${runtimeBase}freva-badge-content.js`);
    await loadScript(`${runtimeBase}freva-badge.js`);
  } catch {
    // A badge that cannot load is a missing credit line, not a broken portal.
    return;
  }

  const overlay = document.getElementById("portal-overlay-root");
  const root = document.querySelector<HTMLElement>(".fb");
  if (!root) return;
  if (overlay && !overlay.contains(root)) overlay.append(root);

  fitToFooter(anchor, root);
}

/**
 * The two lengths the badge takes from the page, and the space it takes back.
 *
 * `--fb-ftr-h` and `--fb-inset` are read from the footer itself rather than from a token name,
 * because the footer's height is a different token on a landing page than on an application view
 * and the badge should not have to know which it is on. The reserved width is measured from the
 * badge's own box, because it depends on how the visitor's browser set two words of type.
 */
function fitToFooter(anchor: HTMLElement, root: HTMLElement): void {
  const bar = document.querySelector<HTMLElement>(".portal-footer-bar");

  // The package's own inset, read once, before this file has written one. It is the floor for
  // everything below: the badge is drawn at this offset on an application view, where the portal
  // leaves it alone. Read rather than hardcoded, so a badge release that moves its own artwork
  // moves this with it.
  const packageInset = Number.parseFloat(getComputedStyle(root).getPropertyValue("--fb-inset"));
  const floor = Number.isFinite(packageInset) ? packageInset : 16;

  const apply = (): void => {
    if (bar) {
      const height = Math.round(bar.getBoundingClientRect().height);
      if (height > 0) {
        root.style.setProperty("--fb-ftr-h", `${height}px`);
        // The open panel sits into the footer rather than balanced on top of it: three-fifths
        // of the bar, plus the 8px the package leaves as a gap. A panel that stops exactly at
        // the chrome's edge reads as a second bar; one that overlaps reads as the mark grown.
        root.style.setProperty("--fb-pop-drop", `${Math.round(height * 0.6) + 8}px`);
      }
    }
    // Where the mark stands depends on whether it has company. On a document or a landing page
    // the footer bar carries the institution name and both sit in the chrome's centred column, so
    // the mark belongs in that column too, at the same gutter. On an application view the bar is
    // the mark and nothing else, the page below runs edge to edge, and a mark indented to a column
    // nothing else occupies looks lost - so it keeps the package's own 16px.
    const application = document.getElementById("portal-shell")?.dataset.view === "application";
    const gutter = bar ? Number.parseFloat(getComputedStyle(bar).paddingLeft) : Number.NaN;
    if (!application && Number.isFinite(gutter) && gutter > 0) {
      // The gutter is where the *disc* goes, not where the badge's box goes. The disc starts some
      // way into the mark's own 158x63 box - transparent artwork to its left - so insetting by the
      // gutter puts the bird about 50px right of the header's logo, which is what a reader's eye
      // lines it up against. The offset comes from `--fb-disc-x` rather than being guessed here.
      const discX = Number.parseFloat(getComputedStyle(root).getPropertyValue("--fb-disc-x"));
      // NEVER BELOW THE PACKAGE'S OWN INSET. `--fb-inset` is the left edge of the badge's whole
      // box and it moves the open panel too, which the CSS places at `calc(var(--fb-inset) - 6px)`.
      // The mark tolerates a small negative value because its artwork carries transparent margin
      // to the left of the disc; the panel does not, and slides off the side of the window.
      //
      // Unclamped the arithmetic is always negative: the disc sits 49.6px into the badge's box,
      // while the page's gutter is `clamp(16px, 2.4vw, 48px)` plus any centring the chrome adds -
      // and below the width at which centring begins there is none, so the gutter is at most 48px.
      // The difference is -15px at 1440, -23px at 1100 and -33px on a phone.
      //
      // So: line the disc up with the gutter where the gutter allows it, and otherwise fall back
      // to what the application view does. The mark then sits a little right of the header's logo
      // on a narrow window, which is a small imperfection; a sliced-off panel is a broken page.
      const inset = Math.max(floor, gutter - (Number.isFinite(discX) ? discX : 0));
      root.style.setProperty("--fb-inset", `${Math.round(inset * 100) / 100}px`);
    } else {
      root.style.removeProperty("--fb-inset");
    }

    // The mark's artwork carries about 3px of clear space below it, so this is what puts the
    // bird's feet on the page's bottom edge rather than three pixels above it.
    root.style.setProperty("--fb-mark-lift", "-3px");

    const badge = root.querySelector<HTMLElement>(".badge");
    if (!badge) return;
    // How much of the bar the badge actually covers, measured rather than assumed: the badge is
    // pinned to the viewport's left edge and the anchor starts at the bar's padding, so on a wide
    // screen the two barely overlap. Never negative, and never wider than the badge itself.
    const badgeRight = badge.getBoundingClientRect().right;
    const anchorLeft = anchor.getBoundingClientRect().left;
    const overlap = Math.ceil(Math.max(0, badgeRight - anchorLeft));
    anchor.style.width = `${overlap}px`;

    // HOW FAR THE MARK STANDS ABOVE THE BAR, for the surfaces that end there. The badge's own box
    // is exactly the bar's height, but the mark is not: 158x63 of artwork lifted to put the bird's
    // feet on the page's bottom edge, so it rises about 26px clear of a 34px application bar and
    // is painted from the portal's overlay layer - above the application region, whatever z-index
    // anything inside asks for. Bootstrap's own 1045 on a drawer cannot reach it.
    //
    // A panel that stops at the top of the bar therefore has its bottom-left corner covered, over
    // content such as the last rows of the STAC Browser's catalogue drawer, which it makes
    // unreadable and whose clicks it swallows. This is the number the shell reserves against -
    // measured from the mark itself, so a badge release that changes its artwork changes this too,
    // and never negative: a landing bar tall enough to contain the mark reserves nothing.
    const mark = root.querySelector<HTMLElement>(".badge__mark");
    const barTop = bar?.getBoundingClientRect().top;
    const markTop = mark?.getBoundingClientRect().top;
    const rise =
      barTop !== undefined && markTop !== undefined ? Math.ceil(Math.max(0, barTop - markTop)) : 0;
    document.documentElement.style.setProperty("--badge-rise", `${rise}px`);
  };

  apply();
  // Twice more: once after the badge's own webfont-free type has settled, and whenever the
  // viewport changes the bar's height or the page's gutter.
  requestAnimationFrame(apply);
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(apply).observe(document.documentElement);
  } else {
    window.addEventListener("resize", apply, { passive: true });
  }
}
