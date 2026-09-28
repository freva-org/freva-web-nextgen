/**
 * JSON Schema 2020-12 validation of the closed consumer contract. `strict: true` makes a mistake
 * in *our* schema an error at load time rather than a silently permissive rule at a consumer's
 * build. Ajv instance paths become JSON Pointers handed to the YAML loader, so a consumer sees
 * the line instead of counting out a pointer.
 */

import * as Ajv2020Namespace from "ajv/dist/2020.js";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import * as addFormatsNamespace from "ajv-formats";
import type { Diagnostic } from "../diagnostics.js";
import { readSchemaFile } from "../util/package.js";

/**
 * The three methods this module uses, named structurally. Ajv and ajv-formats are CommonJS with a
 * `default` export, and the class type resolves differently under NodeNext and bundler module
 * resolution, so the same source can type-check in `tsc` and fail in `astro check`. Describing
 * only the surface used is resolution-independent and a smaller promise.
 */
interface SchemaValidatorFactory {
  addSchema(schema: AnySchema): unknown;
  getSchema(reference: string): ValidateFunction | undefined;
  compile(schema: AnySchema): ValidateFunction;
}

// The interop is explicit rather than dependent on which loader happens to run.
type AjvConstructor = new (options?: Record<string, unknown>) => SchemaValidatorFactory;
const Ajv2020 = ((Ajv2020Namespace as { default?: unknown }).default ??
  Ajv2020Namespace) as unknown as AjvConstructor;
const addFormats = ((addFormatsNamespace as { default?: unknown }).default ??
  addFormatsNamespace) as unknown as (ajv: SchemaValidatorFactory) => SchemaValidatorFactory;

export const SCHEMA_FILES = {
  portal: "portal.schema.json",
  landing: "landing.schema.json",
  subsitePolicy: "subsite-policy.schema.json",
  materialReference: "material-reference.schema.json",
  inputManifest: "input-manifest.schema.json",
  portalManifest: "portal-manifest.schema.json",
  componentEvidence: "component-evidence.schema.json",
  hostPolicy: "host-policy.schema.json",
  buildinfo: "buildinfo.schema.json",
  stacMaterials: "stac-materials.schema.json",
} as const;

export type SchemaName = keyof typeof SCHEMA_FILES;

let ajv: SchemaValidatorFactory | undefined;
const compiled = new Map<SchemaName, ValidateFunction>();

function instance(): SchemaValidatorFactory {
  if (ajv) return ajv;
  // `discriminator` lets a closed union say which property picks the branch (a landing block's
  // `type`), so a mistake inside a prose block is reported against the prose shape only - not as
  // one "Value must be …" per block type the author did not mean.
  const a = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
    discriminator: true,
  });
  addFormats(a);
  // The manifest schemas share one reference grammar; register it first.
  a.addSchema(JSON.parse(readSchemaFile(SCHEMA_FILES.materialReference)) as AnySchema);
  ajv = a;
  return a;
}

export function validator(name: SchemaName): ValidateFunction {
  const cached = compiled.get(name);
  if (cached) return cached;
  const a = instance();
  const schema = JSON.parse(readSchemaFile(SCHEMA_FILES[name])) as AnySchema;
  const fn =
    name === "materialReference"
      ? a.getSchema("https://schemas.freva.org/portal/v1/material-reference.schema.json")!
      : a.compile(schema);
  compiled.set(name, fn);
  return fn;
}

/**
 * A closed union discriminated by `kind` produces one Ajv error per branch when the value is
 * wrong, so three service kinds mean three confusing messages about a single typo. A branch whose
 * discriminator did not match is not the branch the author meant, so its errors are dropped.
 */
function dropUnintendedBranches(errors: ErrorObject[]): ErrorObject[] {
  const branchOf = (error: ErrorObject): string | undefined => {
    const matches = [...error.schemaPath.matchAll(/\$defs\/([A-Za-z0-9]+)/g)];
    return matches.length ? matches[matches.length - 1]![1] : undefined;
  };
  const rejected = new Set<string>();
  for (const error of errors) {
    if (error.keyword !== "const") continue;
    if (!/\/(kind|type|profile)$/.test(error.instancePath)) continue;
    const branch = branchOf(error);
    if (branch) rejected.add(`${error.instancePath}::${branch}`);
  }
  if (rejected.size === 0) return errors;
  return errors.filter((error) => {
    const branch = branchOf(error);
    if (!branch) return true;
    for (const key of rejected) {
      const [path, name] = key.split("::");
      if (name !== branch) continue;
      const parent = path!.replace(/\/(kind|type|profile)$/, "");
      if (error.instancePath === parent || error.instancePath.startsWith(`${parent}/`))
        return false;
    }
    return true;
  });
}

function summarize(allErrors: ErrorObject[]): ErrorObject[] {
  const errors = dropUnintendedBranches(allErrors);
  const byPath = new Map<string, ErrorObject[]>();
  for (const e of errors) {
    const list = byPath.get(e.instancePath) ?? [];
    list.push(e);
    byPath.set(e.instancePath, list);
  }
  const out: ErrorObject[] = [];
  const seen = new Set<string>();
  const paths = [...byPath.keys()].sort((a, b) => b.length - a.length);
  const covered = new Set<string>();
  for (const p of paths) {
    if ([...covered].some((c) => c.startsWith(p) && c !== p)) continue;
    covered.add(p);
    const group = byPath.get(p)!;
    const specific = group.filter((e) => e.keyword !== "oneOf" && e.keyword !== "anyOf");
    for (const error of specific.length ? specific : group) {
      const key = `${error.instancePath}::${error.keyword}::${JSON.stringify(error.params)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(error);
    }
  }
  return out;
}

function messageFor(e: ErrorObject): string {
  if (e.keyword === "additionalProperties") {
    const prop = (e.params as { additionalProperty: string }).additionalProperty;
    return `Unknown property '${prop}'. Every portal-owned object is closed; an unknown key is a typo or an unsupported feature, never an extension point.`;
  }
  if (e.keyword === "required") {
    return `Missing required property '${(e.params as { missingProperty: string }).missingProperty}'.`;
  }
  if (e.keyword === "enum") {
    const allowed = (e.params as { allowedValues: unknown[] }).allowedValues;
    return `Value must be one of: ${allowed.map((v) => JSON.stringify(v)).join(", ")}.`;
  }
  if (e.keyword === "const") {
    return `Value must be ${JSON.stringify((e.params as { allowedValue: unknown }).allowedValue)}.`;
  }
  if (e.keyword === "discriminator") {
    const params = e.params as { tag: string; tagValue: unknown };
    return `Unknown ${params.tag} ${JSON.stringify(params.tagValue)}.`;
  }
  if (e.keyword === "oneOf") {
    return "Value does not match exactly one of the allowed shapes for this object.";
  }
  return `${e.message ?? "is invalid"}${e.keyword === "pattern" ? ` (pattern ${(e.params as { pattern: string }).pattern})` : ""}.`;
}

/**
 * A few unknown keys are not typos but a feature asked for in the wrong place. The message stays
 * the generic one - the object is closed - and the hint says where the feature does live.
 */
function hintFor(name: SchemaName, e: ErrorObject): string | undefined {
  if (codeFor(name, e) === "FP1229") {
    return (
      "The bar is one line on every page, so it holds at most three links. Put the rest in " +
      "chrome.footer.groups or chrome.footer.legalLinks, where the open footer lists them."
    );
  }
  if (e.keyword !== "additionalProperties") return undefined;
  const prop = (e.params as { additionalProperty: string }).additionalProperty;
  if (name === "landing" && prop === "python" && /^\/blocks\/\d+$/.test(e.instancePath)) {
    return (
      "A `python` stanza is accepted on a `dataset-tree` block only. Runnable prose - a block " +
      "marked `try-in-python` in a prose fragment or a documentation page - always uses the " +
      "portal-wide `pythonPlayground`, and a page has exactly one playground, so a second stanza " +
      "here could only disagree with it. Configure the interpreter in `pythonPlayground`."
    );
  }
  return undefined;
}

/**
 * The schema's own code, FP1104, for every violation but the few a deployment is expected to hit
 * on purpose and deserves a name for.
 */
function codeFor(name: SchemaName, e: ErrorObject): string {
  if (
    name === "portal" &&
    e.keyword === "maxItems" &&
    e.instancePath === "/chrome/footer/bar/links"
  ) {
    return "FP1229";
  }
  return "FP1104";
}

export interface SchemaValidation {
  valid: boolean;
  diagnostics: Diagnostic[];
}

export function validateAgainst(
  name: SchemaName,
  value: unknown,
  file: string,
  positionOf?: (pointer: string) => Diagnostic["position"],
): SchemaValidation {
  const fn = validator(name);
  const valid = fn(value) as boolean;
  if (valid) return { valid: true, diagnostics: [] };
  const diagnostics = summarize(fn.errors ?? []).map((e): Diagnostic => {
    const pointer = e.instancePath === "" ? "" : e.instancePath;
    const position = positionOf?.(pointer);
    const d: Diagnostic = {
      code: codeFor(name, e),
      severity: "error",
      message: messageFor(e),
      file,
      pointer: pointer === "" ? "/" : pointer,
    };
    if (position) d.position = position;
    const hint = hintFor(name, e);
    if (hint) d.hint = hint;
    return d;
  });
  return { valid: false, diagnostics };
}
