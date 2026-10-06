import type { OnceClient, RemoteDeviceView, TabSyncView } from "@once/app"
import {
  ACTIVITY_WINDOW_CHOICES,
  DEFAULT_TAB_SYNC_OPTIONS,
  DEFAULT_TAB_SYNC_SHARED_SETTINGS,
  FRESHNESS_WINDOW_CHOICES,
  humanTime,
  normalizeExcludedDomains,
  SEND_RETENTION_CHOICES,
  STALE_DEVICE_CHOICES,
  TabSyncOptions
} from "@once/core"
import { requireElement } from "../dom"
import { showConfirmDialog } from "../confirmDialog"
import { platformName } from "../tabsync/devicePresentation"

const CHOICES: Record<string, readonly number[]> = {
  activityWindowMinutes: ACTIVITY_WINDOW_CHOICES,
  freshnessWindowMinutes: FRESHNESS_WINDOW_CHOICES,
  staleDeviceDays: STALE_DEVICE_CHOICES,
  sendRetentionDays: SEND_RETENTION_CHOICES
}

/** What the first-run offer's buttons turn on; "later" only remembers the answer. */
const OFFERS: Record<string, Partial<TabSyncOptions>> = {
  share: { enabled: true, sharing: true, offerAnswered: true },
  see: { enabled: true, sharing: false, offerAnswered: true },
  later: { offerAnswered: true }
}

/**
 * Settings › Sync beyond the database URL: data consent where the browser
 * asks for it, the offer to use tab sync, this device's name, the overview's
 * links and the Tab sync page with its master switch.
 */
export function bindTabSyncControls(client: OnceClient): void {
  const consent = requireElement<HTMLElement>("#sync_consent")
  const offer = requireElement<HTMLElement>("#tab_sync_offer")
  const device = requireElement<HTMLElement>("#sync_device_settings")
  const page = requireElement<HTMLElement>("#sync_page_tabs")
  const name = requireElement<HTMLInputElement>("#device_name_input")
  const notice = requireElement<HTMLElement>("#tab_sync_notice")
  const unavailable = requireElement<HTMLElement>("#tab_sync_unavailable")
  const list = requireElement<HTMLUListElement>("#tab_sync_devices")
  const excluded = requireElement<HTMLTextAreaElement>("#tab_sync_excluded")
  let revision = 0

  fillChoices(page)
  requireElement<HTMLButtonElement>("#sync_consent_button").addEventListener("click", () => {
    // Straight from the click: Firefox shows its prompt only during a user gesture.
    void client.requestSyncConsent().then(() => refresh())
  })
  for (const button of offer.querySelectorAll<HTMLButtonElement>("[data-offer]")) {
    button.addEventListener("click", () => void act(() => client.setTabSyncOptions(OFFERS[button.dataset.offer ?? "later"])))
  }
  name.addEventListener("change", () => void act(() => client.renameDevice(name.value)))
  requireElement<HTMLButtonElement>("#reset_device_button").addEventListener("click", () => void showConfirmDialog({
    message: "Give this device a new identity? Its current entry is removed from tab sync on every device.",
    confirmLabel: "Reset identity"
  }).then((confirmed) => { if (confirmed) void act(() => client.resetDeviceIdentity()) }))
  requireElement<HTMLButtonElement>("#tab_sync_defaults").addEventListener("click", () => void act(async () => {
    const { activityWindowMinutes, freshnessWindowMinutes, staleDeviceDays } = DEFAULT_TAB_SYNC_OPTIONS
    await client.setTabSyncOptions({ activityWindowMinutes, freshnessWindowMinutes, staleDeviceDays })
    await client.setTabSyncShared({ ...DEFAULT_TAB_SYNC_SHARED_SETTINGS })
  }))
  for (const control of page.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-option], [data-shared]")) {
    control.addEventListener("change", () => void act(() => save(control)))
  }

  const save = (control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
    if (control.dataset.shared) return client.setTabSyncShared({ [control.dataset.shared]: Number(control.value) })
    const option = control.dataset.option as keyof TabSyncOptions
    const value = control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked
      : control instanceof HTMLSelectElement ? Number(control.value)
        : normalizeExcludedDomains(control.value)
    // Switching tab sync on from its page answers the first-run offer too.
    return client.setTabSyncOptions(option === "enabled" ? { enabled: value === true, offerAnswered: true } : { [option]: value })
  }

  const act = async (work: () => Promise<void>) => {
    notice.hidden = true
    try {
      await work()
    } catch (error) {
      notice.hidden = false
      notice.textContent = error instanceof Error ? error.message : "Tab sync settings could not be saved"
    }
    await refresh()
  }

  const refresh = async () => {
    const current = ++revision
    const [consentState, view, vault] = await Promise.all([
      client.getSyncConsent().catch(() => "not-needed" as const),
      client.getTabSync().catch(() => null),
      client.getAddonVaultStatus().catch(() => null)
    ])
    if (current !== revision) return
    const connected = client.getSyncStatus().state !== "disabled"
    consent.hidden = consentState !== "required"
    device.hidden = !view
    offer.hidden = !view || !connected || view.options.enabled || view.options.offerAnswered
    summarize("#sync_page_tabs_summary", tabsSummary(view, connected))
    summarize("#sync_page_pair_summary", connected ? "Show a code, or connect with one" : "Connect with a code from another device")
    summarize("#sync_page_addons_summary", vault ? VAULT_SUMMARIES[vault.state] ?? "" : "")
    unavailable.hidden = connected
    if (view) render(view)
  }

  const render = (view: TabSyncView) => {
    if (document.activeElement !== name) name.value = view.self?.name ?? ""
    if (document.activeElement !== excluded) excluded.value = view.options.excludedDomains.join("\n")
    for (const section of page.querySelectorAll<HTMLElement>("[data-tab-sync-on]")) {
      // The Electron placement group stays hidden on every other shell.
      if (section.id === "remote_tabs_placement_row" && !section.dataset.platformShown) continue
      section.hidden = !view.options.enabled
    }
    for (const section of page.querySelectorAll<HTMLElement>("[data-tab-sync-share]")) {
      section.hidden ||= !view.canShare
    }
    for (const row of page.querySelectorAll<HTMLElement>("[data-tab-sync-shares]")) row.hidden = !view.options.sharing
    for (const control of page.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[data-option], select[data-option]")) {
      const value = view.options[control.dataset.option as keyof TabSyncOptions]
      if (control instanceof HTMLInputElement) control.checked = value === true
      else control.value = String(value)
    }
    requireElement<HTMLSelectElement>("#tab_sync_retention").value = String(view.shared.sendRetentionDays)
    if (view.notice) {
      notice.hidden = false
      notice.textContent = view.notice
    }
    list.replaceChildren(...(view.devices.length
      ? view.devices.map((entry) => deviceRow(entry, () => act(() => client.forgetDevice(entry.deviceId))))
      : [emptyRow()]))
  }

  client.subscribe("tabSyncChanged", () => void refresh())
  client.subscribe("syncStatusChanged", () => void refresh())
  void refresh()
}

const VAULT_SUMMARIES: Record<string, string> = {
  disabled: "Off", locked: "Locked on this device", ready: "On", conflict: "Needs attention", error: "Needs attention"
}

function tabsSummary(view: TabSyncView | null, connected: boolean): string {
  if (!view) return ""
  if (!view.options.enabled) return "Off"
  if (!connected) return "On · waiting for sync"
  const devices = view.devices.length
  return ["On", ...(view.options.sharing ? ["sharing"] : []), `${devices} other device${devices === 1 ? "" : "s"}`].join(" · ")
}

function summarize(selector: string, text: string): void {
  const element = document.querySelector<HTMLElement>(selector)
  if (element) element.textContent = text
}

function fillChoices(root: HTMLElement): void {
  for (const select of root.querySelectorAll<HTMLSelectElement>("select[data-option], select[data-shared]")) {
    const key = select.dataset.option ?? select.dataset.shared ?? ""
    const unit = select.dataset.unit === "days" ? "day" : "minute"
    select.replaceChildren(...(CHOICES[key] ?? []).map((value) => {
      const option = document.createElement("option")
      option.value = String(value)
      option.textContent = unit === "minute" && value >= 60
        ? `${value / 60} hour${value === 60 ? "" : "s"}`
        : `${value} ${unit}${value === 1 ? "" : "s"}`
      return option
    }))
  }
}

function deviceRow(device: RemoteDeviceView, remove: () => void): HTMLLIElement {
  const row = document.createElement("li")
  row.className = "tab_sync_device"
  row.dataset.testid = "tab-sync-device"
  if (device.stale) row.dataset.stale = "true"
  const text = document.createElement("span")
  text.className = "tab_sync_device_text"
  const label = document.createElement("span")
  label.className = "tab_sync_device_name"
  label.textContent = device.name
  const detail = document.createElement("span")
  detail.className = "tab_sync_device_meta"
  const tabCount = device.windows.reduce((count, window) => count + window.tabs.length, 0)
  detail.textContent = [
    platformName(device.platform),
    device.sharing ? `${tabCount} tab${tabCount === 1 ? "" : "s"}` : "not sharing tabs",
    device.stale ? `inactive, last seen ${humanTime(Date.parse(device.updatedAt))}` : `seen ${humanTime(Date.parse(device.updatedAt))}`
  ].join(" · ")
  text.append(label, detail)
  const button = document.createElement("button")
  button.type = "button"
  button.className = "button"
  button.textContent = "Remove…"
  button.setAttribute("aria-label", `Remove ${device.name} from tab sync`)
  button.addEventListener("click", () => void showConfirmDialog({
    message: `Remove ${device.name} from tab sync? It stays hidden on every device until it turns sharing on again.`,
    confirmLabel: "Remove"
  }).then((confirmed) => { if (confirmed) remove() }))
  row.append(text, button)
  return row
}

function emptyRow(): HTMLLIElement {
  const row = document.createElement("li")
  row.className = "tab_sync_devices_empty"
  row.textContent = "No other devices yet. Pair one, or connect it to the same sync database."
  return row
}
