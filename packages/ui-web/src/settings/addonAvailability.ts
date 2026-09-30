import { OnceClient } from "@once/app"

/** A paused vault is unreadable, not an empty installed collection. */
export async function requireAddonAvailability(client: OnceClient): Promise<void> {
  const status = await client.getAddonVaultStatus()
  if (["locked", "conflict", "error"].includes(status.state)) {
    throw new Error(status.state === "conflict"
      ? "Review the sync conflict in Once Add-ons before installing or updating. Your synced add-ons have not been removed."
      : status.state === "locked" ? "Unlock add-on sync in Once Add-ons before installing or updating."
        : status.message)
  }
}

export function addonCollectionSummary(): string {
  const root = document.querySelector<HTMLElement>("#addon_install_settings")
  const count = root?.querySelectorAll(".addon_list_row").length ?? 0
  const state = root?.dataset.vaultState
  const issue = state === "conflict" ? "Sync conflict" : state === "locked" ? "Sync locked" : state === "error" ? "Sync error" : ""
  return [count ? `${count} add-on${count === 1 ? "" : "s"}` : issue ? "" : "None", issue].filter(Boolean).join(" · ")
}

export function refreshAddonCollectionSummary(): void {
  const summary = document.querySelector('[data-settings-target="addons"] .settings_section_summary')
  if (summary) summary.textContent = addonCollectionSummary()
}
