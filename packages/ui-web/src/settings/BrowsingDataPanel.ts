import { showConfirmDialog } from "../confirmDialog"

/**
 * A shell whose browser keeps website data Once can clear: Electron's browsing
 * partition, the phone's native surface. One site is cleared from the page
 * menu, where the page is; Settings only clears everything.
 */
export interface BrowsingDataHost {
  clearAll(): Promise<void>
}

/** Shows the section; it must run before SettingsPanel builds its navigation. */
export function revealBrowsingDataSettings(host: BrowsingDataHost | undefined): void {
  const block = document.getElementById("browsing_data_settings")
  if (host && block) block.hidden = false
}

export function bindBrowsingDataSettings(host: BrowsingDataHost | undefined): void {
  const button = document.getElementById("clear_browsing_data")
  const status = document.getElementById("browsing_data_status")
  if (!host || !(button instanceof HTMLButtonElement) || !status) return
  const report = (text: string) => {
    status.textContent = text
    status.hidden = false
  }
  button.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog({
      message: "Clear all browsing data? Cookies, cache and site storage are removed and you are signed out of every site.",
      confirmLabel: "Clear",
      // The button is too narrow to center a readable dialog in.
      positionWithin: document.getElementById("settings_panel") ?? undefined
    })
    if (!confirmed) return
    button.disabled = true
    status.hidden = true
    try {
      await host.clearAll()
      report("Browsing data cleared. Open pages may need a reload.")
    } catch (error) {
      report(`Could not clear browsing data: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      button.disabled = false
    }
  })
}
