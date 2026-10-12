import { OnceClient } from "@once/app"
import { aiConsumers } from "./aiConsumers"
import { button, card, feedback, linkRow, pageTitle, retainAiFocus, restoreAiFocus } from "./aiForm"
import { modelSummary, openModelPicker } from "./aiModelPicker"
import { registerSettingsOverview } from "./SettingsNavigation"

export function bindConsumerModel(client: OnceClient, parent: HTMLElement, consumer: string, name: string): void {
  const holder = document.createElement("div"); holder.className = "ai_consumer_model"; parent.append(holder)
  let revision = 0
  const refresh = async () => {
    const current = ++revision
    try {
      const settings = await client.getAiSettings()
      if (current !== revision || !holder.isConnected) return
      const row = linkRow("AI model", modelSummary(settings, consumer), () => {
        const root = parent.closest<HTMLElement>("#addon_install_settings") ?? parent
        const done = () => {
          pageTitle(root, consumer.startsWith("reader.") ? "Reader" : name)
          for (const child of root.children) (child as HTMLElement).hidden = (child as HTMLElement).classList.contains("ai_editor")
          if (consumer.startsWith("reader.")) { for (const child of root.children) if (!(child as HTMLElement).classList.contains("ai_editor")) (child as HTMLElement).hidden = false }
          else root.dispatchEvent(new CustomEvent("once:addon-reveal", { detail: parent }))
          void refresh()
        }
        openModelPicker(root, client, settings, consumer, `${name} model`, done)
      })
      row.id = `ai-consumer-${consumer}`; row.dataset.aiFocusKey = consumer
      const root = parent.closest<HTMLElement>("#addon_install_settings") ?? parent
      retainAiFocus(root); holder.replaceChildren(row); restoreAiFocus(root)
    } catch (error) { holder.replaceChildren(); feedback(holder).textContent = error instanceof Error ? error.message : String(error) }
  }
  client.subscribe("settingsChanged", ({ section }) => { if (section === "ai") void refresh() })
  queueMicrotask(() => void refresh())
}
export function bindReaderSettings(client: OnceClient, root: HTMLElement): void {
  const overview = document.createElement("section"); overview.className = "settings_rows ai_overview"; root.append(overview)
  const intro = document.createElement("p"); intro.className = "ai_intro"; intro.textContent = "The model Reader AI uses to rewrite pages, images and PDFs."; overview.append(intro)
  for (const consumer of aiConsumers().filter(item => item.owner === "reader")) {
    const group = card(overview, consumer.name)
    // Use the owning page as navigation root while each section retains its label.
    bindConsumerModel(client, root, consumer.id, consumer.name)
    const holder = root.lastElementChild; if (holder) group.append(holder)
  }
  const note = document.createElement("p"); note.className = "ai_sync_note"
  const link = button("Open AI & Search", () => document.querySelector<HTMLButtonElement>('[data-settings-target="ai"]')?.click()); link.className = "ai_inline_link"
  note.append("Connections and the default model are set in AI & Search · ", link); overview.append(note)
  registerSettingsOverview(root, () => { pageTitle(root, "Reader"); for (const child of root.children) (child as HTMLElement).hidden = child !== overview })
}
