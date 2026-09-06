import { OnceClient } from "@once/app"
import { AddonEntry, ConfigSchema, validateConfig } from "@once/core"
import { requireElement } from "../dom"
import { createSchemaControl } from "./schemaControls"
import { addonButton } from "./addonManagement"
import { getAddonStatus, onAddonStatus, retryAddon } from "../addons/addonStatus"

const groups = new Map<string, { signature: string; element: HTMLElement }>()
const updateStatus = (group: HTMLElement): void => {
  const status = group.querySelector(".addon_runtime_status")
  if (!status) return
  const state = getAddonStatus(group.dataset.addon ?? "")
  const text = group.dataset.enabled === "false" ? "Disabled" :
    state ? `${state.state}${state.error ? `: ${state.error}` : ""}` : "Enabled"
  if (status.textContent !== text) status.textContent = text
}
onAddonStatus(() => { for (const { element } of groups.values()) updateStatus(element) })
export const DEV_OPTIONS_EVENT = "once:addon-options"
export interface DevAddonControls {
  directory: string
  unload?: () => Promise<void>
}

export function devAddonEnabled(id: string): boolean {
  return localStorage.getItem(`once:dev-addon-enabled:${id}`) !== "false"
}

export function readDevAddonOptions(id: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`once:dev-addon:${id}`) ?? "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

/** Keep the form mounted across option saves and runtime status updates. */
export function renderAddonOptions(client: OnceClient, entries: readonly AddonEntry[], devIds: ReadonlySet<string> = new Set(), devControls: ReadonlyMap<string, DevAddonControls> = new Map()): void {
  const host = requireElement<HTMLElement>("#addon_options")
  const desired = new Set(entries.filter(entry => entry.manifest.settings?.type === "object" || devIds.has(entry.manifest.id)).map(entry => entry.manifest.id))
  for (const [id, group] of groups) {
    if (!desired.has(id)) { group.element.remove(); groups.delete(id) }
  }
  for (const entry of entries) {
    const { manifest } = entry
    if (manifest.settings?.type !== "object" && !devIds.has(manifest.id)) continue
    const dev = devIds.has(manifest.id)
    const controls = devControls.get(manifest.id)
    const signature = JSON.stringify([manifest, dev, controls?.directory, !!controls?.unload])
    const existing = groups.get(manifest.id)
    if (existing?.signature === signature && existing.element.isConnected) {
      existing.element.dataset.enabled = String(entry.enabled)
      updateStatus(existing.element)
      existing.element.dispatchEvent(new CustomEvent("addon-options-received", { detail: entry.options ?? {} }))
      continue
    }
    groups.get(manifest.id)?.element.remove()
    const element = settingsGroup(client, entry, dev, controls)
    groups.set(manifest.id, { signature, element })
    host.append(element)
  }
}

function settingsGroup(client: OnceClient, entry: AddonEntry, dev: boolean, controls?: DevAddonControls): HTMLElement {
  const { manifest } = entry
  const schema: ConfigSchema = manifest.settings ?? { type: "object", properties: {} }
  const group = document.createElement("fieldset")
  group.className = "addon_options_group settings_group"
  group.dataset.addon = manifest.id
  group.dataset.addonName = manifest.name
  group.dataset.addonVersion = manifest.version
  group.dataset.enabled = String(entry.enabled)
  const legend = document.createElement("legend")
  legend.textContent = `${manifest.name} settings${dev ? " (local directory, this device)" : ""}`
  group.append(legend)
  if (dev) {
    const toggle = addonButton(devAddonEnabled(manifest.id) ? "Disable" : "Enable", () => {
      const enabled = !devAddonEnabled(manifest.id)
      localStorage.setItem(`once:dev-addon-enabled:${manifest.id}`, String(enabled))
      toggle.textContent = enabled ? "Disable" : "Enable"
      group.dataset.enabled = String(enabled)
      updateStatus(group)
      window.dispatchEvent(new Event(DEV_OPTIONS_EVENT))
    })
    group.append(toggle, addonButton("Retry", () => retryAddon(manifest.id)))
    const status = document.createElement("p")
    status.className = "addon_runtime_status"
    status.setAttribute("role", "status")
    group.append(status)
    updateStatus(group)
    if (controls) {
      const directory = document.createElement("p")
      directory.className = "addon_directory_path settings_group_hint"
      directory.textContent = controls.directory
      group.append(directory)
      if (controls.unload) group.append(addonButton("Unload", controls.unload))
    }
  }
  const values = validateConfig(schema, entry.options ?? {}) as Record<string, unknown>
  const fields: { element: HTMLElement; schema: ConfigSchema }[] = []
  const updateVisibility = () => {
    for (const field of fields) {
      const condition = field.schema.visibleWhen
      field.element.hidden = !!condition && values[condition.field] !== condition.equals
    }
  }
  const save = async (name: string, value: unknown): Promise<void> => {
    const options = validateConfig(schema, { ...values, [name]: value }) as Record<string, unknown>
    if (dev) {
      localStorage.setItem(`once:dev-addon:${manifest.id}`, JSON.stringify(options))
      window.dispatchEvent(new Event(DEV_OPTIONS_EVENT))
    } else {
      await client.updateAddons(doc => ({ ...doc, addons: doc.addons.map(candidate => candidate.manifest.id === manifest.id
        ? { ...candidate, options: validateConfig(schema, { ...candidate.options, [name]: value }) as Record<string, unknown> } : candidate) }))
    }
    Object.assign(values, options)
    updateVisibility()
  }
  let lastGroup = ""
  if (schema.type === "object") for (const [name, property] of Object.entries(schema.properties)) {
    if (property.group && property.group !== lastGroup) {
      const heading = document.createElement("h3")
      heading.className = "settings_subheading"
      heading.textContent = property.group
      group.append(heading)
      lastGroup = property.group
    }
    const field = property.format === "secret"
      ? secretField(client, entry, name, values)
      : optionField(manifest.id, name, property, values[name], value => save(name, value))
    if (!field) continue
    fields.push({ element: field, schema: property })
    group.append(field)
  }
  updateVisibility()
  group.addEventListener("addon-options-received", event => {
    const incoming = validateConfig(schema, (event as CustomEvent).detail) as Record<string, unknown>
    for (const [name, value] of Object.entries(incoming)) {
      const input = group.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`#addon_option_${manifest.id}_${name}`)
      if (input?.dataset.dirty === "true" || document.activeElement === input) continue
      values[name] = value
      if (!input) continue
      if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = value === true
      else input.value = typeof value === "object" ? JSON.stringify(value) : String(value)
    }
    updateVisibility()
  })
  return group
}

function optionField(addon: string, name: string, property: ConfigSchema, value: unknown, save: (value: unknown) => Promise<void>): HTMLElement | null {
  const control = createSchemaControl(property, value, { id: `addon_option_${addon}_${name}`, testid: `addon-option-${addon}-${name}`, json: true })
  if (!control) return null
  const field = fieldShell(property, name, control.input.id)
  const status = document.createElement("span")
  status.setAttribute("role", "status")
  const commit = async () => {
    try { await save(control.read()); delete control.input.dataset.dirty; status.textContent = "Saved" }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error) }
  }
  control.input.addEventListener("input", () => { control.input.dataset.dirty = "true"; status.textContent = "Unsaved" })
  control.input.addEventListener("change", () => { void commit() })
  field.append(control.input)
  if ("default" in property && property.default !== undefined) field.append(addonButton("Restore default", async () => {
    if (control.input instanceof HTMLInputElement && control.input.type === "checkbox") control.input.checked = property.default === true
    else control.input.value = String(property.default)
    await commit()
  }))
  field.append(status)
  return field
}

function secretField(client: OnceClient, entry: AddonEntry, name: string, values: Record<string, unknown>): HTMLElement {
  const schema = entry.manifest.settings
  if (!schema) throw new Error("Addon has no settings schema")
  const property = schema.type === "object" ? schema.properties[name] : schema
  const input = document.createElement("input")
  input.type = "password"
  input.autocomplete = "new-password"
  input.id = `addon_option_${entry.manifest.id}_${name}`
  input.dataset.testid = `addon-option-${entry.manifest.id}-${name}`
  input.placeholder = "Replace token (device-local)"
  const field = fieldShell(property, name, input.id)
  const status = document.createElement("span")
  status.setAttribute("role", "status")
  const endpoint = () => {
    const connection = entry.manifest.connections?.find(item => item.secret === name)
    return String(connection ? values[connection.endpoint] ?? "" : "")
  }
  void client.hasAddonSecret(entry.manifest.id, name, endpoint()).then(configured => {
    status.textContent = configured ? "Token saved on this device" : "No token for this endpoint"
  }).catch(() => { status.textContent = "Could not read token status" })
  const save = async (value: string) => {
    try {
      await client.saveAddonSecret(entry.manifest.id, name, endpoint(), value)
      input.value = ""
      status.textContent = value ? "Token saved on this device" : "Token cleared"
      window.dispatchEvent(new CustomEvent(DEV_OPTIONS_EVENT, { detail: entry.manifest.id }))
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error) }
  }
  field.append(input, addonButton("Save token", () => save(input.value)), addonButton("Clear token", () => save("")), status)
  return field
}

function fieldShell(property: ConfigSchema, name: string, id: string): HTMLElement {
  const field = document.createElement("div")
  field.className = "field"
  const label = document.createElement("label")
  label.className = "field_label"
  label.htmlFor = id
  label.textContent = property.label ?? name
  field.append(label)
  if ("description" in property && property.description) {
    const help = document.createElement("p")
    help.className = "settings_group_hint"
    help.textContent = property.description
    field.append(help)
  }
  return field
}
