import { ElectronBridge, ElectronTabState } from "@once/platform-electron/bridge"

/** The notice belongs to browser chrome, outside the site's control. */
export function bindBlockedPopups(bridge: ElectronBridge): void {
  const button = document.querySelector<HTMLButtonElement>("#blocked_popups")
  if (!button) throw new Error("Missing blocked popup button")
  let tabId: string | undefined
  const render = (tabs: ElectronTabState[]) => {
    const tab = tabs.find(candidate => candidate.active)
    tabId = tab?.id
    const count = tab?.blockedPopupCount ?? 0
    button.hidden = count === 0
    button.textContent = count === 1 ? "Popup blocked" : `${count} popups blocked`
    button.title = "Show blocked popups to open or dismiss them"
  }
  button.onclick = () => {
    if (!tabId) return
    const bounds = button.getBoundingClientRect()
    void bridge.tabs.showBlockedPopups(tabId, { x: bounds.left, y: bounds.bottom })
  }
  bridge.tabs.onChanged(render)
  void bridge.tabs.getAll().then(render)
}
