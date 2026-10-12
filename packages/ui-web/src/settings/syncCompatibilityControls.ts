import { OnceClient, SyncStatus } from "@once/app"

/** The persistent explanation lives outside Sync's subpages, beside the shared status. */
export function bindSyncCompatibilityControls(client: OnceClient): (status: SyncStatus) => void {
  const root = document.querySelector<HTMLElement>("#sync_settings")
  if (!root) return () => undefined
  const panel = document.createElement("section"); panel.className = "settings_rows sync_compatibility"; panel.hidden = true
  panel.dataset.testid = "sync-compatibility"; panel.setAttribute("aria-label", "Sync compatibility")
  const title = document.createElement("h3"); title.textContent = "Update Once to resume sync"
  const message = document.createElement("p"); message.setAttribute("role", "status")
  const versions = document.createElement("p"); versions.className = "settings_rows_hint"
  const retained = document.createElement("p"); retained.textContent = "Your local data and pending changes are kept. Sync resumes after a compatible update."
  const actions = document.createElement("div"); actions.className = "settings_actions cluster"
  const update = document.createElement("button"); update.type = "button"; update.className = "button"; update.textContent = "Update Once"
  update.onclick = () => {
    document.querySelector<HTMLButtonElement>('[data-settings-target="about"]')?.click()
    const check = document.querySelector<HTMLButtonElement>('[data-testid="check-for-updates"]')
    const release = document.querySelector<HTMLAnchorElement>('[data-testid="release-page"]')
    if (release && !release.hidden && release.href) release.click()
    else if (check && !check.hidden && !check.disabled) { check.focus(); check.click() }
    else window.open("https://github.com/batram/once/releases/latest", "_blank", "noopener,noreferrer")
  }
  const retry = document.createElement("button"); retry.type = "button"; retry.className = "button"; retry.textContent = "Check again"
  retry.onclick = () => client.recheckSyncCompatibility()
  actions.append(update, retry); panel.append(title, message, versions, retained, actions); root.prepend(panel)
  return status => {
    if (status.state === "connecting" && !panel.hidden) { message.textContent = "Checking sync compatibility…"; return }
    const incompatible = status.state === "update-required"
    const metadataError = status.state === "error" && status.message.startsWith("Sync compatibility")
    panel.hidden = !incompatible && !metadataError
    update.hidden = !incompatible
    title.textContent = incompatible ? "Update Once to resume sync" : "Sync compatibility needs attention"
    message.textContent = status.message
    const installed = document.querySelector('[data-testid="app-version"]')?.textContent?.trim()
    const details = status.compatibility
    versions.textContent = [installed ? `Installed: ${installed}` : "", details ? `Sync protocol: ${details.supportedSyncProtocol}; required: ${details.requiredSyncProtocol}` : "", details?.minAppVersion ? `Minimum release: ${details.minAppVersion}` : ""].filter(Boolean).join(" · ")
    retained.textContent = incompatible ? "Your local data and pending changes are kept. Sync resumes after a compatible update." : "Your local data and pending changes are kept. Restore the database compatibility metadata before syncing."
  }
}
