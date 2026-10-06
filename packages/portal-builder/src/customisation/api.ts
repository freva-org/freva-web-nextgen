// The versioned public surfaces of the two customisation capabilities: `schema/style-parts-v1.json`
// (what a portal-style-v1 stylesheet may name) and `schema/slots-v1.json` (the slots, their
// read-only contexts and the sealed parts a portal-template-v1 template may insert). Read from the
// published files, so the documentation, the checker and the markup agree on one list.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_DIR } from "../util/package.js";

export interface PartSpec {
  description: string;
  /** The feature that owns the part; a disabled feature's part never renders. */
  feature?: string;
  /** May not be hidden, made inert or have its focus indicator removed. */
  protected?: boolean;
  /** An ancestor of a protected part: hiding it would hide that part too. */
  containsProtected?: boolean;
}

export interface StyleApi {
  version: number;
  profile: "portal-style-v1";
  parts: Record<string, PartSpec>;
  variants: Record<string, string[]>;
  states: Record<string, string>;
  themes: string[];
  tokens: Record<string, string>;
  consumerClassPrefix: string;
  consumerPropertyPrefix: string;
  layer: string;
  frameworkLayer: string;
}

export type FieldType =
  | "string"
  | "url"
  /** A same-origin path to a file this build published. */
  | "image"
  | "boolean"
  | { type: "object"; fields: Record<string, FieldType> }
  | { type: "array"; items: FieldType };

export interface SlotSpec {
  location: string;
  parts: string[];
  requiredParts?: string[];
  forbiddenElements?: string[];
  extraContext: Record<string, FieldType>;
}

export interface SlotsApi {
  version: number;
  profile: "portal-template-v1";
  iterationCap: number;
  totalIterationCap: number;
  context: Record<string, FieldType>;
  slots: Record<string, SlotSpec>;
  parts: Record<string, { description: string; feature?: string; protected?: boolean }>;
}

let style: StyleApi | undefined;
let slots: SlotsApi | undefined;

export function styleApi(): StyleApi {
  style ??= JSON.parse(readFileSync(join(SCHEMA_DIR, "style-parts-v1.json"), "utf8")) as StyleApi;
  return style;
}

export function slotsApi(): SlotsApi {
  slots ??= JSON.parse(readFileSync(join(SCHEMA_DIR, "slots-v1.json"), "utf8")) as SlotsApi;
  return slots;
}

/** Every variant value, across the parts that have variants. */
export function allVariants(api: StyleApi = styleApi()): Set<string> {
  return new Set(Object.values(api.variants).flat());
}
