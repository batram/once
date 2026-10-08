import { OnceClient } from "@once/app"
import { AddonEntry, AddonModel, ConfigSchema, validateConfig } from "@once/core"
import { requireElement } from "../dom"
import { createSchemaControl } from "./schemaControls"
import { addonButton, addonHead } from "./addonManagement"
import { addonOrigin, addonOriginSentence, addonRuntimeLabel, folderName, showAddonRuntime } from "./addonPresentation"
import { getAddonStatus, onAddonStatus, retryAddon } from "../addons/addonStatus"
import { canChooseConversationPlacement, pageConversationPlace, setPageConversationPlace } from "../addons/pageAddons"

const groups = new Map<string, { signature: string; element: HTMLElement }>()
const updateStatus = (group: HTMLElement): void => {
  const status = group.querySelector<HTMLElement>(".addon_runtime_status")
  if (!status) return
  showAddonRuntime(status, group.querySelector<HTMLElement>('[data-action="retry"]'),
    addonRuntimeLabel(getAddonStatus(group.dataset.addon ?? ""), group.dataset.enabled !== "false"))
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
  /** Shadowed: the folder's manifest version, and whether the installed copy already holds the folder's files. */
  version?: string
  upToDate?: boolean
  unload?: () => Promise<void>
  /** Folder: saves the folder's files as an installed, synced copy. A returned sentence is shown as the outcome. */
  install?: () => Promise<string | undefined>
  /** Shadowed: overwrites the installed copy with the folder's files, keeping its settings. */
  replace?: () => Promise<string | undefined>
  /** Shadowed: removes the installed copy so the folder runs. */
  useFolder?: () => Promise<string | undefined>
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
  group.append(legend)
  // The list row names the source: a folder by its name, an ignored folder beside what runs instead.
  if (dev) group.dataset.addonOrigin = controls ? `Linked folder ${folderName(controls.directory)} · this device` : "Linked folder · this device"
  else if (controls?.kind === "shadowed") group.dataset.addonOrigin = `${addonOrigin(entry)} · folder linked`
  if (dev) {
    // A folder add-on has no installed row, so its page head is built here, the same way.
    const toggle = addonButton(devAddonEnabled(manifest.id) ? "Disable" : "Enable", () => {
      const enabled = !devAddonEnabled(manifest.id)
      localStorage.setItem(`once:dev-addon-enabled:${manifest.id}`, String(enabled))
      toggle.textContent = enabled ? "Disable" : "Enable"
      group.dataset.enabled = String(enabled)
      updateStatus(group)
      window.dispatchEvent(new Event(DEV_OPTIONS_EVENT))
    })
    const retry = addonButton("Retry", () => retryAddon(manifest.id))
    retry.dataset.action = "retry"
    retry.hidden = true
    group.append(addonHead(document.createElement("p"), [retry, toggle]))
    updateStatus(group)
  }
  group.append(sourceCard(entry, dev, controls))
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
      : optionField(manifest.id, name, property, values[name], value => save(name, value),
        property.suggestions ? modelSuggestions(client, entry, property.suggestions, values, dev) : undefined)
    if (!field) continue
    fields.push({ element: field, schema: property })
    group.append(field)
  }
  group.append(...conversationPlaceField(manifest))
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
  heading.textContent = "Source"
  const summary = document.createElement("p")
  summary.className = "addon_source_summary"
  const status = document.createElement("p")
  status.setAttribute("role", "status")
  const actions = document.createElement("div")
  actions.className = "addon_source_actions"
  card.append(heading, summary, status, actions)
  const location = (text: string, after: Element = summary): void => {
    const path = document.createElement("code")
    path.className = "addon_source_path"
    path.textContent = text
    after.after(path)
  }
  const action = (label: string, hint: string, run: () => Promise<unknown> | unknown, testid: string, primary = false): void => {
    const item = document.createElement("div")
    item.className = "addon_source_action"
    // An action that worked says what it did; silence after a click reads as nothing having happened.
    const button = addonButton(label, async () => {
      status.textContent = ""
      status.dataset.tone = "ok"
      try {
        const outcome = await run()
        if (typeof outcome === "string") status.textContent = outcome
      } catch (error) { status.dataset.tone = "error"; throw error }
    })
    button.dataset.testid = testid
    if (primary) button.classList.add("addon_primary_action")
    const help = document.createElement("p")
    help.className = "settings_group_hint"
    help.textContent = hint
    item.append(button, help)
    actions.append(item)
  }
  if (controls?.kind === "shadowed") {
    // The installed copy runs; the linked folder is where its updates come
    // from. One card says both, and only a folder with newer files asks for
    // anything.
    summary.textContent = addonOriginSentence(entry)
    const folder = document.createElement("p")
    folder.className = "addon_source_folder"
    folder.dataset.testid = "addon-source-folder"
    const version = controls.version ? ` (${controls.version})` : ""
    folder.textContent = controls.upToDate
      ? `Linked folder, up to date: the installed copy holds its current files${version}.`
      : `Linked folder with newer files${version}: the installed copy does not have them yet.`
    if (!controls.upToDate) card.classList.add("addon_source--update")
    summary.after(folder)
    location(controls.directory, folder)
    if (controls.replace && !controls.upToDate) action("Update installed copy from folder", "Replaces the installed copy's files with the folder's. Settings and tokens stay. Needs add-on sync.", controls.replace, "addon-source-replace", true)
    if (controls.useFolder) action("Run from the folder instead", "Runs the folder directly on this device, reloading when you save, without sync. Settings and tokens carry over; the installed copy is removed.", controls.useFolder, "addon-source-use-folder")
    if (controls.unload) action("Unload folder", "Forgets the folder link. The files stay where they are.", controls.unload, "addon-source-unload")
  } else if (dev) {
    summary.textContent = "Runs from a linked folder on this device and reloads when you save. Nothing about it is synced."
    if (controls) location(controls.directory)
    if (controls?.install) action("Install this version", "Saves the folder's current files as an installed copy, synced to your devices with add-on sync. The folder stays linked, so the installed copy can be updated from it later.", controls.install, "addon-source-install", true)
    if (controls?.unload) action("Unload folder", "Stops running the addon from this folder. The files and its local settings stay.", controls.unload, "addon-source-unload")
  } else if (entry.source) {
    summary.textContent = addonOriginSentence(entry)
    location(entry.source.url)
    action("Check for updates", "Reviews every add-on installed from a URL for a newer version.", () => {
      document.querySelector<HTMLButtonElement>('[data-testid="update-addons"]')?.click()
    }, "addon-source-check-updates")
  } else {
    summary.textContent = addonOriginSentence(entry)
  }
  return card
}

function optionField(addon: string, name: string, property: ConfigSchema, value: unknown, save: (value: unknown) => Promise<void>,
  suggestions?: (input: HTMLInputElement) => HTMLElement[]): HTMLElement | null {
  const control = createSchemaControl(property, value, { id: `addon_option_${addon}_${name}`, testid: `addon-option-${addon}-${name}`, json: true })
  if (!control) return null
  const field = fieldShell(property, name, control.input.id)
  const status = document.createElement("span")
  status.setAttribute("role", "status")
  const commit = async () => {
    try {
      await save(control.read())
      delete control.input.dataset.dirty
      status.textContent = "Saved"
      window.dispatchEvent(new CustomEvent<OptionSaved>(OPTION_SAVED_EVENT, { detail: { addon, field: name } }))
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error) }
  }
  control.input.addEventListener("input", () => { control.input.dataset.dirty = "true"; status.textContent = "Unsaved" })
  control.input.addEventListener("change", () => { void commit() })
  field.append(control.input)
  if ("default" in property && property.default !== undefined) field.append(resetToDefault(field, control, property.default, commit))
  field.append(status)
  if (suggestions && control.input instanceof HTMLInputElement) field.append(...suggestions(control.input))
  return field
}

/** An option or token of an add-on was saved from its page; the fields that depend on it listen. */
const OPTION_SAVED_EVENT = "once:addon-option-saved"
interface OptionSaved { addon: string; field: string; token?: true }
/** The select entry that hands the model field back to typing. */
const OTHER_MODEL = "\u0000other"

/**
 * The provider's own model list behind a text setting: once loaded, a select
 * stands in for the input, with "Other…" bringing the input back for a model
 * the list does not name. The list comes from the connection the setting
 * names (or the one named by another setting, such as a provider choice), and
 * until one is loaded the setting stays a plain text field. Each connection keeps its own
 * list, so switching provider shows that provider's models, not the last
 * ones loaded. The list loads by itself once the connection's endpoint and
 * token are saved, and again on the Load models button.
 */
function modelSuggestions(client: OnceClient, entry: AddonEntry, source: NonNullable<ConfigSchema["suggestions"]>,
  values: Record<string, unknown>, localOnly: boolean): (input: HTMLInputElement) => HTMLElement[] {
  const lists = new Map<string, AddonModel[]>()
  return input => {
    const picker = document.createElement("select")
    picker.id = `${input.id}_models`
    picker.dataset.testid = `${input.dataset.testid}-models`
    picker.setAttribute("aria-label", "Models the provider offers")
    const status = document.createElement("span")
    status.setAttribute("role", "status")
    status.className = "addon_option_models_status"
    const connection = () => {
      const id = source.connection ?? String(values[source.connectionField ?? ""] ?? "")
      return entry.manifest.connections?.find(item => item.id === id)
    }
    // One control at a time: the select once a list is loaded, the text field
    // only for a model the list does not name (chosen through "Other…").
    const show = () => {
      const current = connection()
      const models = (current && lists.get(current.id)) ?? []
      const other = document.createElement("option")
      other.value = OTHER_MODEL
      other.textContent = "Other model ID…"
      picker.replaceChildren(...models.map(model => {
        const option = document.createElement("option")
        option.value = model.id
        option.textContent = model.name ? `${model.id} — ${model.name}` : model.id
        return option
      }), other)
      picker.hidden = !models.length
      const listed = models.some(model => model.id === input.value)
      choose(listed ? input.value : OTHER_MODEL)
      input.hidden = listed
    }
    const choose = (value: string) => { for (const option of picker.querySelectorAll("option")) option.selected = option.value === value }
    const load = async (quiet = false) => {
      const current = connection()
      if (!current?.models) { if (!quiet) status.textContent = "This provider does not list its models."; return }
      status.textContent = "Loading models…"
      try {
        const models = await client.listAddonModels(entry.manifest, values, current.id, localOnly)
        lists.set(current.id, models)
        show()
        status.textContent = models.length ? `${models.length} models listed.` : "The provider listed no models."
      } catch (error) { status.textContent = error instanceof Error ? error.message : String(error) }
    }
    // Loads on its own only when the connection can answer: endpoint set and, where one is declared, a token saved for it.
    const loadIfReady = async () => {
      const current = connection()
      if (!current?.models || lists.has(current.id) || !String(values[current.endpoint] ?? "").trim()) return
      const ready = !current.secret || await client.hasAddonSecret(entry.manifest.id, current.secret, String(values[current.endpoint]), localOnly).catch(() => false)
      if (ready) await load(true)
    }
    picker.addEventListener("change", () => {
      if (picker.value === OTHER_MODEL) { input.hidden = false; input.focus(); return }
      input.hidden = true
      input.value = picker.value
      input.dispatchEvent(new Event("input"))
      input.dispatchEvent(new Event("change"))
    })
    const saved = (event: Event) => {
      if (!picker.isConnected) { window.removeEventListener(OPTION_SAVED_EVENT, saved); return }
      const detail = (event as CustomEvent<OptionSaved>).detail
      if (detail.addon !== entry.manifest.id) return
      const current = connection()
      if (detail.field === source.connectionField) { show(); void loadIfReady() }
      else if (current && (detail.field === current.endpoint || (detail.token && detail.field === current.secret))) { lists.delete(current.id); show(); void loadIfReady() }
    }
    window.addEventListener(OPTION_SAVED_EVENT, saved)
    const button = addonButton("Load models", () => load())
    button.dataset.testid = `${input.dataset.testid}-load-models`
    show()
    void loadIfReady()
    return [picker, button, status]
  }
}

/**
 * A quiet "Restore default" on the field's label line, shown only while the
 * value differs from the default (which its tooltip names), rather than a
 * button under every field whether or not there is anything to restore.
 */
function resetToDefault(field: HTMLElement, control: { input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; read(): unknown },
  fallback: unknown, commit: () => Promise<void>): HTMLButtonElement {
  const shown = typeof fallback === "string" ? fallback : JSON.stringify(fallback)
  const reset = addonButton("Restore default", async () => {
    if (control.input instanceof HTMLInputElement && control.input.type === "checkbox") control.input.checked = fallback === true
    else control.input.value = String(fallback)
    await commit()
    update()
  })
  reset.classList.add("addon_option_reset")
  reset.title = `Default: ${shown.length > 200 ? `${shown.slice(0, 200)}…` : shown || "empty"}`
  const update = (): void => {
    let current: unknown
    try { current = control.read() } catch { current = undefined }
    reset.hidden = JSON.stringify(current) === JSON.stringify(fallback)
  }
  control.input.addEventListener("input", update)
  control.input.addEventListener("change", update)
  field.addEventListener("addon-options-received", update)
  update()
  return reset
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
    if (!connection) return ""
    // The endpoint field saves on change, which is still in flight when the
    // reader goes straight from typing it to "Save token": read what is typed.
    const typed = document.getElementById(`addon_option_${entry.manifest.id}_${connection.endpoint}`)
    if (typed instanceof HTMLInputElement || typed instanceof HTMLTextAreaElement) return typed.value.trim()
    return String(values[connection.endpoint] ?? "")
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
      window.dispatchEvent(new CustomEvent<OptionSaved>(OPTION_SAVED_EVENT, { detail: { addon: entry.manifest.id, field: name, token: true } }))
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error) }
  }
  field.append(input, addonButton("Save token", () => save(input.value)), addonButton("Clear token", () => save("")), status)
  return field
}

/**
 * The host's own setting for any add-on whose tray runs on web pages: where
 * those conversations open. Not part of the add-on's options; remembered on
 * this device, like the other layout choices. Mobile shows them inline instead.
 */
function conversationPlaceField(manifest: AddonEntry["manifest"]): HTMLElement[] {
  const converses = (manifest.contributions ?? []).some(contribution => contribution.kind === "action" && "tray" in contribution.run
    && contribution.surfaces.some(surface => surface === "menu" || surface === "button"))
  if (!converses || !canChooseConversationPlacement()) return []
  const heading = document.createElement("h3")
  heading.className = "settings_subheading"
  heading.textContent = "On web pages"
  const select = document.createElement("select")
  select.id = `addon_place_${manifest.id}`
  select.dataset.testid = `addon-place-${manifest.id}`
  for (const [value, text] of [["tab", "A new tab"], ["panel", "The Once panel, beside the page"]]) select.append(new Option(text, value))
  select.value = pageConversationPlace(manifest.id)
  const field = fieldShell({ type: "string", label: "Open conversations in",
    description: "For this add-on's actions on a web page, such as its entry in the page's context menu. The Once panel keeps the page in view, and its menu entry goes away when you close it. Remembered on this device." },
  "place", select.id)
  const status = document.createElement("span")
  status.setAttribute("role", "status")
  select.addEventListener("change", () => {
    setPageConversationPlace(manifest.id, select.value === "panel" ? "panel" : "tab")
    status.textContent = "Saved"
  })
  field.append(select, status)
  return [heading, field]
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
