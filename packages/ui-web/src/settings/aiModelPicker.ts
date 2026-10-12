import { OnceClient } from "@once/app"
import { AiSelection, AiSettings } from "@once/core"
import { completeSettingsPage, openSettingsPage, SettingsPage } from "./SettingsNavigation"
import { actions, button, feedback, field, input, select, pageTitle, editorReturn } from "./aiForm"

const drafts = new WeakMap<HTMLElement, Map<string, SettingsPage>>()

export function modelSummary(settings: AiSettings, consumer: string | null): string {
  const override = consumer ? settings.overrides[consumer] : settings.defaultModel
  const selected = override ?? settings.defaultModel
  if (!selected) return consumer ? "Default · Not configured" : "Not configured"
  const connection = settings.connections.find(item => item.id === selected.connection)
  return `${consumer && !override ? "Default · " : ""}${connection?.name ?? "Unavailable connection"} · ${selected.model}`
}

/** The same mounted editor serves the global default and each owner's override. */
export function openModelPicker(root: HTMLElement, client: OnceClient, settings: AiSettings, consumer: string | null, label: string, done: () => void): void {
  const key = consumer ?? "default"
  const editors = drafts.get(root) ?? new Map<string, SettingsPage>(); drafts.set(root, editors)
  const previous = editors.get(key)
  if (previous) { openSettingsPage(root, previous); return }
  done = editorReturn(root, done, consumer ?? "Default model")
  const editor = document.createElement("section"); editor.className = "settings_rows ai_editor"
  const initial = consumer ? settings.overrides[consumer] : settings.defaultModel
  const mode = select([["default", "Use default"], ["custom", "Use another model"]], initial ? "custom" : "default")
  if (consumer) field(editor, "Model choice", mode)
  const custom = document.createElement("section"); custom.className = "settings_rows"
  const connection = select([["", "Choose a connection"], ...settings.connections.map(item => [item.id, item.name] as [string, string])], initial?.connection ?? "")
  connection.dataset.testid = "ai-model-connection"
  const model = input("text", initial?.model ?? ""); model.placeholder = "Choose or enter a model ID"
  model.dataset.testid = "ai-model-id"
  const list = document.createElement("datalist"); list.id = `models-${crypto.randomUUID()}`; model.setAttribute("list", list.id)
  field(custom, "Connection", connection); field(custom, "Model", model); custom.append(list)
  editor.append(custom)
  const status = feedback(editor)
  const cache = new Map<string, Awaited<ReturnType<OnceClient["listAiModels"]>>>()
  let revision = 0
  const display = () => { custom.hidden = !!consumer && mode.value === "default" }
  const discover = async (force = false) => {
    const id = connection.value, current = ++revision
    if (!id) return
    status.textContent = "Loading models…"
    try {
      const models = !force && cache.has(id) ? cache.get(id) ?? [] : await client.listAiModels(id)
      cache.set(id, models)
      if (current !== revision || connection.value !== id) return
      list.replaceChildren(...models.map(item => { const option = document.createElement("option"); option.value = item.id; option.label = item.name; return option }))
      status.textContent = `${models.length} models available. You can also enter a model ID.`
    } catch (error) { if (current === revision) status.textContent = `${error instanceof Error ? error.message : error} You can enter a model ID manually.` }
  }
  connection.onchange = () => { list.replaceChildren(); model.value = ""; void discover() }
  mode.onchange = display
  custom.append(button("Refresh models", () => void discover(true)))
  const save = button("Save", () => void (async () => {
    save.disabled = true
    try {
      const selection: AiSelection | undefined = consumer && mode.value === "default" ? undefined : { connection: connection.value, model: model.value }
      await client.setAiModel(consumer, selection)
      editors.delete(key); completeSettingsPage(root); done(); editor.remove()
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error) }
    finally { save.disabled = false }
  })())
  save.dataset.testid = "ai-editor-save"
  actions(editor, save, button("Cancel", () => { editors.delete(key); completeSettingsPage(root); done(); editor.remove() }))
  display()
  const page = { key: `model:${consumer ?? "default"}`, title: () => label, show: () => { pageTitle(root, label); for (const child of root.children) (child as HTMLElement).hidden = true; editor.hidden = false; if (!editor.isConnected) root.append(editor) }, leave: () => { editor.hidden = true } }
  editors.set(key, page)
  openSettingsPage(root, page)
  if (connection.value) void discover()
}
