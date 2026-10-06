import type { ElectronBridge } from "@once/platform-electron/bridge"
import { setTabsMenuVisible } from "@once/ui-web"

const PLACEMENT_KEY = "once:remote-tabs-placement"
type Placement = "button" | "panel" | "both"

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

/**
 * Where other devices' tabs are offered on the desktop: a button beside the
 * new tab button that opens them as a page, the side panel's Tabs entry, or
 * both. A per-device choice, kept with the other window layout preferences.
 */
export function bindRemoteTabsPlacement(bridge: ElectronBridge): void {
  const button = document.querySelector<HTMLButtonElement>("#tab_sync_btn")
  const row = document.querySelector<HTMLElement>("#remote_tabs_placement_row")
  const select = document.querySelector<HTMLSelectElement>("#remote_tabs_placement")
  if (!button || !row || !select) return
  const apply = (placement: Placement) => {
    select.value = placement
    button.hidden = placement === "panel"
    setTabsMenuVisible(placement !== "button")
    window.dispatchEvent(new Event("resize"))
  }
  row.hidden = false
  button.addEventListener("click", () => {
    void bridge.remoteTabs.open().catch((error) => console.error("Could not open the tabs page", error))
  })
  select.addEventListener("change", () => {
    const placement = select.value === "panel" || select.value === "both" ? select.value : "button"
    try { localStorage.setItem(PLACEMENT_KEY, placement) } catch { /* remembered for this window only */ }
    apply(placement)
  })
  apply(readPlacement())
}
