import { ConfigSchema } from "@once/core"

/**
 * One control rendered from a schema property: strings become inputs or
 * selects, numbers number inputs, booleans checkboxes. Nested objects and
 * arrays get a JSON textarea when the caller allows it and nothing otherwise.
 * Shared by the add-on options in Settings › Add-ons and the source editor's
 * collector configuration, so a schema looks the same wherever it is filled in.
 */
export interface SchemaControl {
  input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  /** The current value, or a `SyntaxError` for a JSON textarea that does not parse. */
  read(): unknown
}

export interface SchemaControlOptions {
  id: string
  testid: string
  /** Render nested objects and arrays as JSON text instead of skipping them. */
  json?: boolean
}

export function createSchemaControl(
  schema: ConfigSchema,
  value: unknown,
  options: SchemaControlOptions
): SchemaControl | null {
  let control: SchemaControl
  if (schema.type === "string" && schema.format === "multiline") {
    const textarea = document.createElement("textarea")
    textarea.rows = 6
    textarea.maxLength = schema.maxLength ?? 16_000
    textarea.value = typeof value === "string" ? value : ""
    control = { input: textarea, read: () => textarea.value }
  } else if (schema.type === "object" || schema.type === "array") {
    if (!options.json) return null
    control = jsonControl(value)
  } else if (schema.type === "string" && schema.enum) {
    control = selectControl(schema.enum, value)
  } else if (schema.type === "boolean") {
    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    checkbox.checked = value === true
    control = { input: checkbox, read: () => checkbox.checked }
  } else {
    control = textControl(schema, value)
  }
  control.input.id = options.id
  if (schema.format === "url" && control.input instanceof HTMLInputElement) control.input.type = "url"
  control.input.dataset.testid = options.testid
  return control
}

function selectControl(choices: readonly string[], value: unknown): SchemaControl {
  const select = document.createElement("select")
  const chosen = typeof value === "string" && choices.includes(value) ? value : choices[0]
  for (const option of choices) {
    const element = document.createElement("option")
    element.value = option
    element.textContent = option
    element.selected = option === chosen
    select.append(element)
  }
  return { input: select, read: () => select.value }
}

function textControl(schema: ConfigSchema & { type: "string" | "number" }, value: unknown): SchemaControl {
  const text = document.createElement("input")
  text.type = schema.type === "number" ? "number" : "text"
  text.value = value === undefined ? "" : String(value)
  if (schema.type === "number") {
    if (schema.minimum !== undefined) text.setAttribute("min", String(schema.minimum))
    if (schema.maximum !== undefined) text.setAttribute("max", String(schema.maximum))
    text.setAttribute("step", "any")
  } else if (schema.maxLength !== undefined) {
    text.setAttribute("maxlength", String(schema.maxLength))
  }
  // An empty number field is "not set", so an optional number can stay blank
  // instead of turning into 0.
  const read = (): unknown => {
    if (schema.type !== "number") return text.value
    return text.value.trim() === "" ? undefined : Number(text.value)
  }
  return { input: text, read }
}

function jsonControl(value: unknown): SchemaControl {
  const area = document.createElement("textarea")
  area.rows = 3
  area.spellcheck = false
  // The default value, which is what a fresh textarea shows.
  area.textContent = value === undefined ? "" : JSON.stringify(value, null, 2)
  const read = (): unknown => {
    if (area.value.trim() === "") return undefined
    try {
      return JSON.parse(area.value) as unknown
    } catch (error) {
      return error instanceof SyntaxError ? error : new SyntaxError(String(error))
    }
  }
  return { input: area, read }
}
