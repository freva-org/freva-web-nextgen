// cosmos.ts - the Cosmos backdrop island.
//
// This file is the whole boundary between the portal and the scene builder. It is small, strict
// and readable; `cosmos/scene.js` is large, numeric and untyped, and the two are kept apart on
// purpose (see `cosmos/scene.d.ts`).
//
// THE SCENE IS STILL. It is built once into elements - a baked canvas, SVG, and three exported
// images - and then nothing happens to it: no frame loop, no keyframe, no animation object,
// nothing on a compositor's tick list. So there is no "stop when nobody is looking" machinery
// here - no `visibilitychange` listener, no IntersectionObserver over the stage strips, no
// reduced-motion query - because reduced motion needs no rule when there is no motion to reduce.
//
// What is left here is the four things the scene cannot know about itself:
//
//  1. THE STORY IS SCOPED TO THE SHELL. The scene element spans the Cosmos shell, which is as tall
//     as the landing standing on it, so the whole orbit-to-seafloor arc is laid out against the
//     page it belongs to and nothing outside it can shift the timing.
//
//  2. THE BUILDER IS LOADED ON DEMAND. The static import graph reaches this module only in a
//     Cosmos build, and this module fetches the scene only when it finds a Cosmos root - so a
//     documentation page in a Cosmos portal never downloads it, and no other preset contains it.
//
//  3. THE SCENE FOLLOWS THE PORTAL'S THEME. Only the sky being looked at is built, so flipping the
//     theme draws the other one - once, in the same single pass the page already does on load, and
//     one frame AFTER the page itself has changed colour. It fetches nothing and does not move the
//     reader's scroll position.
//
//  4. IT REBUILDS FOR A CHANGE OF SHAPE, AND ONLY FOR ONE. See `onResize` below.

import type { CosmosScene, SceneGeom } from "./cosmos/scene.js";
import type * as CosmosSceneModule from "./cosmos/scene.js";

/** The scene module, as its declaration file describes it. */
type SceneBuilder = typeof CosmosSceneModule;

/**
 * How long to wait after a resize settles before rebuilding. A drag of a window edge is a
 * continuous stream of resize events, so the debounce is what keeps a drag from being a hundred
 * builds. The value is the standalone study's.
 */
const RESIZE_SETTLE_MS = 280;

/**
 * Mount the Cosmos backdrop. Returns a disposer, and is safe to call on any route: without a Cosmos
 * root it does nothing, which is how documentation, Data Browser, STAC and error pages keep the
 * Cosmos palette without ever building the scene.
 */
export function mountCosmosBackdrop(): () => void {
  const host = document.querySelector<HTMLElement>(".portal-cosmos");
  if (!host) return () => {};

  // Narrowed once, here: the guard above cannot narrow for the nested `start`, and threading `!`
  // through every use would put an assertion where a fact already exists.
  const sceneHost: HTMLElement = host;
  const root = document.documentElement;
  let disposed = false;
  /** Populated once the builder arrives; every teardown path checks it. */
  let teardown: (() => void) | null = null;

  // The sky follows the portal's theme, and is set BEFORE the scene is built and before every
  // rebuild. The attribute is the INPUT to the drawing: the scene reads it once per build and
  // constructs that sky and no other, so setting it afterwards builds the night scene on a light
  // portal. Returns whether it changed, which tells a theme flip from the other reasons this runs.
  const applySky = (): boolean => {
    const sky = root.dataset.theme === "dark" ? "night" : "day";
    if (sceneHost.dataset.sky === sky) return false;
    sceneHost.dataset.sky = sky;
    return true;
  };
  applySky();

  // ONE RENDERER, AND NO WAY TO ASK FOR ANOTHER: there is one `cosmos/scene.js` and no query
  // parameter that selects a different one. A landing URL cannot silently load an animated
  // renderer because the repository contains none, which is a stronger guarantee than a default
  // that happens to point the right way.
  void import("./cosmos/scene.js")
    .then((module) => {
      // The reader may have navigated away, or the page been torn down, while the chunk was in
      // flight. Building now would leave elements nobody can remove.
      if (disposed) return;
      teardown = start(module as SceneBuilder);
    })
    .catch((error: unknown) => {
      // A scene that fails to load is a page without a background, not a broken page: the theme's
      // own sky gradient is already under it.
      console.warn("cosmos: the scene could not be loaded", error);
      root.dataset.portalCosmos = "unavailable";
    });

  function start(module: SceneBuilder): () => void {
    const { CONFIG, mountCosmosScene } = module;

    // Where the object bodies live. The builder stamps this on the element because only the build
    // knows the hashed artifact path; the module's own default is a relative directory.
    const assetBase = sceneHost.dataset.portalCosmosAssets;
    if (assetBase) CONFIG.assetBase = assetBase.endsWith("/") ? assetBase : `${assetBase}/`;

    const scene: CosmosScene = mountCosmosScene(sceneHost);

    // The scene is drawn and it is finished: `ready` is the only state a built scene has.
    // `unavailable` above is the other one, and says the chunk did not load and the page is
    // showing the theme's sky gradient alone.
    root.dataset.portalCosmos = "ready";

    // theme
    //
    // Following the portal's `data-theme` is a REBUILD, because the scene holds ONE sky: `applySky`
    // writes the attribute the builder reads and the builder draws that sky. That buys having only
    // one sky in the document - no second set of images to decode and hold, no second set of
    // layers, nothing invisible to keep in step. Scroll position is untouched: the scene is
    // `position: absolute` inside the shell whose height its content sets, so replacing the
    // scene's children moves no flow box.
    //
    // AND THE PAGE DOES NOT WAIT FOR IT. Baking in the same task as the attribute write blocks the
    // paint: on the Waterpark landing that is 19 canvases baked to `data:` PNGs, 5.6 Mpx, 200ms
    // inside `toDataURL` and 456-516ms from the switch to the next frame with nothing on the page
    // changing colour. None of that is the theme - `data-theme` and `data-sky` are already on the
    // elements, so the palette, the chrome and the sky gradient are decided and the frame carrying
    // them is ready. Only the DRAWING is made again, after that frame.
    //
    // A FRAME AND THEN A TASK, not either alone: a `requestAnimationFrame` callback runs before
    // the paint it is scheduled for, so baking inside one blocks exactly the frame this is trying
    // to release, while `setTimeout` alone can be served before the frame. A timeout scheduled
    // from inside the frame callback is the first task after that frame reaches the glass.
    /**
     * The sky the scene currently holds, which is not always the one the page is showing. Recorded
     * by EVERY rebuild, because the builder reads `data-sky` whenever it runs: a resize that
     * settles between a theme flip and its deferred redraw has already drawn the new sky, and a
     * second rebuild behind it would spend half a second producing the picture on the screen.
     */
    let builtSky = sceneHost.dataset.sky;
    let pendingFrame: number | undefined;
    let pendingTask: ReturnType<typeof setTimeout> | undefined;

    /** The one way the scene is redrawn, so nothing can redraw it and forget to say so. */
    const rebuild = (keepGeometry: boolean): void => {
      builtSky = sceneHost.dataset.sky;
      scene.rebuild(keepGeometry);
    };

    const rebuildSky = (): void => {
      pendingTask = undefined;
      if (disposed) return;
      // A reader who flips twice - to look, and back - lands on the sky that is already built, so
      // the comparison is against what the scene HOLDS rather than what it was last asked for.
      if (sceneHost.dataset.sky === builtSky) return;
      // `keepGeometry`: this rebuild is about the sky, not about the shape. The bands stay
      // exactly where they were solved, so a reader who flips the theme mid-page sees the drawing
      // change and nothing move.
      rebuild(true);
    };

    const onTheme = (): void => {
      if (!applySky()) return;
      if (pendingFrame !== undefined || pendingTask !== undefined) return;
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = undefined;
        pendingTask = setTimeout(rebuildSky, 0);
      });
    };
    const themes = new MutationObserver(onTheme);
    themes.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

    // rebuilds
    /**
     * Rebuild for a change of SHAPE. Never for a change of height alone.
     *
     * A mobile browser hides and shows its chrome as the reader scrolls, which changes
     * `innerHeight` by 60-120 px and fires `resize` while a thumb is on the glass. So height alone
     * is ignored and the test is width plus orientation.
     *
     * The scene element spans the shell, so a landing that grows - a dataset-tree branch opening -
     * still has scene behind all of it; what goes slightly stale is where the bands fall inside it,
     * a few hundred pixels of a page several screens long. A background that re-solves itself
     * because a widget in front of it opened is the two wired together by a number neither meant
     * to share.
     */
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastWidth = window.innerWidth;
    let lastPortrait = window.innerHeight >= window.innerWidth;

    const rebuildIfReshaped = (delay: number): void => {
      const width = window.innerWidth;
      const portrait = window.innerHeight >= window.innerWidth;
      if (Math.abs(width - lastWidth) < 2 && portrait === lastPortrait) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        lastWidth = window.innerWidth;
        lastPortrait = window.innerHeight >= window.innerWidth;
        if (disposed) return;
        rebuild(false);
      }, delay);
    };

    const onResize = (): void => rebuildIfReshaped(RESIZE_SETTLE_MS);
    const onOrientation = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        lastWidth = window.innerWidth;
        lastPortrait = window.innerHeight >= window.innerWidth;
        if (disposed) return;
        rebuild(false);
      }, RESIZE_SETTLE_MS + 40);
    };
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("orientationchange", onOrientation);

    // ONE settle rebuild, after the web fonts have landed. The scene is built against the shell's
    // height and the shell is as tall as its content, so a font swap that reflows the landing moves
    // the ground. `document.fonts.ready` settles once, which is what makes this a first-layout
    // correction rather than a subscription; it is skipped when the height did not move.
    const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
    if (fonts?.ready) {
      const built = scene.geom.H;
      void fonts.ready.then(() => {
        if (disposed) return;
        if (Math.abs(sceneHost.clientHeight - built) <= 8) return;
        rebuild(false);
      }, undefined);
    }

    // WHERE THE BANDS LANDED, read-only. The scene solves once where the story's orbit,
    // atmosphere, coast and ocean fell; without a way to read that, a visual test can only compare
    // pixels, which says something changed and never what. This publishes the solved geometry and
    // nothing else - no setters, no counters, no timing, no measurement API, and nothing the page
    // consults. It is how `browser-tests/cosmos-layout.mjs` asks whether the research vessel is
    // underneath a card and gets an answer in coordinates.
    const diagnostics = Object.freeze({
      get geom(): SceneGeom {
        return scene.geom;
      },
    });
    Object.defineProperty(window, "__portalCosmos", { value: diagnostics, configurable: true });

    return () => {
      themes.disconnect();
      // A deferred sky rebuild outlives the observer that asked for it, so both halves of the
      // hand-off are cancelled here: a frame that has not run yet, and a task it already queued.
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
      if (pendingTask !== undefined) clearTimeout(pendingTask);
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onOrientation);
      scene.destroy();
      delete root.dataset.portalCosmos;
      Reflect.deleteProperty(window, "__portalCosmos");
    };
  }

  return () => {
    if (disposed) return;
    disposed = true;
    teardown?.();
    teardown = null;
  };
}
