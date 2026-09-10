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
/**
 * What a linked folder can do for an addon. `folder` means the folder is what
 * runs; `shadowed` means an installed copy with the same ID runs and the folder
 * is being ignored, which the page has to say out loud.
 */
export interface DevAddonControls {
  kind: "folder" | "shadowed"
  directory: string
  /** Identity of the folder's current files: the actions below capture them, so the page redraws when they change. */
  files?: string
  unload?: () => Promise<void>
  /** Folder: saves the folder's files as an installed, synced copy. */
  install?: () => Promise<void>
  /** Shadowed: overwrites the installed copy with the folder's files, keeping its settings. */
  replace?: () => Promise<void>
  /** Shadowed: removes the installed copy so the folder runs. */
  useFolder?: () => Promise<void>
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
  // Every addon gets a page: even one without settings has a source to show.
  const desired = new Set(entries.map(entry => entry.manifest.id))
  for (const [id, group] of groups) {
    if (!desired.has(id)) { group.element.remove(); groups.delete(id) }
  }
  for (const entry of entries) {
    const { manifest } = entry
    const dev = devIds.has(manifest.id)
    const controls = devControls.get(manifest.id)
    const signature = JSON.stringify([manifest, dev, entry.source?.url, controls?.kind, controls?.directory, controls?.files, !!controls?.unload])
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
  legend.textContent = `${manifest.name} settings${dev ? " (linked folder)" : ""}`
  group.append(legend, sourceCard(entry, dev, controls))
  if (dev) group.dataset.addonOrigin = "Linked folder · This device"
  else if (controls?.kind === "shadowed") group.dataset.addonOrigin = "Installed · Linked folder not in use"
  if (dev) {
    const toggle = addonButton(devAddonEnabled(manifest.id) ? "Disable" : "Enable", () => {
      const enabled = !devAddonEnabled(manifest.id)
      localStorage.setItem(`once:dev-addon-enabled:${manifest.id}`, String(enabled))
      toggle.textContent = enabled ? "Disable" : "Enable"
      group.dataset.enabled = String(enabled)
      updateStatus(group)
      window.dispatchEvent(new Event(DEV_OPTIONS_EVENT))
    })
    const actions = document.createElement("div")
    actions.className = "settings_actions cluster"
    actions.append(toggle, addonButton("Retry", () => retryAddon(manifest.id)))
    const status = document.createElement("p")
    status.className = "addon_runtime_status"
    status.setAttribute("role", "status")
    group.append(actions, status)
    updateStatus(group)
  }
  const values = validateConfig(schema, entry.options ?? {}) as Record<string, unknown>
  const fields: { element: HTMLElement; schema: ConfigSchema }[] = []
  // A field hides with the field its condition names, so a hidden toggle takes its dependants along.
  const visible = (condition: ConfigSchema["visibleWhen"], depth = 0): boolean => {
    if (!condition || depth > 3) return true
    if (values[condition.field] !== condition.equals) return false
    return visible(schema.type === "object" ? schema.properties[condition.field]?.visibleWhen : undefined, depth + 1)
  }
  const updateVisibility = () => {
    for (const field of fields) field.element.hidden = !visible(field.schema.visibleWhen)
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
      ? secretField(client, entry, name, values, dev)
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
    for (const field of fields) field.element.dispatchEvent(new Event("addon-options-received"))
  })
  return group
}

/**
 * Where the addon's code comes from, and the controls that change that. The
 * card sits first in the group so its status line is where action errors land.
 */
function sourceCard(entry: AddonEntry, dev: boolean, controls?: DevAddonControls): HTMLElement {
  const card = document.createElement("section")
  card.className = "addon_source"
  card.dataset.testid = "addon-source"
  const heading = document.createElement("h3")
  heading.className = "settings_subheading"
  heading.textContent = "Where this addon comes from"
  const summary = document.createElement("p")
  summary.className = "addon_source_summary"
  const status = document.createElement("p")
  status.setAttribute("role", "status")
  const actions = document.createElement("div")
  actions.className = "addon_source_actions"
  card.append(heading, summary, status, actions)
  const location = (text: string): void => {
    const path = document.createElement("code")
    path.className = "addon_source_path"
    path.textContent = text
    summary.after(path)
  }
  const action = (label: string, hint: string, run: () => Promise<void> | void, testid: string, primary = false): void => {
    const item = document.createElement("div")
    item.className = "addon_source_action"
    const button = addonButton(label, run)
    button.dataset.testid = testid
    if (primary) button.classList.add("addon_primary_action")
    const help = document.createElement("p")
    help.className = "settings_group_hint"
    help.textContent = hint
    item.append(button, help)
    actions.append(item)
  }
  if (controls?.kind === "shadowed") {
    card.classList.add("addon_source--attention")
    summary.textContent = "The installed copy is running. A linked folder with the same addon ID is being ignored, so edits there change nothing:"
    location(controls.directory)
    if (controls.useFolder) action("Use the folder instead", "Removes the installed copy with its settings and tokens; the folder then runs and reloads on edits.", controls.useFolder, "addon-source-use-folder", true)
    if (controls.replace) action("Update installed copy from folder", "Overwrites the installed copy with the folder's current files and keeps its settings and tokens. Needs encrypted addon sync.", controls.replace, "addon-source-replace")
    if (controls.unload) action("Unload folder", "Forgets the folder link. The files stay where they are.", controls.unload, "addon-source-unload")
  } else if (dev) {
    summary.textContent = "Runs from a linked folder on this device. Saved edits reload it automatically; nothing about it is synced."
    if (controls) location(controls.directory)
    if (controls?.install) action("Install this version", "Saves the folder's current files as an installed copy, synced to your devices with encrypted addon sync, then unloads the folder.", controls.install, "addon-source-install", true)
    if (controls?.unload) action("Unload folder", "Stops running the addon from this folder. The files and its local settings stay.", controls.unload, "addon-source-unload")
  } else if (entry.source) {
    summary.textContent = "Installed from a manifest URL. Check for updates fetches the manifest again and shows what changed before installing."
    location(entry.source.url)
    action("Check for updates", "Reviews every URL-installed addon for a newer version.", () => {
      document.querySelector<HTMLButtonElement>('[data-testid="update-addons"]')?.click()
    }, "addon-source-check-updates")
  } else {
    summary.textContent = "Installed copy of a ZIP, folder or shared snapshot. To update it, import the new version again; to work on it live, link its folder on the Import page."
  }
  return card
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

function secretField(client: OnceClient, entry: AddonEntry, name: string, values: Record<string, unknown>, localOnly: boolean): HTMLElement {
  const schema = entry.manifest.settings
  if (!schema) throw new Error("Addon has no settings schema")
  const property = schema.type === "object" ? schema.properties[name] : schema
  const input = document.createElement("input")
  input.type = "password"
  input.autocomplete = "new-password"
  input.id = `addon_option_${entry.manifest.id}_${name}`
  input.dataset.testid = `addon-option-${entry.manifest.id}-${name}`
  input.placeholder = "Replace token"
  const field = fieldShell(property, name, input.id)
  const status = document.createElement("span")
  status.setAttribute("role", "status")
  const endpoint = () => {
    const connection = entry.manifest.connections?.find(item => item.secret === name)
    return String(connection ? values[connection.endpoint] ?? "" : "")
  }
  const refresh = async () => {
    const configured = await client.hasAddonSecret(entry.manifest.id, name, endpoint(), localOnly)
    const vault = localOnly ? null : await client.getAddonVaultStatus?.()
    status.textContent = configured ? vault?.state === "ready" ? "Token saved · Encrypted sync" : "Token saved on this device" : "No token for this endpoint"
  }
  void refresh().catch(() => { status.textContent = "Could not read token status" })
  field.addEventListener("addon-options-received", () => { void refresh().catch(() => undefined) })
  const save = async (value: string) => {
    try {
      await client.saveAddonSecret(entry.manifest.id, name, endpoint(), value, localOnly)
      input.value = ""
      if (value) await refresh()
      else status.textContent = "Token cleared"
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
