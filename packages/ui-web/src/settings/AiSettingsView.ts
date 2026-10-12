import { OnceClient } from "@once/app"
import { AiConnection, AiSettings, SearchConnection } from "@once/core"
import { openSettingsPage, registerSettingsOverview } from "./SettingsNavigation"
import { actions, button, feedback, heading, linkRow, select, field, pageTitle, retainAiFocus, restoreAiFocus } from "./aiForm"
import { openConnectionEditor } from "./aiConnectionEditor"
import { modelSummary, openModelPicker } from "./aiModelPicker"
import { aiConsumers, AI_CONSUMERS_CHANGED, openAiConsumer } from "./aiConsumers"
import { SYNC_PAGE_EVENT, SyncPageRequest } from "./syncSettingsPages"

export function openSharedSync(): void {
  document.querySelector<HTMLButtonElement>('[data-settings-target="sync"]')?.click()
  document.dispatchEvent(new CustomEvent<SyncPageRequest>(SYNC_PAGE_EVENT, { detail: { page: "addons", replace: true } }))
}
export function bindAiSettings(client: OnceClient, root: HTMLElement): void {
  root.replaceChildren()
  const overview = document.createElement("div"); overview.className = "ai_overview"; root.append(overview)
  let settings: AiSettings
  let revision = 0
  const show = () => { pageTitle(root, "AI & Search"); for (const child of root.children) (child as HTMLElement).hidden = child !== overview; void refresh() }
  const edit = (connection: AiConnection | SearchConnection, draft = false) => openConnectionEditor(root, client, connection, draft, show)
  const refresh = async () => {
    const current = ++revision
    try {
      const loaded = await client.getAiSettings()
      const tokens = await Promise.all(loaded.connections.map(item => client.hasAiToken(item.id)))
      if (current !== revision) return
      settings = loaded; retainAiFocus(root); overview.replaceChildren()
      overview.append(linkRow("Default model", modelSummary(settings, null), () => openModelPicker(root, client, settings, null, "Default model", show)))
      heading(overview, "Connections")
      if (!settings.connections.length) { const empty = document.createElement("p"); empty.className = "settings_rows_hint"; empty.textContent = "Add a connection to use AI in addons and Reader."; overview.append(empty) }
      settings.connections.forEach((connection, index) => overview.append(linkRow(connection.name, `${connection.provider} · ${tokens[index] ? "Token configured" : connection.provider === "compatible" ? "No token" : "Token needed"}`, () => edit(connection))))
      actions(overview, button("Add connection", () => edit({ id: `ai-${crypto.randomUUID()}`, name: "", provider: "openai", endpoint: "https://api.openai.com/v1/responses" }, true)))
      const search = settings.searchConnections.find(item => item.id === settings.defaultSearch)
      overview.append(linkRow("Search", `${search?.name ?? "No default"} · ${settings.searchConnections.length} connections`, openSearch))
      heading(overview, "Used by")
      for (const consumer of aiConsumers()) overview.append(linkRow(consumer.name, `${consumer.enabled ? "" : "Disabled · "}${modelSummary(settings, consumer.id)}`, () => openAiConsumer(consumer)))
      const state = await client.getSyncVaultStatus()
      if (current !== revision) return
      overview.append(linkRow("Sync", state.message, openSharedSync)); restoreAiFocus(root)
    } catch (error) {
      if (current !== revision) return
      overview.replaceChildren(linkRow("Sync needs attention", error instanceof Error ? error.message : String(error), openSharedSync))
    }
  }
  const openSearch = () => {
    const page = document.createElement("section"); page.className = "settings_rows ai_editor"
    for (const connection of settings.searchConnections) page.append(linkRow(connection.name, connection.provider, () => edit(connection)))
    actions(page, button("Add search connection", () => edit({ id: `search-${crypto.randomUUID()}`, name: "", provider: "searxng", endpoint: "" }, true)))
    const choice = select([["", "No default"], ...settings.searchConnections.map(item => [item.id, item.name] as [string, string])], settings.defaultSearch ?? "")
    field(page, "Default search", choice)
    const status = feedback(page)
    choice.onchange = () => { void client.setDefaultSearch(choice.value || undefined).then(() => { status.textContent = "Saved" }, error => { status.textContent = error.message }) }
    openSettingsPage(root, { key: "search", title: () => "Search", show: () => { pageTitle(root, "Search"); for (const child of root.children) (child as HTMLElement).hidden = true; page.hidden = false; if (!page.isConnected) root.append(page) }, leave: () => { page.hidden = true } })
  }
  registerSettingsOverview(root, show)
  client.subscribe("settingsChanged", ({ section }) => { if (section === "ai" || section === "addons" || section === "sync") void refresh() })
  document.addEventListener(AI_CONSUMERS_CHANGED, () => void refresh())
  void refresh()
}
