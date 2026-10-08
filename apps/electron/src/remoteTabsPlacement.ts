import { REMOTE_TABS_URL, type ElectronBridge, type ElectronTabState } from "@once/platform-electron/bridge"
import type { OnceClient, OncePlatformPorts } from "@once/app"
import { tabSyncTestTiming } from "@once/app/tabsync"
import { setTabsMenuVisible, watchTabSyncEnabled } from "@once/ui-web"

const PLACEMENT_KEY = "once:remote-tabs-placement"
const ENABLED_KEY = "once:remote-tabs-enabled"
type Placement = "button" | "panel" | "both"

/** The fixed button takes the selected state of the internal tabs page. */
export function updateRemoteTabsButton(tabs: ElectronTabState[]): void {
  const button = document.querySelector<HTMLButtonElement>("#tab_sync_btn")
  const active = tabs.some((tab) => tab.url === REMOTE_TABS_URL && tab.active)
  button?.classList.toggle("active", active)
  button?.setAttribute("aria-pressed", String(active))
}

function readPlacement(): Placement {
  try {
    const stored = localStorage.getItem(PLACEMENT_KEY)
    return stored === "panel" || stored === "both" ? stored : "button"
  } catch {
    return "button"
  }
}

/** Whether the side panel's Tabs entry shows at startup. */
export function remoteTabsInPanel(): boolean {
  return readPlacement() !== "button"
}

/** Restore the last known visibility before asynchronous app startup. */
export function initializeRemoteTabsButton(): void {
  const button = document.querySelector<HTMLButtonElement>("#tab_sync_btn")
  if (!button) return
  try { button.hidden = localStorage.getItem(ENABLED_KEY) !== "true" || readPlacement() === "panel" } catch { /* wait for the app */ }
}

/**
 * Where other devices' tabs are offered on the desktop: a button beside the
 * new tab button that opens them as a page, the side panel's Tabs entry, or
 * both. A per-device choice, kept with the other window layout preferences.
 */
export function bindRemoteTabsPlacement(bridge: ElectronBridge, client: OnceClient): void {
  const button = document.querySelector<HTMLButtonElement>("#tab_sync_btn")
  const row = document.querySelector<HTMLElement>("#remote_tabs_placement_row")
  const select = document.querySelector<HTMLSelectElement>("#remote_tabs_placement")
  if (!button || !row || !select) return
  // Nothing shows while tab sync is off on this device, whatever the placement.
  let enabled = !button.hidden
  const apply = (placement: Placement) => {
    select.value = placement
    button.hidden = !enabled || placement === "panel"
    setTabsMenuVisible(placement !== "button")
    window.dispatchEvent(new Event("resize"))
  }
  // Shown with the rest of the Tab sync page once tab sync is on.
  row.dataset.platformShown = "true"
  button.addEventListener("click", () => {
    void bridge.remoteTabs.open().catch((error) => console.error("Could not open the tabs page", error))
  })
  select.addEventListener("change", () => {
    const placement = select.value === "panel" || select.value === "both" ? select.value : "button"
    try { localStorage.setItem(PLACEMENT_KEY, placement) } catch { /* remembered for this window only */ }
    apply(placement)
  })
  apply(readPlacement())
  window.addEventListener("storage", (event) => {
    if (event.key === PLACEMENT_KEY || event.key === ENABLED_KEY) {
      try { enabled = localStorage.getItem(ENABLED_KEY) === "true" } catch { /* keep the current value */ }
      apply(readPlacement())
    }
  })
  watchTabSyncEnabled(client, (on) => {
    enabled = on
    try { localStorage.setItem(ENABLED_KEY, String(on)) } catch { /* visibility still updates in this window */ }
    apply(readPlacement())
  })
}

/**
 * In the background the desktop app still says a tab arrived; "Show" opens
 * the list where this window keeps it.
 */
export function desktopTabSyncNotices(bridge: ElectronBridge): { systemNotifications: boolean; showTabs: () => void } {
  return {
    systemNotifications: true,
    showTabs: () => {
      const entry = document.querySelector<HTMLElement>("#tabs_menu_btn:not([hidden])")
      if (entry) entry.click()
      else void bridge.remoteTabs.open()
    }
  }
}

/** End-to-end tests publish within seconds instead of the real intervals. */
export function applyTabSyncTestTiming(platform: Pick<OncePlatformPorts, "device">): void {
  const timing = tabSyncTestTiming(new URL(window.location.href).searchParams.get("tabSyncTiming"))
  if (platform.device && timing) platform.device.tabSyncTiming = timing
}
