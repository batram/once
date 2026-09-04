import { OnceClient } from "@once/app"
import { AddonEntry, validateConfig } from "@once/core"
import { requireElement } from "../dom"
import { createSchemaControl } from "./schemaControls"
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
      const control = createSchemaControl(property, values[name], {
        id: `addon_option_${entry.manifest.id}_${name}`,
        testid: `addon-option-${entry.manifest.id}-${name}`
      })
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
      const field = document.createElement("div")
      field.className = "field"
      const label = document.createElement("label")
      label.className = "field_label"
      label.htmlFor = control.input.id
      label.textContent = property.type === "object" || property.type === "array"
        ? name
        : property.description ?? name
      field.append(label, control.input)
      group.append(field)
    }
    host.append(group)
  }
}
