// The configuration schema an add-on collector may declare: a small subset of
// JSON Schema, enough for a settings form and for refusing anything odd
// before it reaches the add-on. Validation returns a canonical copy holding
// only declared fields, the way the built-in collectors' `normalizeConfig` do.

export type ConfigSchema =
  | { type: "object"; properties: Readonly<Record<string, ConfigSchema>>; required?: readonly string[] }
  | { type: "string"; enum?: readonly string[]; maxLength?: number; description?: string; default?: string }
  | { type: "number"; minimum?: number; maximum?: number; description?: string; default?: number }
  | { type: "boolean"; description?: string; default?: boolean }
  | { type: "array"; items: ConfigSchema; maxItems?: number; description?: string }

export const CONFIG_SCHEMA_LIMITS = Object.freeze({
  properties: 24,
  depth: 3,
  stringLength: 2000,
  arrayItems: 100
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads a schema an add-on declared; throws with the path of the first problem. */
export function readConfigSchema(value: unknown, path = "config", depth = 0): ConfigSchema {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error(`${path} must have a type`)
  if (depth > CONFIG_SCHEMA_LIMITS.depth) throw new Error(`${path} is nested too deeply`)
  const description = typeof value.description === "string" ? value.description.slice(0, 200) : undefined
  switch (value.type) {
    case "object": {
      if (!isRecord(value.properties)) throw new Error(`${path}.properties must be an object`)
      const names = Object.keys(value.properties)
      if (names.length > CONFIG_SCHEMA_LIMITS.properties) throw new Error(`${path} has too many properties`)
      const properties: Record<string, ConfigSchema> = {}
      for (const name of names) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/.test(name)) throw new Error(`${path}.properties.${name} is not a valid name`)
        properties[name] = readConfigSchema(value.properties[name], `${path}.${name}`, depth + 1)
      }
      const required = value.required === undefined ? undefined : value.required
      if (required !== undefined && (!Array.isArray(required) || !required.every((n) => typeof n === "string" && n in properties))) {
        throw new Error(`${path}.required must list declared properties`)
      }
      return { type: "object", properties, required: required as string[] | undefined }
    }
    case "string": {
      const list = value.enum
      if (list !== undefined && (!Array.isArray(list) || list.length === 0 || !list.every((e) => typeof e === "string"))) {
        throw new Error(`${path}.enum must be a list of strings`)
      }
      return {
        type: "string", description,
        enum: list as string[] | undefined,
        maxLength: typeof value.maxLength === "number" ? Math.min(value.maxLength, CONFIG_SCHEMA_LIMITS.stringLength) : undefined,
        default: typeof value.default === "string" ? value.default : undefined
      }
    }
    case "number":
      return {
        type: "number", description,
        minimum: typeof value.minimum === "number" ? value.minimum : undefined,
        maximum: typeof value.maximum === "number" ? value.maximum : undefined,
        default: typeof value.default === "number" ? value.default : undefined
      }
    case "boolean":
      return { type: "boolean", description, default: typeof value.default === "boolean" ? value.default : undefined }
    case "array":
      return {
        type: "array", description,
        items: readConfigSchema(value.items, `${path}[]`, depth + 1),
        maxItems: typeof value.maxItems === "number" ? Math.min(value.maxItems, CONFIG_SCHEMA_LIMITS.arrayItems) : undefined
      }
    default:
      throw new Error(`${path}.type ${String(value.type)} is not supported`)
  }
}

/**
 * Validates configuration against the schema and returns the canonical copy:
 * declared fields only, defaults filled in, everything else refused with the
 * path named. Undefined configuration validates as an empty object.
 */
export function validateConfig(schema: ConfigSchema, value: unknown, path = "config"): unknown {
  switch (schema.type) {
    case "object": {
      const source = value === undefined ? {} : value
      if (!isRecord(source)) throw new Error(`${path} must be an object`)
      const out: Record<string, unknown> = {}
      for (const [name, property] of Object.entries(schema.properties)) {
        const raw = source[name]
        if (raw === undefined) {
          if (schema.required?.includes(name)) throw new Error(`${path}.${name} is required`)
          if ("default" in property && property.default !== undefined) out[name] = property.default
          continue
        }
        out[name] = validateConfig(property, raw, `${path}.${name}`)
      }
      return out
    }
    case "string":
      if (typeof value !== "string") throw new Error(`${path} must be a string`)
      if (value.length > (schema.maxLength ?? CONFIG_SCHEMA_LIMITS.stringLength)) throw new Error(`${path} is too long`)
      if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} must be one of ${schema.enum.join(", ")}`)
      return value
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a number`)
      if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} must be at least ${schema.minimum}`)
      if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} must be at most ${schema.maximum}`)
      return value
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${path} must be true or false`)
      return value
    case "array":
      if (!Array.isArray(value)) throw new Error(`${path} must be a list`)
      if (value.length > (schema.maxItems ?? CONFIG_SCHEMA_LIMITS.arrayItems)) throw new Error(`${path} has too many entries`)
      return value.map((item, index) => validateConfig(schema.items, item, `${path}[${index}]`))
  }
}
