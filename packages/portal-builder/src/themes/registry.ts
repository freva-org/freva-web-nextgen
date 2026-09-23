// The theme registry. A preset is CSS custom properties and nothing else: there is no slot in
// this type for a site name, a logo, a route, an endpoint or a component choice, so "the theme
// enabled a feature" cannot happen by accident, and switching `preset: freva` to
// `preset: waterpark` provably changes only styling.

import { compareCodePoints } from "../util/order.js";

export interface ThemePreset {
  name: string;
  description: string;
  /** Design tokens as CSS custom properties, without the leading `--portal-`. */
  tokens: Record<string, string>;
  /** Generic, non-project decorative styling. */
  extraCss?: string;
  /**
   * A drawn backdrop this preset asks for. The one thing in a preset that is not purely a
   * stylesheet, and deliberately an enum of *decorations* rather than a switch a consumer can
   * point at arbitrary code. It reaches the runtime projection, which imports the named module
   * literally, so a portal on any other preset cannot contain a byte of it - the same rule
   * every optional component in this builder follows.
   */
  backdrop?: "contour" | "cosmos";
}

/**
 * The design's own values, restated as the closed token set. These are the light-theme values
 * from `freva-tokens.css`, so the default preset overrides the design with itself - which is to
 * say, does not override it. A preset that wants a different character changes these; the rest
 * of the stylesheet is not a preset's business.
 */
const BASE_TOKENS: Record<string, string> = {
  colorAccent: "#17324d",
  colorAccentContrast: "#f6f5f1",
  colorBackground: "#f6f5f1",
  colorSurface: "#fffef9",
  colorText: "#14202c",
  colorTextMuted: "#6f6f66",
  colorBorder: "#d8d6cd",
  density: "comfortable",
  cornerStyle: "soft",
  headingScale: "regular",
};

/**
 * Everything about how strongly the backdrop reads, as custom properties. The renderer reads
 * these off the document at every frame, so a deployment can retune the whole picture - or
 * switch a layer off with a `0` - without rebuilding anything but the stylesheet. The veil is
 * two numbers rather than one because it does two jobs: it is strongest directly behind the
 * reading column, where the copy has to win, and falls away towards the open half of the page,
 * which is the half the picture is for.
 */
const CONTOUR_CSS = `
:root {
  --portal-contour-minor: 0.08;
  --portal-contour-major: 0.16;
  --portal-contour-label: 0.24;
  --portal-contour-stripes: 0.14;
  --portal-contour-veil: 0.92;
  --portal-contour-veil-far: 0.06;
  --portal-contour-card: 0.94;
  --portal-contour-ink: 22, 32, 43;
  --portal-contour-ink-major: 15, 74, 92;
  --portal-contour-high: 169, 51, 31;
  --portal-contour-low: 15, 74, 92;
}
:root[data-theme="dark"] {
  --portal-contour-minor: 0.1;
  --portal-contour-major: 0.18;
  --portal-contour-label: 0.28;
  --portal-contour-stripes: 0.12;
  --portal-contour-veil: 0.88;
  --portal-contour-veil-far: 0.04;
  --portal-contour-card: 0.92;
  --portal-contour-ink: 168, 186, 195;
  --portal-contour-ink-major: 111, 195, 216;
  --portal-contour-high: 232, 139, 82;
  --portal-contour-low: 111, 195, 216;
}

/*
 * The backdrop sits behind the landing page and nothing else. Both canvases are inert and both
 * are drawn by the runtime; with no runtime - a build on any other preset - neither element
 * exists at all. A canvas is a replaced element, so \`inset: 0\` alone leaves it at its own
 * intrinsic size and the picture is drawn into a 300x150 box in the corner; the explicit width
 * and height are what make it the viewport.
 */
.portal-contour {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
}
/*
 * Below the veil, which is why this is -2 and the veil is -1: the band is the thing the copy
 * has to be lifted off, so a veil painted under it would be decoration with no job.
 */
.portal-contour-stripes {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  top: 0;
  z-index: -2;
  pointer-events: none;
}
/*
 * The veil: strongest behind the reading column, gone by the open side, so the copy sits on
 * paper and the picture keeps the space it was drawn for.
 *
 * Everything the page paints has to sit above the backdrop, not just the landing block. The
 * canvas is position:fixed at z-index 0, so an unpositioned sibling - the announcement bar,
 * which is a sibling of the main region rather than part of it - is painted *under* it and
 * comes out washed through the picture.
 */
.portal-shell[data-backdrop="contour"] .portal-announcements,
.portal-shell[data-backdrop="contour"] .portal-landing {
  position: relative;
  z-index: 1;
}
.portal-shell[data-backdrop="contour"] .portal-landing::before {
  content: "";
  position: absolute;
  inset: -24px -24px 0;
  z-index: -1;
  pointer-events: none;
  background: linear-gradient(
    100deg,
    rgb(from var(--bg) r g b / var(--portal-contour-veil)) 0%,
    rgb(from var(--bg) r g b / var(--portal-contour-veil)) 34%,
    rgb(from var(--bg) r g b / var(--portal-contour-veil-far)) 72%,
    rgb(from var(--bg) r g b / var(--portal-contour-veil-far)) 100%
  );
}
@supports not (color: rgb(from red r g b / 1)) {
  .portal-shell[data-backdrop="contour"] .portal-landing::before {
    background: linear-gradient(
      100deg,
      var(--bg) 0%,
      var(--bg) 34%,
      transparent 72%,
      transparent 100%
    );
    opacity: var(--portal-contour-veil);
  }
}
/* Cards keep their own surface, a shade off opaque so the picture shows. */
.portal-shell[data-backdrop="contour"] .portal-landing :is(.portal-card, .portal-panel-card, .portal-search) {
  background: rgb(from var(--surface) r g b / var(--portal-contour-card));
}
@media (prefers-reduced-transparency: reduce) {
  .portal-shell[data-backdrop="contour"] .portal-landing::before {
    background: var(--bg);
  }
}
`;

const COSMOS_CSS = `
/*
 * COSMOS: a cross-section of an observing system, drawn behind the landing page.
 *
 * The scene is not wallpaper - it is a continuous scientific story from orbit down to the ocean
 * floor, and the small things in it are the point: a scatterometer's beam, a lidar cone, a
 * +2 PVU contour, a CTD package on a wire. A single global opacity is the obvious way to make
 * text readable over it and the wrong one: those subjects vanish two or three percent before
 * the body copy becomes comfortable, leaving an unreadable page AND an empty scene.
 *
 * So the scene is drawn at full strength and readability is bought locally, per surface: the
 * hero gets a DIRECTIONAL veil, strongest behind the text column and fully transparent towards
 * the open side, which is the half the picture is for; cards, prose and the search control each
 * carry their own translucent surface; the landing container itself stays transparent; and
 * there is no page-level overlay, no blur over the canvas, and no derivation that pushes the
 * scene or the portal chrome towards black. Every number below is a custom property so the
 * balance can be retuned against screenshots without touching the renderer.
 */
:root {
  /* The scene is drawn at full strength. This is a deliberate constant, not a default to lower. */
  --portal-cosmos-scene-opacity: 1;
  /*
   * How much of the block's surface is surface, and how much is scene.
   *
   * The floor under these is measured rather than chosen: the worst case is MUTED body text over
   * the brightest thing the scene draws behind a block, the paper-coloured cross-section band at
   * rgb(255,246,234) in the dark theme. Against that, \`--ink-2\` measures 5.54:1 at 0.86, 4.90
   * at 0.82, 4.60 at 0.80 and 4.32 at 0.78 - so 0.78 is already below AA in the dark theme, and
   * these values sit a step above their own floor in each. The light theme has more room because
   * its surface is near-white and the scene's bright band is darker than it: the same
   * measurement there is 5.13:1 at 0.80.
   */
  --portal-cosmos-card-alpha: 0.78;
  --portal-cosmos-prose-alpha: 0.8;
  /*
   * The hero scrim: one black wash behind the copy, the same in both themes. Deliberately NOT
   * paired with a dark-theme override and deliberately not made of \`--surface\`, which is pale
   * in the light theme and would hang a grey slab in a starfield. Black at a low alpha is the
   * same substance in both modes because the thing behind it is the same in both modes: space.
   * It deepens the ground under the copy without becoming a panel.
   */
  --portal-cosmos-hero-scrim: 0.46;
  /*
   * THERE IS NO COSMOS READING COLUMN. The landing uses the shell's own measure system,
   * unchanged: a block is as wide as the page container, and \`.portal-prose\` caps paragraphs at
   * its 108ch exactly as it does in a document, because a landing carries what a documentation
   * page carries - wide code samples, card grids, link rows. Measured, a landing paragraph and a
   * documentation paragraph come out at the same 1099px and the same 108 characters at every
   * width from 1230 up.
   *
   * The scene is therefore read BETWEEN blocks rather than beside them, which is what the story
   * gaps below are for. That is a real trade: at 1440 the scene either side of a block is the
   * 35px gutter rather than 357px, and only above about 1700 does it open up again (286px at
   * 1920, 608px at 2560).
   */
  /*
   * Story spacing: how much vertical track each stage of the narrative is given. The lead is
   * deliberately short, because giving the orbit stage most of a screen before the hero opens
   * the landing on an empty sky. The hero belongs ON the orbit stage, which is what the
   * directional veil is shaped for; the track comes from the gaps and the tail.
   */
  --portal-cosmos-story-lead: clamp(32px, 6vh, 72px);
  /*
   * The gap between blocks is SPACING, not clearance. With the surfaces above letting the
   * picture through, the scene does not need a screen of its own between every two blocks, and a
   * page whose blocks are half a screen apart reads as an unfinished layout however good the
   * reason is. It is not measured in viewport heights either: a gap in \`vh\` separates content
   * by a fraction of the window, so the ratio of scene to content follows how tall someone's
   * browser is rather than what the page holds. This is the shell's own block rhythm - the same
   * \`clamp\` shape \`.portal-cards\` and \`.portal-links\` use for their own margins - with a
   * little more room, because there is still a picture behind it.
   */
  --portal-cosmos-story-gap: clamp(40px, 4.4vw, 84px);
  /*
   * The tail is the story's ending, not a screen of it. A length in viewport heights makes the
   * amount of EMPTY page a function of how tall someone's browser is rather than of what the
   * page holds: at 96vh, measured on the short landing at 1440x900, the run below the last block
   * came to 1972px - 2.19 screens, three times the whole ocean band - 864 of it from this one
   * declaration. What the tail is for is that the story should end on the ocean rather than on a
   * block, which needs a share of the water column: about a third of the ocean band, 940px at
   * its full height. The cap is what a tall browser gets; the floor keeps a short one from
   * ending flush against the last card.
   */
  --portal-cosmos-story-tail: clamp(96px, 34vh, 320px);
  /*
   * THE SCENE COMPRESSES; THE PAGE STRETCHES ONLY FAR ENOUGH TO BE SCROLLED.
   *
   * There is no aspect floor: the allocator in \`engine.js\`, given less than every band's
   * minimum at once, scales the three together rather than starving one, so the transect keeps
   * its full span from 50 hPa to the ocean floor and is drawn at a smaller aspect. A landing
   * shorter than 3.45 screens is the ordinary case rather than the edge one. The one bound that
   * is not about aspect is that the page has to be SCROLLABLE far enough to walk the story: the
   * renderer maps scroll position into the transect, so a landing that fits in one viewport
   * parks the reader at its first frame with orbit the only stage anyone sees. The engine clamps
   * its story to two viewports - H = max(docH, h * 2) - and this is the same number on the page.
   */
  --portal-cosmos-story-min: 200vh;
}
:root[data-theme="dark"] {
  --portal-cosmos-scene-opacity: 1;
  /* The binding theme: the scene's bright band is far lighter than the dark surface. */
  --portal-cosmos-card-alpha: 0.82;
  --portal-cosmos-prose-alpha: 0.84;
}

/*
 * The scene root. Inert, decorative, and behind everything.
 *
 * IT SPANS THE SHELL, and that is what makes it a story rather than a picture: the whole arc -
 * orbit, atmosphere, coast, ocean, seafloor - is laid out ONCE down the height of this element,
 * and a reader travels it by scrolling the page. There is no per-frame work in that; the layers
 * are ordinary absolutely positioned content. So the shell is the positioned ancestor, and it
 * names no chrome: the header and the footer are \`position: fixed\` at z-index 50 and 40 in the
 * base shell and stay exactly where they are - a theme may raise flow content over its own
 * backdrop and may not restate the positioning of chrome it does not own.
 */
.portal-shell[data-backdrop="cosmos"] {
  position: relative;
}
.portal-cosmos {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  opacity: var(--portal-cosmos-scene-opacity);
}

/*
 * THE SCENE'S OWN STRUCTURE. Everything below is static: it does not depend on the viewport,
 * the landing or the solved geometry, so it is a stylesheet the artifact serves rather than
 * rules the scene generates. That split is not tidiness: the portal's policy is
 * \`style-src 'self'\` with no \`'unsafe-inline'\`, and under it a \`<style>\` element created at
 * run time is refused, so the smaller the set of rules the scene has to construct, the less of
 * the drawing depends on that mechanism working. What the scene does generate - a few hundred
 * geometry-dependent keyframes - goes into a constructable stylesheet, which is CSSOM and not
 * subject to the directive at all.
 */
.portal-cosmos * {
  pointer-events: none;
}
/* The scene's sprites are drawn at a measured size; the shell's \`max-width: 100%\` is not for
   them, and applying it would shrink every baked drawing to its layer's width. */
.portal-cosmos img {
  max-width: none;
  max-height: none;
}
.portal-cosmos .lyr {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
}
.portal-cosmos .clip {
  overflow: hidden;
}
.portal-cosmos svg.lyr {
  overflow: visible;
}
.portal-cosmos .obj {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
}
/* \`.obj\` holds the iceberg's baked canvas. */
.portal-cosmos .obj img,
.portal-cosmos .obj canvas {
  position: absolute;
  display: block;
}

/*
 * ONE DRAWING. The scene is built for one sky and rebuilt when the reader changes it, so there
 * is nothing to cross-fade and nothing invisible to keep in step: no second set of images to
 * decode and hold, no second set of elements to style, no second set of composited layers. A
 * rebuild is the same single pass the page already makes on load.
 */

/*
 * MOTION: THERE IS NONE. A retained element carries NO animation object at all, which is a
 * stronger statement than carrying one that is paused: there is no keyframe to install, nothing
 * for a compositor to tick, and no attribute whose absence could quietly start something.
 * Reduced motion therefore needs no rule - it asked for no motion and the scene has none, in
 * every theme, in every tab, at every scroll position.
 */

/*
 * THE LABELS, and the caption that says what the drawing is. The fields are synthetic - built
 * from closed expressions in the renderer, not from a model run or a measurement - and a
 * contoured cross-section with instruments on it looks exactly like an analysis. The caption is
 * the drawing saying that it is not one, placed in the atmosphere band where the contours it is
 * about actually are.
 */
.portal-cosmos .lbl,
.portal-cosmos .cap {
  position: absolute;
  font:
    400 7.2px "IBM Plex Mono",
    ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  letter-spacing: 0.04em;
  white-space: nowrap;
  color: rgba(196, 214, 230, 0.85);
  text-shadow: 0 0 4px rgba(0, 0, 0, 0.9);
}
.portal-cosmos .lbl {
  transform: translate(-50%, 0);
}
.portal-cosmos .cap {
  font-size: 8.5px;
  text-align: right;
  padding-right: 16px;
  color: rgba(150, 168, 180, 0.75);
}
.portal-cosmos[data-sky="day"] .lbl {
  color: rgba(50, 58, 66, 0.9);
  text-shadow: 0 0 4px rgba(255, 255, 255, 0.95);
}
.portal-cosmos[data-sky="day"] .cap {
  color: rgba(110, 116, 120, 0.8);
  text-shadow: 0 0 4px rgba(255, 255, 255, 0.95);
}

/*
 * The quiet first frame. The scene kernel is a deferred chunk, so for a moment there is a canvas
 * with nothing in it; this is the sky it would have drawn, as a plain gradient, so the page
 * never flashes the page background and then swaps to a dark sky. The island clears the
 * attribute once it is running and sets \`unavailable\` if the chunk never arrives - in which
 * case this gradient is simply the backdrop, and the page is usable with no script at all.
 */
.portal-shell[data-backdrop="cosmos"] {
  background: linear-gradient(180deg, #0a1626 0%, #102a44 34%, #123049 60%, #0b2036 82%, #071726 100%);
}
/*
 * The light sky starts DARK, because the top of this scene is space in both themes. Opening on a
 * pale blue that the renderer then paints over with a starfield is a flash on every load, and
 * worse than a flash for a reader with no JavaScript: the hero type is light here, and light
 * type on a pale gradient is unreadable. The stops follow the renderer's own bands, which it
 * publishes as \`geom\`: space to about a third, the atmosphere to four fifths, the ocean below.
 */
:root[data-theme="light"] .portal-shell[data-backdrop="cosmos"],
:root:not([data-theme="dark"]) .portal-shell[data-backdrop="cosmos"] {
  background: linear-gradient(
    180deg,
    #0d1b2c 0%,
    #17304b 22%,
    #7ba3c4 34%,
    #dfeaf3 46%,
    #eaf1f6 66%,
    #cfe2f2 82%,
    #8fb6cf 100%
  );
}

/*
 * Content sits above the scene. The container itself is never a surface, and this names ONLY
 * the elements in normal flow: the header and the footer are \`position: fixed\` at z-index 50
 * and 40 in the base shell, already above the canvas at z-index 0, and naming them here would
 * be more specific than the base rule, win the cascade and make both \`position: relative\` -
 * scrolling the header away and taking the footer bar off the bottom of the viewport while the
 * independently fixed Freva badge stayed behind. A backdrop theme may raise flow content over
 * its canvas, and must not restate the positioning of chrome it does not own.
 */
.portal-shell[data-backdrop="cosmos"] .portal-announcements,
.portal-shell[data-backdrop="cosmos"] .portal-landing {
  position: relative;
  z-index: 1;
}
.portal-shell[data-backdrop="cosmos"] .portal-landing {
  background: transparent;
}

/*
 * STORY SPACING. The scene needs vertical track: orbit, atmosphere, the jet, the surface
 * facilities, the ocean and the ocean floor cannot all be told inside one viewport. The blocks a
 * consumer configured are the waypoints, and this is the space between them - added as padding
 * on the landing and as gaps between blocks, so no block is moved, rewritten or reordered. The
 * lead makes the orbit stage reachable and the tail makes the ocean floor reachable on a short
 * page; neither is an empty screen, because the scene is the content there.
 */
.portal-shell[data-backdrop="cosmos"] .portal-landing {
  padding-top: var(--portal-cosmos-story-lead);
  padding-bottom: var(--portal-cosmos-story-tail);
  /* Enough page to scroll the story, and not the story's own preferred aspect. */
  min-height: var(--portal-cosmos-story-min);
}
.portal-shell[data-backdrop="cosmos"] .portal-landing > * + * {
  margin-top: var(--portal-cosmos-story-gap);
}

/*
 * The hero row's own shape, on screens wide enough for two columns. The hero is the one row on a
 * landing that is genuinely a two-column composition; no other block is capped at a reading
 * column.
 */
@media (min-width: 64rem) {
  /*
   * THE HERO ROW IS NOT A READING COLUMN. It is already a two-column grid - copy on the left,
   * search box or dataset tree on the right - and capping it at a reading width divides 47 % of
   * the viewport into two, squeezing a 325 px paragraph column against a 294 px search card
   * while the other half of the page stands empty. The scene is kept clear here by the row's
   * right-hand column being a translucent surface, not by making the whole row narrow.
   *
   * The aside gets a floor rather than a fraction: 360 px is the width below which the search
   * field, its button and the dataset tree's toolbar start wrapping into each other, and the
   * floor is what the 900 px breakpoint needs. The fraction decides the shape above it, and the
   * aside takes a slightly larger share than the copy because a dataset tree wraps collection
   * names against their own descriptions where a search box - one field and one button - does
   * not. The gutter is close to the shell's own 4vw rather than spending 8 % of the row on a gap.
   */
  .portal-shell[data-backdrop="cosmos"] .portal-landing > .portal-hero-row[data-columns="two"] {
    grid-template-columns: minmax(0, 0.82fr) minmax(400px, 1.18fr);
    gap: clamp(40px, 4vw, 80px);
  }
  /*
   * …and only here does the scrim get its wider bleed back. The lead is the left column of that
   * grid, so the extra 0.6 of a gutter falls into the gap between the columns and never reaches
   * the window's edge. Desktop is unchanged to the pixel; every narrower case keeps the gutter.
   */
  .portal-shell[data-backdrop="cosmos"]
    .portal-landing
    > .portal-hero-row[data-columns="two"]
    .portal-hero-lead::before {
    inset: -7vh calc(-1.6 * var(--shell-pad, 2rem));
  }
}

/*
 * THE SURFACE STAGE NEEDS A CLEAR VIEWPORT. Between the atmosphere and the ocean the scene draws
 * the coast, the weather station, the lidar and radar facilities and the aircraft. A full-width
 * content surface across that band would hide exactly the objects the story is about, so the gap
 * before the final third is widened.
 */
.portal-shell[data-backdrop="cosmos"] .portal-landing > *:nth-child(2) {
  margin-top: calc(var(--portal-cosmos-story-gap) * 1.5);
}

/*
 * THE HERO SITS ON SPACE, SO ITS TYPE IS LIGHT. THERE IS NO VEIL.
 *
 * A pale gradient behind the copy is the obvious answer, the page ink being dark and the top of
 * this scene a starfield in both themes, and it is a grey slab with a soft edge hanging in the
 * sky next to two crisp panels. The honest composition is the one every photographic hero uses:
 * light type on the dark thing it is standing on. So the hero copy is near-white with a dark
 * halo, and the halo covers what a veil was really for - a bright object, the sun's limb or the
 * Milky Way, passing behind a line of text - while costing nothing over a dark sky. The colours
 * are literals rather than tokens on purpose: \`--ink\` follows the page theme, and this text is
 * on the scene, which is dark whichever theme the reader chose.
 *
 * The scrim itself is attached to the copy column, never to the row: on the row it would cover
 * the search box and the dataset tree, which carry their own surfaces, and two stacked is one
 * opaque slab where the scene should be. Here it sits behind the copy alone, bleeds out by
 * exactly the shell's gutter so it never adds horizontal scroll, and fades at every edge so it
 * reads as a deepening of the sky rather than a card somebody forgot to style.
 */
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-hero-lead,
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-hero {
  position: relative;
}
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-hero-lead::before,
.portal-shell[data-backdrop="cosmos"]
  .portal-landing
  .portal-hero:not(.portal-hero-lead .portal-hero)::before {
  content: "";
  position: absolute;
  /*
   * THE SIDEWAYS BLEED IS THE GUTTER, NOT A MULTIPLE OF IT.
   *
   * Below the two-column breakpoint there is no second column: the lead spans the content width,
   * 1.6 gutters is 25.6 px against a 16 px gutter, and the 9.6 px that do not fit are a
   * horizontal scrollbar on a phone, on a landing whose every other element is inside the fold.
   * Ten pixels of sideways scroll on a touch screen is a page that slides under the thumb
   * whenever a reader means to scroll down. So the default is the gutter, and the 1.6 applies
   * only where it is safe: a two-column hero, where the lead is the LEFT column and the extra
   * 0.6 spends itself in the gutter between the columns.
   */
  inset: -7vh calc(-1 * var(--shell-pad, 2rem));
  z-index: -1;
  pointer-events: none;
  /*
   * Painted flat and then MASKED, rather than drawn as a gradient. A gradient sized 120% x 100%
   * from a point 28% across puts the stop that reaches transparent outside the box on three
   * sides, and what renders is a slab with four hard edges hanging in the sky - the exact thing
   * the scrim exists to avoid. The mask is \`closest-side\`, centred, rather than radii of its
   * own: percentage radii have the same failure - an ellipse 82% wide centred 34% across reaches
   * zero at the right edge and 300px past the left one - and the box's proportions change with
   * the viewport, so any pair of numbers is right at one width and wrong at another.
   * \`closest-side\` puts the fade exactly on all four edges whatever the shape: no edge,
   * anywhere, at any size.
   */
  background: rgba(0, 0, 0, var(--portal-cosmos-hero-scrim));
  -webkit-mask-image: radial-gradient(
    ellipse closest-side at 50% 50%,
    rgb(0, 0, 0) 0%,
    rgba(0, 0, 0, 0.94) 55%,
    rgba(0, 0, 0, 0.58) 78%,
    rgba(0, 0, 0, 0) 100%
  );
  mask-image: radial-gradient(
    ellipse closest-side at 50% 50%,
    rgb(0, 0, 0) 0%,
    rgba(0, 0, 0, 0.94) 55%,
    rgba(0, 0, 0, 0.58) 78%,
    rgba(0, 0, 0, 0) 100%
  );
}

/*
 * The aside's own heading and summary are on the scene too. They sit above the card, not inside
 * it, so nothing is behind them but sky, and at \`--ink\` - near-black in the light theme - a
 * heading and a paragraph in dark navy over a starfield are legible only as a smudge. The
 * page-ink ring further down deliberately skips the hero row: over there the answer is a pale
 * ring, and here it is light type, so these join the hero's own copy rather than the page's.
 */
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-hero-heading,
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-hero-text,
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-hero-aside .portal-block-heading,
.portal-shell[data-backdrop="cosmos"]
  .portal-landing
  .portal-hero-aside
  .portal-dataset-tree-summary,
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-eyebrow {
  color: #f3f7fb;
  /*
   * A ring, then a wash. The eight one-pixel offsets carry the contrast: they put a near-opaque
   * dark edge immediately around every letterform, so the surface the eye compares each stroke
   * against is that edge and not whatever the scene is drawing behind it. Measured over the
   * brightest thing in the picture - the sun's limb, which the eyebrow crosses at some viewport
   * widths - that ring is what keeps the type readable. The two blurred layers after it are the
   * wash: nothing for contrast, everything for looks, so the copy sits in the sky rather than
   * reading as a hard sticker.
   */
  text-shadow:
    1px 0 0 rgba(6, 16, 28, 0.96),
    -1px 0 0 rgba(6, 16, 28, 0.96),
    0 1px 0 rgba(6, 16, 28, 0.96),
    0 -1px 0 rgba(6, 16, 28, 0.96),
    1px 1px 0 rgba(6, 16, 28, 0.96),
    -1px 1px 0 rgba(6, 16, 28, 0.96),
    1px -1px 0 rgba(6, 16, 28, 0.96),
    -1px -1px 0 rgba(6, 16, 28, 0.96),
    0 2px 12px rgba(6, 16, 28, 0.8),
    0 0 30px rgba(6, 16, 28, 0.6);
}
/* The eyebrow is small and set in caps; it needs the contrast more, not less. */
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-eyebrow {
  color: #cfe0ee;
}

/*
 * The secondary call to action is an outline button on the page, and an outline in the page's ink
 * disappears against the sky. It gets the same treatment as the copy: light outline, light label,
 * and a dark scrim of its own so it stays a button rather than becoming a floating word.
 */
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-hero-actions .portal-button {
  color: #f3f7fb;
  border-color: rgba(243, 247, 251, 0.66);
  background: rgba(9, 20, 33, 0.42);
  backdrop-filter: saturate(1.1) blur(2px);
  text-shadow: 0 1px 2px rgba(6, 16, 28, 0.75);
}
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-hero-actions .portal-button:hover {
  background: rgba(9, 20, 33, 0.62);
  border-color: rgba(243, 247, 251, 0.86);
}
/*
 * The primary button keeps the deployment's accent, which is a fill and reads on its own, and it
 * needs its own hover too. The rule above paints every hero button with the dark scrim on hover,
 * and .portal-button:hover and .portal-button-primary carry the same specificity, so on source
 * order the scrim wins and the primary call to action becomes a near-black rectangle with the
 * accent's dark ink still on it at 1.02:1 - a label that is simply not there. The hover fill and
 * the ink measured for that fill are both named here.
 */
.portal-shell[data-backdrop="cosmos"]
  .portal-landing
  .portal-hero-actions
  .portal-button-primary {
  color: var(--accent-ink);
  background: var(--accent);
  border-color: var(--accent);
  text-shadow: none;
}
.portal-shell[data-backdrop="cosmos"]
  .portal-landing
  .portal-hero-actions
  .portal-button-primary:hover {
  color: var(--accent-hi-ink);
  background: var(--accent-hi);
  border-color: var(--accent-hi);
}

/*
 * Per-surface readability: each element carries its own, and only where there is text.
 * Everything below is scoped through \`.portal-landing\`, which is belt AND braces on purpose.
 * The attribute these rules hang off is written only where a landing is rendered, but a rule
 * that WOULD repaint a prose page if it ever reappeared is a landmine, and the shell has one
 * attribute for two backdrops and more presets to come.
 */
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-card,
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-search-block,
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-feature-link,
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-links li {
  background: color-mix(
    in srgb,
    var(--surface) calc(var(--portal-cosmos-card-alpha) * 100%),
    transparent
  );
  backdrop-filter: saturate(1.1);
}
/*
 * ONE surface per block, not two. On a landing the prose is always INSIDE the content block -
 * \`Blocks.astro\` renders the heading and then a \`.portal-prose\` div in the same section - so
 * naming both would paint twice, and two coats of 0.93 composite to 0.9951: the scene showing
 * through at 0.49%, not the 7% the number says, with the inner coat visible as a paler rectangle
 * around the paragraphs. The block carries the surface and prose inside it carries none; a
 * \`.portal-prose\` that is a direct child of the landing would still get one.
 */
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-content-block,
.portal-shell[data-backdrop="cosmos"] .portal-landing > .portal-prose {
  background: color-mix(
    in srgb,
    var(--surface) calc(var(--portal-cosmos-prose-alpha) * 100%),
    transparent
  );
}
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-content-block .portal-prose {
  background: transparent;
}
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-content-block {
  border-radius: var(--r-12, 0.75rem);
  padding: 1.25rem 1.5rem;
}

/*
 * The opaque things INSIDE a block, where the alphas above would otherwise be spent for
 * nothing. A card grid paints \`--surface-2\` across itself and the cards sit on top, so
 * lowering \`--portal-cosmos-card-alpha\` buys nothing and a cards row hides the scene whatever
 * the number says; an admonition is one opaque surface with a transparent body, so the same
 * holds for every callout. The grid keeps its border, its radius and the hairlines between
 * cards - those are the grid, not the ground - and gives up only the fill.
 */
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-card-grid {
  background: transparent;
}
.portal-shell[data-backdrop="cosmos"] .portal-landing .portal-admonition {
  background: color-mix(
    in srgb,
    var(--surface) calc(var(--portal-cosmos-prose-alpha) * 100%),
    transparent
  );
}
/*
 * A code block stays opaque, deliberately. Syntax colouring is the one place on a landing where
 * hue carries meaning, and a moving picture behind six token colours is interference rather than
 * a background. The block it sits in is translucent; the sample itself is not.
 */

/*
 * A block heading has no surface of its own. \`.portal-cards\`, \`.portal-links\` and
 * \`.portal-admonition\` put their heading OUTSIDE the panel, on the page - which on this preset
 * means on the scene. Measured against the brightest thing drawn under them, those headings run
 * at 3.10:1 in the light theme and 1.47:1 in the dark one, where a near-white heading over the
 * paper-coloured cross-section band is invisible.
 *
 * So they get the hero's letterform outline at a smaller size. The ring is the theme's own
 * surface colour rather than the hero's fixed dark, because a block heading is \`--ink\`: dark on
 * a pale ring in the light theme, pale on a dark ring in the dark one. A panel behind every
 * heading would have put a bar across the picture above every card row.
 */
.portal-shell[data-backdrop="cosmos"] .portal-landing > :not(.portal-hero-row) > .portal-block-heading {
  text-shadow:
    1px 0 0 var(--surface),
    -1px 0 0 var(--surface),
    0 1px 0 var(--surface),
    0 -1px 0 var(--surface),
    1px 1px 0 var(--surface),
    -1px 1px 0 var(--surface),
    1px -1px 0 var(--surface),
    -1px -1px 0 var(--surface),
    0 0 14px var(--surface);
}
/* Inside a surfaced block the heading is already on paper, and a ring there is just a fuzz. */
.portal-shell[data-backdrop="cosmos"]
  .portal-landing
  > :is(.portal-content-block, .portal-admonition)
  > .portal-block-heading {
  text-shadow: none;
}

/*
 * Reduced transparency makes the SURFACES more opaque. It does not touch the scene: the
 * preference is about text over texture, not about whether a picture may exist, and deleting or
 * blackening the scene would answer a question nobody asked.
 */
@media (prefers-reduced-transparency: reduce) {
  :root,
  :root[data-theme="dark"] {
    --portal-cosmos-card-alpha: 1;
    --portal-cosmos-prose-alpha: 1;
  }
  /*
   * The hero's scrim deepens and its outline goes fully opaque. It does not become a solid
   * panel: a black rectangle across the sky would answer a question nobody asked.
   */
  :root,
  :root[data-theme="dark"] {
    --portal-cosmos-hero-scrim: 0.62;
  }
  .portal-shell[data-backdrop="cosmos"] .portal-landing .portal-hero-heading,
  .portal-shell[data-backdrop="cosmos"] .portal-landing .portal-hero-text,
  .portal-shell[data-backdrop="cosmos"] .portal-landing .portal-hero-aside .portal-block-heading,
  .portal-shell[data-backdrop="cosmos"]
    .portal-landing
    .portal-hero-aside
    .portal-dataset-tree-summary,
  .portal-shell[data-backdrop="cosmos"] .portal-landing .portal-eyebrow {
    text-shadow:
      1px 0 0 rgb(6, 16, 28),
      -1px 0 0 rgb(6, 16, 28),
      0 1px 0 rgb(6, 16, 28),
      0 -1px 0 rgb(6, 16, 28),
      1px 1px 0 rgb(6, 16, 28),
      -1px 1px 0 rgb(6, 16, 28),
      1px -1px 0 rgb(6, 16, 28),
      -1px -1px 0 rgb(6, 16, 28),
      0 2px 14px rgb(6, 16, 28),
      0 0 34px rgb(6, 16, 28);
  }
  .portal-shell[data-backdrop="cosmos"] .portal-landing .portal-hero-actions .portal-button {
    background: rgb(9, 20, 33);
    backdrop-filter: none;
  }
  /* The opaque scrim is for the OUTLINE button. The primary is a fill and keeps being one. */
  .portal-shell[data-backdrop="cosmos"]
    .portal-landing
    .portal-hero-actions
    .portal-button-primary {
    background: var(--accent);
  }
  .portal-shell[data-backdrop="cosmos"]
    .portal-landing
    .portal-hero-actions
    .portal-button-primary:hover {
    background: var(--accent-hi);
  }
}

@media (max-width: 48rem) {
  :root {
    /* A phone cannot afford five viewports of lead-in; the story is tightened, not removed. */
    --portal-cosmos-story-lead: clamp(24px, 4vh, 40px);
    /*
     * THE GAP IS SPACING ON A PHONE TOO, so the phone takes the same declaration as everything
     * else - \`clamp(40px, 4.4vw, 84px)\`, landing on its 40px floor at phone widths. A gap in
     * \`vh\` separates content by a fraction of the WINDOW rather than by what the page holds,
     * which reads worse on a phone because the window is the smaller of the two: 40vh is 338px
     * between every pair of blocks on an 844px screen, four empty screens down a landing of six.
     * The 40px floor is still more than the 28px \`.portal-cards\` and \`.portal-links\` give
     * their own margins at that width, and the scene loses nothing, because the story is solved
     * against whatever height the page turns out to be and \`--portal-cosmos-story-min\` still
     * guarantees two screens of scroll. The tail is the same shape as the desktop's and lands
     * smaller for the same reason: 74vh would be 625px of empty water below the last block on an
     * 844px screen, three quarters of a screen to scroll after the content has finished.
     */
    --portal-cosmos-story-tail: clamp(72px, 34vh, 240px);
  }
}

`;

export const THEME_PRESETS: Record<string, ThemePreset> = {
  /**
   * The main Freva theme: the known-good portal's own presentation. `default` and `freva` are
   * the same preset under two names, because the design *is* the default.
   */
  default: {
    name: "default",
    description: "The Freva portal design: the main theme, and the framework's default.",
    tokens: { ...BASE_TOKENS },
  },
  freva: {
    name: "freva",
    description: "The Freva portal design. Identical to 'default', under its own name.",
    tokens: { ...BASE_TOKENS },
  },
  /**
   * A drawn backdrop: pressure contours over a warming-stripe band. The palette is the one the
   * drawing was designed against - a warm paper ground and a deep teal ink - because a backdrop
   * and the page over it are one picture. Everything about *how much of it you see* is a custom
   * property below, so the balance can be tuned without touching the renderer.
   */
  contour: {
    name: "contour",
    description: "Animated pressure contours and a warming-stripe band behind the landing page.",
    backdrop: "contour",
    tokens: {
      ...BASE_TOKENS,
      colorAccent: "#0f4a5c",
      colorBackground: "#f7f6f3",
      colorSurface: "#fffdf8",
      colorText: "#16202b",
      colorTextMuted: "#6b6b66",
      colorBorder: "#e0dcd4",
      cornerStyle: "soft",
      headingScale: "expressive",
    },
    extraCss: CONTOUR_CSS,
  },
  /**
   * A drawn backdrop: a cross-section of an observing system, from orbit to the ocean floor. The
   * palette is a night-sky one because the story starts in space, but the scene is drawn at full
   * strength in both modes and readability is bought locally rather than by dimming it -
   * `COSMOS_CSS` explains the composition. Everything about the balance is a custom property.
   */
  cosmos: {
    name: "cosmos",
    description:
      "An animated cross-section of an observing system - orbit to ocean floor - behind the landing page.",
    backdrop: "cosmos",
    tokens: {
      ...BASE_TOKENS,
      // Dark enough that everything the chrome puts on top of it clears 4.5:1. #2f7fb5 gives
      // 4.35 against white for the brand name, and #2a76ac 4.29 for the footer badge's small
      // near-white caption, which sits on the same fill; this one measures 5.9 against white
      // and 5.2 against the badge's #eaf1f7, so both pass without touching the badge.
      colorAccent: "#26699a",
      colorBackground: "#0b1522",
      colorSurface: "#101d2c",
      colorText: "#eaf1f7",
      colorTextMuted: "#93a6b8",
      colorBorder: "#22384d",
      cornerStyle: "soft",
      headingScale: "expressive",
    },
    extraCss: COSMOS_CSS,
  },
  waterpark: {
    name: "waterpark",
    description: "A teal variant of the Freva design. A registered visual preset, nothing more.",
    tokens: {
      ...BASE_TOKENS,
      colorAccent: "#0a6c74",
      colorBorder: "#c6e0e0",
      density: "spacious",
      cornerStyle: "round",
      headingScale: "expressive",
    },
  },
};

const DENSITY_SCALE: Record<string, string> = {
  compact: "0.75rem",
  comfortable: "1rem",
  spacious: "1.35rem",
};

const CORNER_SCALE: Record<string, string> = {
  sharp: "0",
  soft: "6px",
  round: "14px",
};

const HEADING_SCALE: Record<string, string> = {
  modest: "1.15",
  regular: "1.25",
  expressive: "1.4",
};

export function themeNames(): string[] {
  return Object.keys(THEME_PRESETS).sort();
}

function mix(a: string, b: string, weight: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  const blend = [
    ar * weight + br * (1 - weight),
    ag * weight + bg * (1 - weight),
    ab * weight + bb * (1 - weight),
  ];
  return `#${blend.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

// The palette for the header and the footer, which are one surface filled with the deployment's
// main colour. These are computed here rather than with `color-mix` in the stylesheet because
// every one of them is a contrast decision and CSS cannot make one. A "quieter" text tone on a
// coloured bar is only available when the bar is dark enough to afford it: mixing the ink
// towards a mid-saturation teal produces a tone that looks right and measures 3.8:1. So the
// secondary tones are stepped back towards the fill only as far as they can go while still
// clearing 4.5:1 on the bar *and* on the chips drawn on it - which for a light accent is not
// far, and there the difference is carried by size and letter-spacing instead.

/**
 * The ink on the bars. White, always. Not a token a consumer can set and not a value anything
 * derives: the header and the footer are the deployment's main colour with white on them, which
 * is the design as approved.
 */
const CHROME_INK = "#ffffff";

/**
 * What white actually measures on a deployment's bars. Exported so a test can report the number
 * rather than enforce one: a fill that white does not clear 4.5:1 on is a question about the
 * deployment's colour, and answering it here produces a bar nobody recognises.
 */
export function chromeContrast(accent: string): number | undefined {
  return isHex(accent) ? contrast(CHROME_INK, accent) : undefined;
}

function chromeTokens(accent: string): string[] {
  if (!isHex(accent)) return [];
  const bg = accent;
  // The bars are the deployment's colour, flat, with white on them. Both halves of that are
  // fixed, not chosen: the fill is the accent exactly - nothing derives a different colour from
  // it, and nothing composites it against the page - and the ink is white, rather than
  // whichever of the two inks measures higher. Picking by measurement is what puts near-black
  // text on a saturated teal bar; the contrast of white on the accent is a decision about the
  // accent, not about this function, and `chromeContrast` reports it without adjusting it.
  const ink = CHROME_INK;
  // Chips have to move *away* from the ink, or the text on them loses contrast:
  // a dark bar with light ink gets darker chips, a light bar gets lighter ones.
  const overlay = contrast(ink, "#ffffff") > contrast(ink, "#000000") ? "#ffffff" : "#000000";
  const chip = mix(overlay, bg, 0.14);
  const chipHi = mix(overlay, bg, 0.26);
  const line = mix(ink, bg, 0.2);
  const lineHi = mix(ink, bg, 0.38);
  const surface = mix(overlay, bg, 0.16);

  /** The quietest step back towards the fill that still reads on every surface. */
  const stepBack = (floor: number): string => {
    for (let weight = floor; weight <= 100; weight += 2) {
      const candidate = mix(ink, bg, weight / 100);
      if (
        contrast(candidate, bg) >= 4.5 &&
        contrast(candidate, chip) >= 4.5 &&
        contrast(candidate, chipHi) >= 4.5 &&
        contrast(candidate, surface) >= 4.5
      ) {
        return candidate;
      }
    }
    return ink;
  };

  return [
    `  --chrome-bg: ${bg};`,
    `  --chrome-ink: ${ink};`,
    `  --chrome-ink-2: ${stepBack(70)};`,
    `  --chrome-muted: ${stepBack(56)};`,
    `  --chrome-line: ${line};`,
    `  --chrome-line-hi: ${lineHi};`,
    `  --chrome-chip: ${chip};`,
    `  --chrome-chip-hi: ${chipHi};`,
    `  --chrome-surface: ${surface};`,
  ];
}

/**
 * Which reference custom property each closed token drives. The restored stylesheet is the
 * design and a preset does not restate it: it sets the same three colours the known-good portal
 * let a deployment own - the accent, its hover, the strong rule - plus the ink that has to stay
 * readable on an accent fill. Everything else in `freva-tokens.css` is the design's and no
 * preset reaches it, which is what keeps "the theme enabled a feature" and "the theme redrew the
 * page" both impossible.
 */
const TOKEN_TO_PROPERTY: Record<string, string> = {
  colorAccent: "--accent",
  colorAccentContrast: "--accent-ink",
  colorBorder: "--line-2",
  colorBackground: "--bg",
  colorSurface: "--surface",
  colorText: "--ink",
  colorTextMuted: "--muted",
};

/**
 * The two inks the shell puts on an accent fill, from the design tokens. Fixed literals, exactly
 * as in the known-good portal: whatever accent a preset or a consumer chooses, the text on top
 * of it is one of these two. The choice is made here, at build time, by the same contrast rule
 * the runtime portal applied, so an accent that would be unreadable in one theme gets the other
 * ink rather than becoming unreadable text.
 */
const ACCENT_INK = { light: "#f6f5f1", dark: "#0b1117" } as const;
/**
 * The worst surface accent-coloured *text* actually lands on. Not the page background: a link
 * inside an admonition or a card sits on a raised surface, and in the dark theme every raised
 * surface is *lighter* than the page, so a colour measured against the page alone fails on the
 * very surfaces links appear on most. In the light theme raised surfaces are darker, so the page
 * is already the worst case there.
 */
const TEXT_BG = { light: "#f6f5f1", dark: "#243040" } as const;
const PAGE_INK = { light: "#14202c", dark: "#e9eef3" } as const;

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

const isHex = (value: string): boolean => /^#[0-9a-fA-F]{6}$/.test(value);

/** The readable ink for text sitting on this accent. */
function inkOn(accent: string, mode: "light" | "dark"): string {
  if (!isHex(accent)) return ACCENT_INK[mode];
  return contrast(accent, ACCENT_INK.light) >= contrast(accent, ACCENT_INK.dark)
    ? ACCENT_INK.light
    : ACCENT_INK.dark;
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / d + 2) / 6
        : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  if (s === 0) {
    const v = Math.round(l * 255);
    return `#${[v, v, v].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const rgb = [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((c) =>
    Math.max(0, Math.min(255, Math.round(c * 255))),
  );
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The accent as *text* on the page background.
 *
 * The accent as a fill and the accent as text have opposite requirements: a navy that is perfect
 * on a button is unreadable on a dark page. Falling back to the page ink makes the deployment's
 * colour vanish in one theme, so a link that is unmistakably "the portal's colour" by day turns
 * into ordinary body text by night and the site reads as two different products. So the hue and
 * the saturation are kept and only the *lightness* moves, one percent at a time, until the
 * colour is readable where it is being used.
 */
function accentTextFor(accent: string, mode: "light" | "dark"): string {
  if (!isHex(accent)) return accent;
  const bg = TEXT_BG[mode];
  if (contrast(accent, bg) >= 4.5) return accent;
  const [h, sat, l] = toHsl(accent);
  const towards = mode === "dark" ? 1 : 0;
  for (let step = 1; step <= 100; step += 1) {
    const candidate = fromHsl(h, sat, l + (towards - l) * (step / 100));
    if (contrast(candidate, bg) >= 4.5) return candidate;
  }
  return PAGE_INK[mode];
}

/**
 * The tokens the schema accepts and this function does not apply, and why.
 *
 * A preset states all seven colours because they describe its character, and three of the five
 * presets state values that are only true of one theme - the Cosmos preset's `colorBackground`
 * is `#0b1522`, a night sky. Emitting those into `--bg`, `--surface`, `--ink` and `--muted`
 * would repaint the light theme with dark values, which is why the loop below skips them. That
 * is a reason to drop a PRESET's value and not a reason to accept a CONSUMER's and say nothing,
 * so the names are exported and the diagnostic that reports it cannot drift from the code that
 * does it.
 */
export const UNAPPLIED_TOKENS: Record<string, string> = {
  colorBackground: "--bg",
  colorSurface: "--surface",
  colorText: "--ink",
  colorTextMuted: "--muted",
};

export function resolveThemeCss(
  presetName: string,
  overrides: Record<string, string> | undefined,
): {
  tokens: Record<string, string>;
  css: string;
  backdrop?: "contour" | "cosmos";
  /** Consumer-supplied token names this call accepted and did not apply. */
  unapplied: string[];
} {
  const preset = THEME_PRESETS[presetName];
  if (!preset) throw new Error(`Unknown theme preset '${presetName}'.`);
  const tokens = { ...preset.tokens, ...(overrides ?? {}) };

  // The closed token block is the consumer-facing contract and is emitted verbatim.
  const declarations: string[] = [];
  for (const [key, value] of Object.entries(tokens).sort(([a], [b]) => compareCodePoints(a, b))) {
    declarations.push(`  --portal-${kebab(key)}: ${value};`);
  }
  declarations.push(`  --portal-space: ${DENSITY_SCALE[tokens.density ?? "comfortable"]};`);
  declarations.push(`  --portal-radius: ${CORNER_SCALE[tokens.cornerStyle ?? "soft"]};`);
  declarations.push(
    `  --portal-heading-scale: ${HEADING_SCALE[tokens.headingScale ?? "regular"]};`,
  );

  // Then the mapping onto the design's own properties, per theme, so a preset changes colour
  // without any stylesheet knowing a preset exists.
  const light: string[] = [];
  const dark: string[] = [];
  for (const [token, property] of Object.entries(TOKEN_TO_PROPERTY)) {
    const value = tokens[token];
    if (value === undefined) continue;
    // Background, surface, text and muted are the design's in both themes; a preset that set
    // them would repaint dark mode with light values.
    if (property === "--bg" || property === "--surface" || property === "--ink") continue;
    if (property === "--muted") continue;
    if (property === "--accent-ink") continue;
    light.push(`  ${property}: ${value};`);
  }
  const accent = tokens.colorAccent;
  if (accent !== undefined) {
    light.push(`  --accent-ink: ${inkOn(accent, "light")};`);
    light.push(`  --accent-text: ${accentTextFor(accent, "light")};`);
    // The chrome palette is the same in both themes: the bars are the main colour, so what
    // reads on them does not depend on the page behind them.
    light.push(...chromeTokens(accent));
    // The accent is the deployment's in both themes, exactly as the design applies it: it is a
    // *fill* colour, and readability of accent-coloured *text* is what `--accent-text` is for.
    dark.push(`  --accent: ${accent};`);
    dark.push(`  --accent-ink: ${inkOn(accent, "dark")};`);
    dark.push(`  --accent-text: ${accentTextFor(accent, "dark")};`);

    // The hover state of an accent-filled control, derived as a step in the deployment's own
    // hue: away from the page in the light theme, towards it in the dark one, far enough to
    // read as a state change and not so far as to read as a different control. A fixed pair in
    // the stylesheet would put the design's own near-black navy under the pointer on every
    // primary button in a teal portal, and on the Data Browser's accent-2 and the STAC
    // browser's link hover, which both alias it.
    //
    // The design's own accent keeps the design's own hand-picked pair: no weight reproduces
    // `#0d2438` from `#17324d` exactly - it is slightly hue shifted, not simply darkened - and
    // approximating a value somebody chose by eye is not an improvement on it.
    if (accent.toLowerCase() !== BASE_TOKENS.colorAccent!.toLowerCase()) {
      // And its own ink: `--accent-hi` is a different fill from `--accent`, so the ink measured
      // against `--accent` is not the ink for it. Waterpark's teal shows it - `#009688` takes
      // the dark ink at 5.17, and its light-theme hover `#006c62` takes that same dark ink at
      // 2.94, which turns the primary call to action dark and loses its label under the
      // pointer. Measured separately, the hover fill takes the light ink at 5.85.
      const lightHi = mix(accent, "#000000", 0.72);
      const darkHi = mix(accent, "#ffffff", 0.88);
      light.push(`  --accent-hi: ${lightHi};`);
      light.push(`  --accent-hi-ink: ${inkOn(lightHi, "light")};`);
      dark.push(`  --accent-hi: ${darkHi};`);
      dark.push(`  --accent-hi-ink: ${inkOn(darkHi, "dark")};`);
    }
  }

  const blocks = [`:root {\n${declarations.join("\n")}\n}`];
  if (light.length > 0) blocks.push(`:root {\n${light.join("\n")}\n}`);
  if (dark.length > 0) blocks.push(`:root[data-theme="dark"] {\n${dark.join("\n")}\n}`);
  const css = `${blocks.join("\n")}\n${preset.extraCss ?? ""}`;
  // Only what the CONSUMER supplied: a preset stating its own character is not a surprise, a
  // deployment setting a value and getting nothing is.
  const unapplied = Object.keys(UNAPPLIED_TOKENS).filter((name) => overrides?.[name] !== undefined);
  return {
    tokens,
    css,
    unapplied,
    ...(preset.backdrop ? { backdrop: preset.backdrop } : {}),
  };
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
