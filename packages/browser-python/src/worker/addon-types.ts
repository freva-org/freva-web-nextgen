/**
 * What a curated add-on IS, as data. A closed registry, not a package installer: an add-on names
 * artefacts this package pinned and this package's own build compiled digests for, and it never
 * accepts a URL, a package name or an install script from a caller, because a portal's content
 * authors are not the people who should be choosing what runs in a visitor's interpreter.
 */

/** One mirrored wheel: pure Python, pinned, and installed from an explicit URL. */
export interface AddonWheelPin {
  name: string;
  version: string;
  file: string;
  sha256: string;
  bytes: number;
  /** Where `prepare-addons` fetched it from. Never requested at runtime. */
  url: string;
}

/** One staged data file, at a path an add-on's library expects to find it under. */
export interface AddonDataPin {
  /** Relative to the add-on's own directory, on both the server and the interpreter's filesystem. */
  path: string;
  sha256: string;
  bytes: number;
  /** Where `prepare-addons` fetched it from. Never requested at runtime. */
  url: string;
}

/** Provenance for data an add-on ships that this project did not author. */
export interface AddonDataset {
  name: string;
  release: string;
  tag: string;
  source: string;
  home: string;
  licence: string;
  attribution: string;
}

export interface AddonPin {
  title: string;
  /** The profiles this add-on may be combined with. Anything else is refused, with a reason. */
  profiles: readonly string[];
  /** Packages taken from the pinned runtime's own lock, loaded with `loadPackage`. */
  runtimePackages: readonly string[];
  wheels: readonly AddonWheelPin[];
  data: readonly AddonDataPin[];
  /** Import names whose versions belong in the ready payload. */
  reports: readonly string[];
  dataset?: AddonDataset;
  note?: string;
}

export type AddonPins = Readonly<Record<string, AddonPin>>;
