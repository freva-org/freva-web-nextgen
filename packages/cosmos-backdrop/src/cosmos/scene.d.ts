// scene.d.ts - the declared boundary around the Cosmos scene builder.
//
// READ THIS BEFORE TRUSTING IT. This file DECLARES the module's surface; it does not CHECK it.
// `scene.js` is plain JavaScript and is never type-checked (its own header explains why), so if a
// signature below is wrong, TypeScript believes this file and not the code. It is a
// hand-maintained contract: changing `scene.js` means changing this too.
//
// The checks that DO cover the scene are runtime ones. `tests/artifact/cosmos-theme.test.ts`
// asserts the sprite registry, the packaging and the containment;
// `browser-tests/cosmos-visual.mjs` drives the real thing in a browser - that it is drawn once,
// that it then runs no frame loop and no timer, that it follows the portal's theme, and that
// reduced motion leaves a complete composition standing.
//
// It is short on purpose: a retained scene has no lifecycle to expose.

/** Host-configurable knobs. Set before `mountCosmosScene`. */
export declare const CONFIG: {
  /** Base URL for the object bodies. A trailing slash is added if absent. */
  assetBase: string;
};

/**
 * Where the story's bands landed, in the scene root's own coordinates. The oracle the layout tests
 * use: it says where the composition actually put the coastline, so a test can ask whether a
 * content surface is sitting on top of it rather than guessing from a screenshot. A plain readout
 * of the solved geometry - no clock, nothing accumulated, nothing written back.
 */
export interface SceneGeom {
  /** Viewport width and height, CSS px. */
  w: number;
  h: number;
  /** Total story height - the scene root's own height - CSS px. */
  H: number;
  /** Band boundaries, in story coordinates. */
  spaceEnd: number;
  chartTop: number;
  groundY: number;
  seaY: number;
  oceanBot: number;
  /** Horizontal position of the coast. */
  coastX: number;
}

/** What a mounted scene lets the island do. */
export interface CosmosScene {
  /**
   * Solve the layout again and redraw every element. For a real change of width or orientation,
   * not for a change of height: a mobile browser hiding and showing its chrome during a scroll is
   * a height change of 60-120 px.
   *
   * `keepGeometry` redraws against the geometry already solved, for the one rebuild that is not
   * about shape: the scene holds one sky, so a theme change draws the other one, and re-solving
   * there would re-read a page height the reader's scrolling may have changed.
   */
  rebuild(keepGeometry?: boolean): void;
  /** Band geometry of the scene as built. */
  readonly geom: SceneGeom;
  /** Remove every element and every rule the scene created. Idempotent. */
  destroy(): void;
}

/** Draw the scene into `host` and return its handle. */
export declare function mountCosmosScene(host: HTMLElement): CosmosScene;

/**
 * The object bodies the scene draws, by file name - the authoritative list.
 * `src/model/cosmos-scene.ts` publishes exactly these into the artifact, and
 * `tests/artifact/cosmos-theme.test.ts` reads the registry out of `scene.js` to prove the two
 * cannot drift.
 */
export declare function sceneBodies(): string[];
