import { OnceClient } from "@once/app"
import { aiConsumers } from "./aiConsumers"
import { feedback, linkRow, pageTitle, retainAiFocus, restoreAiFocus } from "./aiForm"
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
  const overview = document.createElement("section"); overview.className = "settings_rows"; root.append(overview)
  for (const consumer of aiConsumers().filter(item => item.owner === "reader")) {
    const group = document.createElement("section"); group.className = "settings_rows"
    const heading = document.createElement("h4"); heading.className = "settings_subheading"; heading.textContent = consumer.name
    group.append(heading); overview.append(group)
    // Use the owning page as navigation root while each section retains its label.
    bindConsumerModel(client, root, consumer.id, consumer.name)
    const holder = root.lastElementChild; if (holder) group.append(holder)
  }
  registerSettingsOverview(root, () => { pageTitle(root, "Reader"); for (const child of root.children) (child as HTMLElement).hidden = child !== overview })
}
