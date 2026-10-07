import { OnceClient } from "@once/app"
import { getAddonStatus, onAddonStatus, retryAddon } from "../addons/addonStatus"
import { addonOrigin, addonRuntimeLabel, showAddonRuntime } from "./addonPresentation"

export function addonButton(label: string, run: () => Promise<void> | void): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "button"
  button.textContent = label
  button.addEventListener("click", () => {
    button.disabled = true
    void Promise.resolve().then(run).catch(error => {
      const status = button.closest("fieldset")?.querySelector<HTMLElement>("[role=status]")
      if (status) status.textContent = error instanceof Error ? error.message : String(error)
    }).finally(() => { button.disabled = false })
  })
  return button
}

/**
 * The head of an add-on's page: its state on one side, what can be done
 * about it on the other. Retry shows only when the script failed or stopped.
 */
export function addonHead(state: HTMLElement, buttons: HTMLElement[]): HTMLElement {
  const head = document.createElement("div")
  head.className = "addon_head"
  state.classList.add("addon_runtime_status")
  state.setAttribute("role", "status")
  const actions = document.createElement("div")
  actions.className = "addon_head_actions"
  actions.append(...buttons)
  head.append(state, actions)
  return head
}

/** Device status changes update text in place so focus stays on the user's control. */
export function bindAddonManagement(client: OnceClient, parent: HTMLElement): void {
  const list = document.createElement("div")
  list.id = "addon_installed"
  list.setAttribute("aria-label", "Installed add-ons")
  parent.prepend(list)
  let revision = 0
  let signature = ""
  const status = (): void => {
    for (const row of list.querySelectorAll<HTMLElement>("[data-addon-id]")) {
      const text = row.querySelector<HTMLElement>(".addon_runtime_status")
      if (!text) continue
      showAddonRuntime(text, row.querySelector<HTMLElement>('[data-action="retry"]'),
        addonRuntimeLabel(getAddonStatus(row.dataset.addonId ?? ""), row.dataset.enabled === "true"))
    }
  }
  const render = async (): Promise<void> => {
    const current = ++revision
    const doc = await client.getAddons()
    if (current !== revision) return
    const nextSignature = JSON.stringify(doc.addons.map(({ manifest, enabled }) => ({ manifest, enabled })))
    if (signature === nextSignature) { status(); return }
    signature = nextSignature
    list.replaceChildren()
    for (const entry of doc.addons) {
      const id = entry.manifest.id
      const row = document.createElement("fieldset")
      row.className = "settings_group"
      row.dataset.addonId = id
      row.dataset.enabled = String(entry.enabled)
      row.dataset.addonName = entry.manifest.name
      row.dataset.addonVersion = entry.manifest.version
      row.dataset.addonOrigin = addonOrigin(entry)
      const title = document.createElement("legend")
      title.textContent = `${entry.manifest.name} ${entry.manifest.version}`
      const toggle = addonButton(entry.enabled ? "Disable" : "Enable", () => client.updateAddons(doc => ({
        ...doc, addons: doc.addons.map(item => item.manifest.id === id ? { ...item, enabled: !item.enabled } : item)
      })))
      const remove = addonButton("Remove", () => client.updateAddons(doc => ({
        ...doc, addons: doc.addons.filter(item => item.manifest.id !== id)
      })))
      const buttons = [toggle, remove]
      if (entry.enabled && entry.manifest.script) {
        const retry = addonButton("Retry", () => retryAddon(id))
        retry.dataset.action = "retry"
        retry.hidden = true
        buttons.unshift(retry)
      }
      row.append(title, addonHead(document.createElement("p"), buttons))
      list.append(row)
    }
    status()
  }
  const refresh = (): void => { void render().catch(error => { list.textContent = `Could not load add-ons: ${String(error)}` }) }
  onAddonStatus(status)
  client.subscribe("settingsChanged", ({ section }) => { if (section === "addons") refresh() })
  refresh()
}
