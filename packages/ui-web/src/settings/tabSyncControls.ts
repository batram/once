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

const CHOICES: Record<string, readonly number[]> = {
  activityWindowMinutes: ACTIVITY_WINDOW_CHOICES,
  freshnessWindowMinutes: FRESHNESS_WINDOW_CHOICES,
  staleDeviceDays: STALE_DEVICE_CHOICES,
  sendRetentionDays: SEND_RETENTION_CHOICES
}

const PLATFORM_NAMES: Record<string, string> = {
  electron: "Desktop app", ios: "iOS", android: "Android", firefox: "Firefox", chrome: "Chrome"
}

/**
 * The Sync section beyond the database URL: data consent where the browser
 * asks for it, this device's name, tab sync options and the other devices.
 */
export function bindTabSyncControls(client: OnceClient): void {
  const consent = requireElement<HTMLElement>("#sync_consent")
  const device = requireElement<HTMLElement>("#sync_device_settings")
  const tabs = requireElement<HTMLElement>("#tab_sync_settings")
  const name = requireElement<HTMLInputElement>("#device_name_input")
  const notice = requireElement<HTMLElement>("#tab_sync_notice")
  const list = requireElement<HTMLUListElement>("#tab_sync_devices")
  const excluded = requireElement<HTMLTextAreaElement>("#tab_sync_excluded")
  let revision = 0

  fillChoices(tabs)
  requireElement<HTMLButtonElement>("#sync_consent_button").addEventListener("click", () => {
    // Straight from the click: Firefox shows its prompt only during a user gesture.
    void client.requestSyncConsent().then(() => refresh())
  })
  name.addEventListener("change", () => void act(() => client.renameDevice(name.value)))
  requireElement<HTMLButtonElement>("#reset_device_button").addEventListener("click", () => {
    if (!confirm("Give this device a new identity? Its current entry is removed from tab sync on every device.")) return
    void act(() => client.resetDeviceIdentity())
  })
  requireElement<HTMLButtonElement>("#tab_sync_defaults").addEventListener("click", () => void act(async () => {
    const { activityWindowMinutes, freshnessWindowMinutes, staleDeviceDays } = DEFAULT_TAB_SYNC_OPTIONS
    await client.setTabSyncOptions({ activityWindowMinutes, freshnessWindowMinutes, staleDeviceDays })
    await client.setTabSyncShared({ ...DEFAULT_TAB_SYNC_SHARED_SETTINGS })
  }))
  for (const control of tabs.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-option], [data-shared]")) {
    control.addEventListener("change", () => void act(() => save(control)))
  }

  const save = (control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
    if (control.dataset.shared) return client.setTabSyncShared({ [control.dataset.shared]: Number(control.value) })
    const option = control.dataset.option as keyof TabSyncOptions
    const value = control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked
      : control instanceof HTMLSelectElement ? Number(control.value)
        : normalizeExcludedDomains(control.value)
    return client.setTabSyncOptions({ [option]: value })
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
    const [consentState, view] = await Promise.all([
      client.getSyncConsent().catch(() => "not-needed" as const),
      client.getTabSync().catch(() => null)
    ])
    if (current !== revision) return
    consent.hidden = consentState !== "required"
    device.hidden = tabs.hidden = !view
    if (!view) return
    render(view)
  }

  const render = (view: TabSyncView) => {
    if (document.activeElement !== name) name.value = view.self?.name ?? ""
    if (document.activeElement !== excluded) excluded.value = view.options.excludedDomains.join("\n")
    for (const row of tabs.querySelectorAll<HTMLElement>("[data-tab-sync-share]")) row.hidden = !view.canShare
    for (const control of tabs.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[data-option], select[data-option]")) {
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
  const label = document.createElement("span")
  label.className = "tab_sync_device_name"
  label.textContent = device.name
  const detail = document.createElement("span")
  detail.className = "settings_row_hint"
  const tabCount = device.windows.reduce((count, window) => count + window.tabs.length, 0)
  detail.textContent = [
    PLATFORM_NAMES[device.platform] ?? device.platform,
    device.sharing ? `${tabCount} tab${tabCount === 1 ? "" : "s"}` : "not sharing tabs",
    `seen ${humanTime(Date.parse(device.updatedAt))}`,
    ...(device.stale ? ["inactive"] : [])
  ].join(" · ")
  const button = document.createElement("button")
  button.type = "button"
  button.className = "button"
  button.textContent = "Remove from tab sync"
  button.title = "Hidden until that device turns sharing on again"
  button.addEventListener("click", () => {
    if (confirm(`Remove ${device.name} from tab sync? It stays hidden until that device turns sharing on again.`)) remove()
  })
  row.append(label, detail, button)
  return row
}

function emptyRow(): HTMLLIElement {
  const row = document.createElement("li")
  row.className = "settings_row_hint"
  row.textContent = "No other devices yet. Connect them to the same sync database."
  return row
}
