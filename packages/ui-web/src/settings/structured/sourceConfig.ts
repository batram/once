import { get_parser_by_id } from "@once/collectors"
import { ConfigSchema, validateConfig } from "@once/core"
import { createSchemaControl } from "../schemaControls"
import { FormField } from "./form"

/**
 * The source form's configuration rows, rendered from the schema of whichever
 * collector is selected. Add-on collectors declare one in their manifest; the
 * built-in configurable collectors do not, and their `select` passes through
 * the form untouched, the way it always has. Values live here between renders
 * so switching the collector back and forth does not lose what was typed.
 */
export class SourceConfigFields {
  private schema: (ConfigSchema & { type: "object" }) | undefined
  private values: Record<string, unknown>

  constructor(private readonly initial: unknown) {
    this.values = isRecord(initial) ? { ...initial } : {}
  }

  /** Rebuilds the rows for the collector the select names; hides them when it takes none. */
  render(collectorInput: FormField, rows: HTMLElement): void {
    const schema = get_parser_by_id(collectorInput.value)?.options.configSchema
    this.schema = schema?.type === "object" ? schema : undefined
    rows.replaceChildren()
    rows.hidden = this.schema === undefined
    if (!this.schema) return
    const heading = document.createElement("h4")
    heading.className = "settings_subheading"
    heading.textContent = "Configuration"
    rows.append(heading)
    for (const [name, property] of Object.entries(this.schema.properties)) {
      const fallback = "default" in property ? property.default : undefined
      const control = createSchemaControl(property, this.values[name] ?? fallback, {
        id: `source_config_${name}`,
        testid: `source-config-${name}`,
        json: true
      })
      if (!control) continue
      control.input.required = Boolean(this.schema.required?.includes(name)) && property.type !== "boolean"
      control.input.addEventListener("change", () => {
        this.values[name] = control.read()
      })
      const label = document.createElement("label")
      label.className = "structured_form_field settings_row"
      const title = document.createElement("span")
      title.className = "settings_row_name"
      title.textContent = name
      label.append(title)
      const described = "description" in property ? property.description : undefined
      const hint = property.type === "object" || property.type === "array"
        ? [described, "JSON"].filter(Boolean).join(" · ")
        : described
      if (hint) {
        const span = document.createElement("span")
        span.className = "settings_row_hint"
        span.textContent = hint
        label.append(span)
      }
      label.append(control.input)
      rows.append(label)
    }
  }

  /**
   * What the source should store: the validated configuration when the
   * selected collector has a schema, otherwise whatever it had before. A
   * schema violation names the field instead of saving.
   */
  read(): { ok: true; select: unknown } | { ok: false; message: string } {
    if (!this.schema) return { ok: true, select: this.initial }
    const values: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(this.values)) {
      if (value instanceof SyntaxError) return { ok: false, message: `${name} must be valid JSON` }
      if (value !== undefined && value !== "") values[name] = value
    }
    try {
      return { ok: true, select: validateConfig(this.schema, values) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message.replace(/^config\./, "") : String(error) }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
