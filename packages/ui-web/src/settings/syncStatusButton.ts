import { openSyncSettings } from "../tabsync/tabsPanel"

/**
 * The sync state in the Settings titlebar while Settings › Sync is open (CSS
 * shows it only there): the full message as its tooltip, and a way back to
 * the Sync overview from its pages. Whatever writes the status writes
 * `#couch_status`; this follows it.
 */
export function bindSyncStatusButton(): void {
  const button = document.querySelector<HTMLButtonElement>("#sync_status_button")
  const status = document.querySelector<HTMLElement>("#couch_status")
  if (!button || !status) return
  const follow = () => {
    const message = status.textContent?.trim() ?? ""
    button.title = message
    button.setAttribute("aria-label", `Sync: ${message}. Show the Sync overview`)
  }
  new MutationObserver(follow).observe(status, { childList: true, characterData: true, subtree: true })
  button.addEventListener("click", () => openSyncSettings())
  follow()
}
