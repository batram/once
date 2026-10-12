import { OnceClient } from "@once/app"
import { AiConnection, AiSettings, SearchConnection } from "@once/core"
import { openSettingsPage, registerSettingsOverview } from "./SettingsNavigation"
import { addRow, badge, button, card, feedback, linkRow, providerIcon, providerLabels, select, field, pageTitle, retainAiFocus, restoreAiFocus } from "./aiForm"
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
      const intro = document.createElement("p"); intro.className = "ai_intro"; intro.textContent = "Models that Reader AI and add-ons run on, and the web search they can call."; overview.append(intro)
      const pickDefault = () => openModelPicker(root, client, settings, null, "Default model", show)
      const chosen = settings.defaultModel, via = settings.connections.find(item => item.id === chosen?.connection)?.name ?? "Unavailable connection"
      // The model is the row's title, so the heading carries "Default model"; the accessible name keeps both.
      card(overview, "Default model").append(chosen
        ? linkRow(chosen.model, `via ${via} · used unless a feature picks its own`, pickDefault, { key: "Default model", label: `Default model: ${modelSummary(settings, null)}` })
        : linkRow("Choose a model", "No default model yet", pickDefault, { key: "Default model", label: "Default model: Not configured", badge: badge("Not set", "warn") }))
      const connections = card(overview, "Connections")
      if (!settings.connections.length) { const empty = document.createElement("p"); empty.className = "settings_rows_hint"; empty.textContent = "Add a connection to use AI in addons and Reader."; connections.append(empty) }
      settings.connections.forEach((connection, index) => connections.append(linkRow(connection.name, providerLabels[connection.provider] ?? connection.provider, () => edit(connection), {
        icon: providerIcon(connection.provider, connection.name),
        badge: tokens[index] ? badge("Token set", "ok") : connection.provider === "compatible" ? badge("No token") : badge("Token needed", "warn")
      })))
      connections.append(addRow("Add connection", () => edit({ id: `ai-${crypto.randomUUID()}`, name: "", provider: "openai", endpoint: "https://api.openai.com/v1/responses" }, true)))
      const search = settings.searchConnections.find(item => item.id === settings.defaultSearch), count = settings.searchConnections.length
      card(overview, "Web search").append(linkRow("Search connections", `${count} ${count === 1 ? "connection" : "connections"}`, openSearch, { badge: search ? badge(`Default: ${search.name}`) : badge("No default", "warn") }))
      const used = card(overview, "Used by")
      for (const consumer of aiConsumers()) {
        const inherited = !settings.overrides[consumer.id]
        const state = !consumer.enabled ? badge("Disabled") : inherited ? badge("Default model") : undefined
        used.append(linkRow(consumer.name, modelSummary(settings, inherited ? null : consumer.id), () => openAiConsumer(consumer), { badge: state }))
      }
      const state = await client.getSyncVaultStatus()
      if (current !== revision) return
      // Sync carries these settings rather than using AI, so it is a status line, not a row under "Used by".
      const sync = document.createElement("p"); sync.className = "ai_sync_note"
      const link = button("Sync", openSharedSync); link.className = "ai_inline_link"; link.setAttribute("aria-label", `Sync: ${state.message}`)
      sync.append(link, ` · ${state.message}`); overview.append(sync); restoreAiFocus(root)
    } catch (error) {
      if (current !== revision) return
      overview.replaceChildren(linkRow("Sync needs attention", error instanceof Error ? error.message : String(error), openSharedSync))
    }
  }
  // One page, rebuilt on each visit: building a new one per visit left every earlier copy hidden in the section.
  let searchPage: HTMLElement | undefined
  const openSearch = () => {
    const page = searchPage ??= document.createElement("section"); page.className = "settings_rows ai_editor"; page.replaceChildren()
    const list = card(page, "Search connections")
    for (const connection of settings.searchConnections) list.append(linkRow(connection.name, providerLabels[connection.provider] ?? connection.provider, () => edit(connection), { icon: providerIcon(connection.provider, connection.name) }))
    list.append(addRow("Add search connection", () => edit({ id: `search-${crypto.randomUUID()}`, name: "", provider: "searxng", endpoint: "" }, true)))
    const choice = select([["", "No default"], ...settings.searchConnections.map(item => [item.id, item.name] as [string, string])], settings.defaultSearch ?? "")
    const defaults = card(page, "Default search")
    field(defaults, "Default search", choice)
    const status = feedback(defaults); status.classList.add("ai_card_note")
    choice.onchange = () => { void client.setDefaultSearch(choice.value || undefined).then(() => { status.textContent = "Saved" }, error => { status.textContent = error.message }) }
    openSettingsPage(root, { key: "search", title: () => "Search", show: () => { pageTitle(root, "Search"); for (const child of root.children) (child as HTMLElement).hidden = true; page.hidden = false; if (!page.isConnected) root.append(page) }, leave: () => { page.hidden = true } })
  }
  registerSettingsOverview(root, show)
  client.subscribe("settingsChanged", ({ section }) => { if (section === "ai" || section === "addons" || section === "sync") void refresh() })
  document.addEventListener(AI_CONSUMERS_CHANGED, () => void refresh())
  void refresh()
}
