import { AddonEntry } from "@once/core"

export interface AiConsumer { id: string; name: string; detail: string; enabled: boolean; owner: "reader" | "addon" }
const builtins: AiConsumer[] = [
  // The id predates the single reader action; keeping it keeps the model people chose.
  { id: "reader.formatting", name: "Reader AI", detail: "Pages, images and PDFs", enabled: true, owner: "reader" }
]
let addons: AiConsumer[] = []
export const AI_CONSUMERS_CHANGED = "once:ai-consumers-changed"
export function aiConsumers(): AiConsumer[] { return [...builtins, ...addons] }
export function registerAddonAiConsumers(entries: AddonEntry[]): void {
  const next = entries.filter(entry => entry.manifest.capabilities.includes("ai")).map(entry => ({ id: entry.manifest.id, name: entry.manifest.shortName ?? entry.manifest.name, detail: "Add-on", enabled: entry.enabled, owner: "addon" as const }))
  if (JSON.stringify(next) === JSON.stringify(addons)) return
  addons = next
  document.dispatchEvent(new Event(AI_CONSUMERS_CHANGED))
}
export function openAiConsumer(consumer: AiConsumer): void {
  document.querySelector<HTMLButtonElement>(`[data-settings-target="${consumer.owner === "reader" ? "reader" : "addons"}"]`)?.click()
  if (consumer.owner === "addon") {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="open-addon-settings"]')].find(item => item.dataset.addonId === consumer.id)
    button?.click()
  } else document.getElementById(`ai-consumer-${consumer.id}`)?.focus()
}
