import { OnceClient } from "@once/app"
import { AddonVaultStatus } from "@once/core"
import { refreshAddonCollectionSummary } from "./addonAvailability"
import { renderAddonVaultReview } from "./addonVaultReview"
import { showConfirmDialog } from "../confirmDialog"

/** The vault's state in a few words, for the links that lead to its page. */
export const VAULT_SUMMARIES: Record<string, string> = {
  disabled: "Not set up", locked: "Locked on this device", ready: "On", off: "Off on this device",
  conflict: "Needs attention", error: "Needs attention"
}

/** One vault unlock covers every installed add-on. Secret inputs never enter settings JSON. */
export function bindAddonVaultControls(client: OnceClient, parent: HTMLElement): void {
  if (!client.getAddonVaultStatus || parent.querySelector("#addon_vault_controls")) return
  const group = document.createElement("fieldset")
  group.id = "addon_vault_controls"
  group.className = "settings_group addon_vault"
  const title = document.createElement("legend")
  title.textContent = "Add-on sync"
  // The state and what it means, as one card at the top of the page.
  const summary = document.createElement("div")
  summary.className = "addon_vault_summary"
  const status = document.createElement("p")
  status.className = "addon_vault_status"
  status.setAttribute("role", "status")
  status.dataset.testid = "addon-vault-status"
  const hint = document.createElement("p")
  hint.className = "addon_vault_hint"
  summary.append(status, hint)
  const form = document.createElement("div")
  form.className = "addon_vault_form"
  const feedback = document.createElement("p")
  feedback.className = "addon_vault_feedback"
  feedback.setAttribute("role", "status")
  feedback.dataset.testid = "addon-vault-feedback"
  const recovery = document.createElement("div")
  recovery.hidden = true
  recovery.className = "addon_vault_recovery"
  // Its own page now (Settings › Sync › Add-on sync): the choices show at once.
  const review = document.createElement("div")
  review.className = "addon_vault_review"
  group.append(title, summary, recovery, form, review, feedback)
  parent.prepend(group)
  let signature = "", busy = false, revision = 0
  const run = async (work: () => Promise<void>) => {
    if (busy) return
    busy = true
    feedback.textContent = "Working…"
    for (const control of [...form.querySelectorAll<HTMLButtonElement>("button"), ...review.querySelectorAll<HTMLButtonElement>("button")]) control.disabled = true
    try { await work(); feedback.textContent = "" }
    catch (error) { feedback.textContent = error instanceof Error ? error.message : "Could not update synced connections" }
    finally { busy = false; signature = ""; await refresh() }
  }
  const showReview = () => void run(() => renderAddonVaultReview(client, review, run))
  const recoveryNotice = (key: string, warning?: string) => showRecoveryKey(recovery, key, warning)
  const configure = (state: AddonVaultStatus) => {
    form.replaceChildren()
    summary.dataset.state = state.state
    if (state.state !== "conflict") review.replaceChildren()
    for (const control of review.querySelectorAll<HTMLButtonElement>("button")) control.disabled = false
    form.hidden = ["error", "unavailable"].includes(state.state)
    hint.textContent = state.state === "conflict"
      ? "Your synced add-ons are paused, not removed. Choose a version to restore them on all devices. Linked folders remain available on this device."
      : state.state === "ready" ? "Packages, settings and saved connections sync together, encrypted. Linked folders stay on this device."
        : state.state === "off" ? "This device keeps its add-ons and their tokens, and no longer syncs them. Other devices still sync. " +
          "Turning it back on replaces this device's add-ons with the synced ones."
          : state.state === "locked" ? "Enter the sync passphrase to use your synced add-ons on this device."
            : ["error", "unavailable"].includes(state.state) ? ""
              : "Sync packages, settings and saved connections between devices, encrypted. Set up once, then unlock on each new device."
    if (form.hidden) return
    if (state.state === "conflict" && state.unlockRequired === false) {
      // Once the versions are listed, they are the next step; the button would only repeat it.
      if (!review.childElementCount) form.append(actions(primary(button("Review concurrent versions", showReview))))
      return
    }
    if (state.state === "ready") {
      readyActions(form, client, run, () => { recovery.replaceChildren(); recovery.hidden = true })
      return
    }
    const creating = state.state === "disabled"
    const rejoining = state.state === "off"
    const secret = field(form, creating ? "Sync passphrase (at least 12 characters)" : "Sync passphrase or recovery key", "password")
    secret.dataset.testid = "addon-vault-secret"
    secret.autocomplete = creating ? "new-password" : "current-password"
    const confirmation = creating ? field(form, "Confirm sync passphrase", "password") : null
    if (confirmation) confirmation.autocomplete = "new-password"
    const useRecovery = creating ? null : check(form, "Use recovery key", false)
    const remember = check(form, state.protectedStorage ? "Remember on this device using protected storage" : "Remember in this browser (weaker protection on a shared or compromised profile)", state.protectedStorage)
    const submit = button(creating ? "Enable encrypted addon sync" : rejoining ? "Turn on on this device" : "Unlock add-on sync", () => void run(async () => {
      // Snapshots name their author with the device name set above in the Sync section.
      const name = { value: (await client.getTabSync().catch(() => null))?.self?.name ?? "" }
      if (creating) {
        if (secret.value !== confirmation?.value) throw new Error("The passphrases do not match")
        const result = await client.createAddonVault(secret.value, remember.checked, name.value)
        recoveryNotice(result.recoveryKey, result.warning)
      } else await client.unlockAddonVault(secret.value, useRecovery?.checked === true, remember.checked, name.value)
      secret.value = ""
      if (confirmation) confirmation.value = ""
    }))
    submit.dataset.testid = "addon-vault-submit"
    form.append(actions(primary(submit)))
  }
  const refresh = async () => {
    const current = ++revision
    try {
      const state = await client.getAddonVaultStatus()
      if (current !== revision) return
      status.textContent = state.message
      const root = parent.closest<HTMLElement>("#addon_install_settings") ?? document.querySelector<HTMLElement>("#addon_install_settings")
      if (root) {
        root.dataset.vaultState = state.state
        const paused = ["locked", "conflict", "error"].includes(state.state)
        for (const control of root.querySelectorAll<HTMLButtonElement>('[data-testid="open-addon-import"], [data-testid="update-addons"], [data-testid="open-addon-advanced"]')) control.disabled = paused
      }
      // The Add-ons page's link here says what it will find.
      for (const link of document.querySelectorAll<HTMLElement>("[data-addon-sync-link]")) {
        link.hidden = state.state === "unavailable"
        link.dataset.vaultState = state.state
        const summary = link.querySelector<HTMLElement>("[data-addon-sync-summary]")
        if (summary) summary.textContent = VAULT_SUMMARIES[state.state] ?? ""
      }
      refreshAddonCollectionSummary()
      const next = `${state.state}:${state.protectedStorage}:${state.unlockRequired}`
      if (busy || signature === next) return
      signature = next
      configure(state)
    } catch { status.textContent = "Could not read encrypted sync status" }
  }
  client.subscribe("settingsChanged", ({ section }) => { if (section === "addons" || section === "sync") void refresh() })
  void refresh()
}

/**
 * On: change the passphrase, lock and forget the key on this device, or turn
 * sync off here (other devices keep syncing). Each under its own heading, so
 * the passphrase field reads as belonging to its button only.
 */
function readyActions(form: HTMLElement, client: OnceClient, run: (work: () => Promise<void>) => Promise<void>, hideRecovery: () => void): void {
  form.append(heading("Passphrase"))
  const passphrase = field(form, "New sync passphrase", "password")
  passphrase.autocomplete = "new-password"
  const change = button("Change passphrase", () => void run(async () => { await client.changeAddonVaultPassphrase(passphrase.value); passphrase.value = "" }))
  change.disabled = true
  passphrase.addEventListener("input", () => { change.disabled = passphrase.value === "" })
  form.append(actions(change), heading("This device"))
  const lock = button("Lock and forget", () => void run(async () => {
    hideRecovery()
    await client.lockAddonVault()
  }))
  row(form, "Lock on this device", "Forgets the key here. Unlock again with the passphrase or recovery key.", lock)
  const off = button("Turn off…", () => void showConfirmDialog({
    message: "Turn add-on sync off on this device? Its add-ons and tokens stay here but stop syncing. Other devices keep syncing.",
    confirmLabel: "Turn off"
  }).then((confirmed) => { if (confirmed) void run(() => client.leaveAddonVault()) }))
  off.dataset.testid = "addon-vault-leave"
  row(form, "Turn off on this device", "Keeps this device's add-ons and tokens, but stops syncing them. Other devices keep syncing.", off)
}

/** The recovery key, shown once after setup until the reader confirms saving it. */
function showRecoveryKey(recovery: HTMLElement, key: string, warning?: string): void {
  recovery.replaceChildren()
  recovery.hidden = false
  const label = document.createElement("p")
  label.textContent = "Save this recovery key in your password manager. It unlocks the vault if you forget the passphrase. Without either the key or an unlocked device, your tokens cannot be recovered."
  const output = document.createElement("textarea")
  output.readOnly = true
  output.rows = 2
  output.value = key
  output.setAttribute("aria-label", "Vault recovery key")
  output.dataset.testid = "addon-vault-recovery-key"
  const saved = button("I saved my recovery key", () => { output.value = ""; recovery.replaceChildren(); recovery.hidden = true })
  recovery.append(label, output)
  if (warning) { const text = document.createElement("p"); text.className = "addon_vault_warning"; text.textContent = warning; recovery.append(text) }
  recovery.append(actions(primary(saved)))
}

function button(text: string, run: () => void): HTMLButtonElement {
  const element = document.createElement("button")
  element.type = "button"
  element.className = "button"
  element.textContent = text
  element.addEventListener("click", run)
  return element
}
function primary(element: HTMLButtonElement): HTMLButtonElement {
  element.classList.add("addon_vault_primary")
  return element
}
function actions(...buttons: HTMLButtonElement[]): HTMLElement {
  const element = document.createElement("div")
  element.className = "addon_vault_actions"
  element.append(...buttons)
  return element
}
function heading(text: string): HTMLElement {
  const element = document.createElement("h4")
  element.className = "settings_subheading"
  element.textContent = text
  return element
}
/** A settings row whose control is a one-shot action. */
function row(parent: HTMLElement, name: string, hint: string, control: HTMLButtonElement): void {
  const element = document.createElement("div")
  element.className = "settings_row"
  const label = document.createElement("span")
  label.className = "settings_row_name"
  label.textContent = name
  const text = document.createElement("p")
  text.className = "settings_row_hint"
  text.textContent = hint
  element.append(label, text, control)
  parent.append(element)
}
function field(parent: HTMLElement, text: string, type: string): HTMLInputElement {
  const label = document.createElement("label")
  label.className = "field"
  const caption = document.createElement("span")
  caption.className = "field_label"
  caption.textContent = text
  const input = document.createElement("input")
  input.type = type
  label.append(caption, input)
  parent.append(label)
  return input
}
function check(parent: HTMLElement, text: string, value: boolean): HTMLInputElement {
  const label = document.createElement("label")
  label.className = "field field_check"
  const input = document.createElement("input")
  input.type = "checkbox"
  input.checked = value
  const caption = document.createElement("span")
  caption.className = "field_label"
  caption.textContent = text
  label.append(input, caption)
  parent.append(label)
  return input
}
