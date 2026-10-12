import { showConfirmDialog } from "../confirmDialog"
import { OnceClient } from "@once/app"
import { AiConnection, SearchConnection } from "@once/core"
import { completeSettingsPage, openSettingsPage, SettingsPage } from "./SettingsNavigation"
import { actions, button, feedback, field, input, select, pageTitle, editorReturn } from "./aiForm"

const drafts = new WeakMap<HTMLElement, Map<string, SettingsPage>>()
const endpoints: Record<string, string> = { openai: "https://api.openai.com/v1/responses", anthropic: "https://api.anthropic.com/v1/messages", compatible: "", tavily: "https://api.tavily.com/search", searxng: "" }
export function openConnectionEditor(root: HTMLElement, client: OnceClient, connection: AiConnection | SearchConnection, draft: boolean, done: () => void): void {
  const key = draft ? `new:${connection.provider === "searxng" || connection.provider === "tavily" ? "search" : "ai"}` : connection.id
  const editors = drafts.get(root) ?? new Map<string, SettingsPage>(); drafts.set(root, editors)
  const previous = editors.get(key)
  if (previous) { openSettingsPage(root, previous); return }
  done = editorReturn(root, done, connection.provider === "searxng" || connection.provider === "tavily" ? "Search" : draft ? "Add connection" : connection.name)
  const editor = document.createElement("section"); editor.className = "settings_rows ai_editor"
  const search = connection.provider === "searxng" || connection.provider === "tavily"
  const name = input("text", connection.name)
  name.dataset.testid = "ai-connection-name"
  const provider = select((search ? ["searxng", "tavily"] : ["openai", "anthropic", "compatible"]).map(value => [value, ({ openai: "OpenAI", anthropic: "Anthropic", compatible: "Compatible server", searxng: "SearXNG", tavily: "Tavily" } as Record<string, string>)[value]]), connection.provider)
  provider.dataset.testid = "ai-connection-provider"
  const token = input("password"); token.autocomplete = "new-password"; token.placeholder = draft ? "Enter token (optional for local servers)" : "Leave blank to keep the saved token"
  token.dataset.testid = "ai-connection-token"
  field(editor, "Name", name); field(editor, "Provider", provider); field(editor, "API token", token)
  const tokenState = feedback(editor)
  let removeToken = false
  if (!draft) void client.hasAiToken(connection.id).then(has => { tokenState.textContent = has ? "Token configured" : "No token configured" }).catch(error => { tokenState.textContent = error.message })
  const clear = button("Remove saved token", () => { removeToken = !removeToken; tokenState.textContent = removeToken ? "Token will be removed when you save" : "Saved token retained"; clear.textContent = removeToken ? "Keep saved token" : "Remove saved token" })
  if (!draft) editor.append(clear)
  const advanced = document.createElement("details"); advanced.className = "settings_rows"
  const summary = document.createElement("summary"); summary.textContent = "Advanced"; advanced.append(summary)
  const endpoint = input("url", connection.endpoint); endpoint.dataset.testid = "ai-connection-endpoint"; field(advanced, "Request endpoint", endpoint)
  const anthropic = document.createElement("section"); anthropic.className = "settings_rows"
  const workspace = input("text", "workspace" in connection ? connection.workspace ?? "" : "")
  const effort = select(["default", "low", "medium", "high"].map(value => [value, value]), "effort" in connection ? connection.effort ?? "default" : "default")
  field(anthropic, "Workspace (optional)", workspace); field(anthropic, "Effort", effort); advanced.append(anthropic); editor.append(advanced)
  const visibility = () => { anthropic.hidden = provider.value !== "anthropic"; if (!endpoints[provider.value]) advanced.open = true }
  provider.onchange = () => { endpoint.value = endpoints[provider.value]; visibility() }; visibility()
  const status = feedback(editor)
  const save = button("Save", () => void (async () => {
    save.disabled = true
    try {
      if (!name.value.trim()) throw new Error("Give this connection a name")
      try { new URL(endpoint.value) } catch { throw new Error("Enter a complete request endpoint, starting with https:// or http://") }
      const value = { id: connection.id, name: name.value.trim(), provider: provider.value, endpoint: endpoint.value, ...(provider.value === "anthropic" ? { workspace: workspace.value, effort: effort.value } : {}) } as AiConnection | SearchConnection
      await client.editAiConnection({ connection: value, expected: draft ? null : connection, ...(token.value || removeToken ? { token: removeToken ? "" : token.value } : {}) })
      token.value = ""; editors.delete(key); completeSettingsPage(root); done(); editor.remove()
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error) }
    finally { save.disabled = false }
  })())
  save.dataset.testid = "ai-editor-save"
  actions(editor, save, button("Cancel", () => { token.value = ""; editors.delete(key); completeSettingsPage(root); done(); editor.remove() }))
  if (!draft) editor.append(button("Remove connection…", () => void (async () => {
    const settings = await client.getAiSettings()
    const affected = [settings.defaultModel?.connection === connection.id ? "Default model" : "", ...Object.entries(settings.overrides).filter(([, selection]) => selection.connection === connection.id).map(([id]) => id), settings.defaultSearch === connection.id ? "Default search" : ""].filter(Boolean)
    if (!await showConfirmDialog({ message: `Remove ${connection.name} and its saved token?${affected.length ? ` These selections will need attention: ${affected.join(", ")}.` : ""}`, confirmLabel: "Remove connection" })) return
    try { await client.removeAiConnection(connection.id, connection); editors.delete(key); completeSettingsPage(root); done(); editor.remove() } catch (error) { status.textContent = error instanceof Error ? error.message : String(error) }
  })()))
  const page: SettingsPage = { key: `connection:${connection.id}`, title: () => draft ? "New connection" : connection.name, show: () => { pageTitle(root, draft ? "New connection" : connection.name); for (const child of root.children) (child as HTMLElement).hidden = true; editor.hidden = false; if (!editor.isConnected) root.append(editor) }, leave: () => { editor.hidden = true } }
  editors.set(key, page); openSettingsPage(root, page)
}
