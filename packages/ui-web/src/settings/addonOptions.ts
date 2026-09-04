import { OnceClient } from "@once/app"
import { AddonEntry, ConfigSchema, validateConfig } from "@once/core"
import { requireElement } from "../dom"
import { trackSettingsSave } from "./settingsStatus"

/**
 * The controls for each enabled add-on's `settings` schema, rendered from the
 * schema alone: strings become inputs or selects, numbers number inputs,
 * booleans checkboxes. A change validates the whole object and saves the
 * entry's `options`; the sandbox host picks the new values up from the
 * document change and hands them to the script.
 */
export function renderAddonOptions(client: OnceClient, entries: readonly AddonEntry[]): void {
  const host = requireElement<HTMLElement>("#addon_options")
  host.replaceChildren()
  for (const entry of entries) {
    const schema = entry.manifest.settings
    if (!entry.enabled || !schema || schema.type !== "object") continue
    const group = document.createElement("fieldset")
    group.className = "addon_options_group settings_group"
    group.dataset.addon = entry.manifest.id
    const legend = document.createElement("legend")
    legend.className = "settings_subheading"
    legend.textContent = `${entry.manifest.name} options`
    group.append(legend)
    const values = { ...(validateConfig(schema, entry.options ?? {}) as Record<string, unknown>) }
    for (const [name, property] of Object.entries(schema.properties)) {
      const control = controlFor(entry.manifest.id, name, property, values[name])
      if (!control) continue
      control.input.addEventListener("change", () => {
        values[name] = control.read()
        void trackSettingsSave(control.input, async () => {
          const options = validateConfig(schema, values) as Record<string, unknown>
          const doc = await client.getAddons()
          await client.saveAddons({
            ...doc,
            addons: doc.addons.map((candidate) =>
              candidate.manifest.id === entry.manifest.id ? { ...candidate, options } : candidate)
          })
        })
      })
      group.append(control.field)
    }
    host.append(group)
  }
}

interface Control {
  field: HTMLElement
  input: HTMLInputElement | HTMLSelectElement
  read(): unknown
}

function controlFor(addonId: string, name: string, schema: ConfigSchema, value: unknown): Control | null {
  if (schema.type === "object" || schema.type === "array") return null
  const field = document.createElement("div")
  field.className = "field"
  const id = `addon_option_${addonId}_${name}`
  const label = document.createElement("label")
  label.className = "field_label"
  label.htmlFor = id
  label.textContent = schema.description ?? name
  let input: HTMLInputElement | HTMLSelectElement
  let read: () => unknown
  if (schema.type === "string" && schema.enum) {
    const select = document.createElement("select")
    for (const option of schema.enum) {
      const element = document.createElement("option")
      element.value = option
      element.textContent = option
      select.append(element)
    }
    select.value = typeof value === "string" ? value : schema.enum[0]
    input = select
    read = () => select.value
  } else if (schema.type === "boolean") {
    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    checkbox.checked = value === true
    input = checkbox
    read = () => checkbox.checked
  } else {
    const text = document.createElement("input")
    text.type = schema.type === "number" ? "number" : "text"
    text.value = value === undefined ? "" : String(value)
    if (schema.type === "number") {
      if (schema.minimum !== undefined) text.min = String(schema.minimum)
      if (schema.maximum !== undefined) text.max = String(schema.maximum)
      text.step = "any"
    } else if (schema.maxLength !== undefined) {
      text.maxLength = schema.maxLength
    }
    input = text
    read = () => (schema.type === "number" ? Number(text.value) : text.value)
  }
  input.id = id
  input.dataset.testid = `addon-option-${addonId}-${name}`
  field.append(label, input)
  return { field, input, read }
}
