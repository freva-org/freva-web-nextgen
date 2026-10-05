// Settings validation by interpretation: `@cfworker/json-schema` evaluates no code, and
// `applyDefaults` inserts schema defaults where Ajv's `useDefaults` does. See settings.ts.

import { Validator, type Schema } from "@cfworker/json-schema";
import type { ISchemaValidator, ISettingRegistry } from "@jupyterlab/settingregistry";
import JSON5 from "json5";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type SchemaNode = Record<string, unknown>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Resolve a local `$ref` ("#/definitions/x", "#/$defs/x") against the plugin's own schema. */
function resolve(root: SchemaNode, node: SchemaNode, depth = 0): SchemaNode {
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#") || depth > 32) return node;
  let target: unknown = root;
  for (const part of ref.slice(1).split("/").filter(Boolean)) {
    const key = decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~"));
    target = isObject(target) ? target[key] : undefined;
  }
  return isObject(target) ? resolve(root, target, depth + 1) : node;
}

/**
 * Insert schema defaults into `data`, in place: where Ajv's `useDefaults` inserts them -
 * `properties`, tuple `items`, and inside every subschema validation enters (`$ref`, `allOf`,
 * `items`, `additionalProperties`, `patternProperties`) - but never inside `anyOf`/`oneOf`/`not`.
 */
export function applyDefaults(root: SchemaNode, schema: unknown, data: unknown, depth = 0): void {
  if (!isObject(schema) || depth > 64) return;
  const node = resolve(root, schema);
  if (node !== schema) applyDefaults(root, node, data, depth + 1);
  for (const part of Array.isArray(schema.allOf) ? schema.allOf : []) {
    applyDefaults(root, part, data, depth + 1);
  }
  if (isObject(data)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [key, sub] of Object.entries(properties)) {
      if (!isObject(sub)) continue;
      if (data[key] === undefined && "default" in sub) data[key] = clone(sub.default);
      if (data[key] !== undefined) applyDefaults(root, sub, data[key], depth + 1);
    }
    const patterns = isObject(schema.patternProperties) ? schema.patternProperties : {};
    const additional = schema.additionalProperties;
    for (const key of Object.keys(data)) {
      if (key in properties) continue;
      let matched = false;
      for (const [pattern, sub] of Object.entries(patterns)) {
        try {
          if (new RegExp(pattern, "u").test(key)) {
            matched = true;
            applyDefaults(root, sub, data[key], depth + 1);
          }
        } catch {
          // an invalid pattern validates nothing
        }
      }
      if (!matched && isObject(additional)) applyDefaults(root, additional, data[key], depth + 1);
    }
  } else if (Array.isArray(data)) {
    const items = schema.items;
    if (Array.isArray(items)) {
      items.forEach((sub, index) => {
        if (!isObject(sub)) return;
        if (data[index] === undefined && "default" in sub && index <= data.length) {
          data[index] = clone(sub.default);
        }
        if (data[index] !== undefined) applyDefaults(root, sub, data[index], depth + 1);
      });
    } else if (isObject(items)) {
      for (const element of data) applyDefaults(root, items, element, depth + 1);
    }
  }
}

/** Validates settings by interpretation, never by generating code. */
export class InterpretingSchemaValidator implements ISchemaValidator {
  #validators = new Map<string, { schema: unknown; validator: Validator }>();

  validateData(
    plugin: ISettingRegistry.IPlugin,
    populate = true,
  ): ISchemaValidator.IError[] | null {
    const schema = plugin.schema as unknown as SchemaNode;
    if (schema.type !== "object") {
      return [
        {
          instancePath: "type",
          keyword: "schema",
          schemaPath: "",
          message:
            `Setting registry schemas' root-level type must be 'object', rejecting type: ` +
            `${String(schema.type)}`,
        },
      ];
    }
    let user: Record<string, unknown>;
    try {
      user = JSON5.parse(plugin.raw) as Record<string, unknown>;
    } catch (error) {
      return [
        {
          instancePath: "",
          keyword: "syntax",
          schemaPath: "",
          message: error instanceof Error ? error.message : String(error),
        },
      ];
    }
    let cached = this.#validators.get(plugin.id);
    if (!cached || cached.schema !== plugin.schema) {
      cached = { schema: plugin.schema, validator: new Validator(schema as Schema, "7", false) };
      this.#validators.set(plugin.id, cached);
    }
    const result = cached.validator.validate(user as Json);
    if (!result.valid) {
      return result.errors.map((error) => ({
        instancePath: error.instanceLocation.replace(/^#/, ""),
        keyword: error.keyword,
        schemaPath: error.keywordLocation,
        message: error.error,
      }));
    }
    const composite = clone(user);
    applyDefaults(schema, schema, composite);
    if (populate) {
      plugin.data = {
        composite: composite as ISettingRegistry.IPlugin["data"]["composite"],
        user: user as ISettingRegistry.IPlugin["data"]["user"],
      };
    }
    return null;
  }
}
