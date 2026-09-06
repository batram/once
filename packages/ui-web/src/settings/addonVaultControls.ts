import { OnceClient } from "@once/app"
import { AddonVaultStatus } from "@once/core"

/** One vault unlock covers every installed add-on. Secret inputs never enter settings JSON. */
export function bindAddonVaultControls(client: OnceClient, parent: HTMLElement): void {
  if (!client.getAddonVaultStatus || parent.querySelector("#addon_vault_controls")) return
  const group = document.createElement("fieldset")
  group.id = "addon_vault_controls"
  group.className = "settings_group"
  const title = document.createElement("legend")
  title.textContent = "Sync add-ons and connections"
  const hint = document.createElement("p")
  hint.className = "settings_group_hint"
  hint.textContent = "Set up once, then unlock on each new device. Packages, settings and tokens are encrypted before syncing. Linked development folders stay local until you share a snapshot."
  const status = document.createElement("p")
  status.setAttribute("role", "status")
  status.dataset.testid = "addon-vault-status"
  const form = document.createElement("div")
  const feedback = document.createElement("p")
  feedback.setAttribute("role", "status")
  feedback.dataset.testid = "addon-vault-feedback"
  const recovery = document.createElement("div")
  recovery.hidden = true
  recovery.className = "settings_group"
  group.append(title, hint, status, form, feedback, recovery)
  parent.append(group)
  let signature = "", busy = false
  const run = async (work: () => Promise<void>) => {
    if (busy) return
    busy = true
    feedback.textContent = "Working…"
    for (const control of form.querySelectorAll<HTMLButtonElement>("button")) control.disabled = true
    try { await work(); feedback.textContent = "Saved" }
    catch (error) { feedback.textContent = error instanceof Error ? error.message : "Could not update synced connections" }
    finally { busy = false; signature = ""; await refresh() }
  }
  const recoveryNotice = (key: string, warning?: string) => {
    recovery.replaceChildren()
    recovery.hidden = false
    const label = document.createElement("p")
    label.textContent = "Save this recovery key in your password manager. It unlocks the vault if you forget the passphrase. Without either the key or an unlocked device, your tokens cannot be recovered."
    const output = document.createElement("textarea")
    output.readOnly = true
    output.value = key
    output.setAttribute("aria-label", "Vault recovery key")
    output.dataset.testid = "addon-vault-recovery-key"
    const saved = button("I saved my recovery key", () => { output.value = ""; recovery.replaceChildren(); recovery.hidden = true })
    recovery.append(label, output, saved)
    if (warning) { const text = document.createElement("p"); text.textContent = warning; recovery.append(text) }
  }
  const configure = (state: AddonVaultStatus) => {
    form.replaceChildren()
    if (["error", "unavailable"].includes(state.state)) return
    if (state.state === "ready") {
      const passphrase = field(form, "New sync passphrase", "password")
      passphrase.autocomplete = "new-password"
      form.append(button("Change passphrase", () => void run(async () => { await client.changeAddonVaultPassphrase(passphrase.value); passphrase.value = "" })),
        button("Lock and forget on this device", () => void run(async () => {
          recovery.replaceChildren(); recovery.hidden = true
          await client.lockAddonVault()
        })))
      return
    }
    const creating = state.state === "disabled"
    const secret = field(form, creating ? "Sync passphrase (at least 12 characters)" : "Sync passphrase or recovery key", "password")
    secret.dataset.testid = "addon-vault-secret"
    secret.autocomplete = creating ? "new-password" : "current-password"
    const confirmation = creating ? field(form, "Confirm sync passphrase", "password") : null
    if (confirmation) confirmation.autocomplete = "new-password"
    const useRecovery = creating ? null : check(form, "Use recovery key", false)
    const name = field(form, "Name this device", "text")
    name.placeholder = "For example, laptop or phone"
    name.maxLength = 80
    const remember = check(form, state.protectedStorage ? "Remember on this device using protected storage" : "Remember in this browser (weaker protection on a shared or compromised profile)", state.protectedStorage)
    form.append(button(creating ? "Enable encrypted addon sync" : "Unlock synced connections", () => void run(async () => {
      if (creating) {
        if (secret.value !== confirmation?.value) throw new Error("The passphrases do not match")
        const result = await client.createAddonVault(secret.value, remember.checked, name.value)
        recoveryNotice(result.recoveryKey, result.warning)
      } else await client.unlockAddonVault(secret.value, useRecovery?.checked === true, remember.checked, name.value)
      secret.value = ""
      if (confirmation) confirmation.value = ""
    })))
    if (state.state === "conflict") form.append(button("Review concurrent versions", () => void run(async () => {
      const choices = await client.getAddonVaultChoices()
      const expected = choices.map(item => item.revision)
      const review = document.createElement("div")
      const warning = document.createElement("p")
      warning.textContent = "Choose the complete version to keep. Other versions' settings and token changes will be discarded. No token values are displayed."
      review.append(warning)
      for (const choice of choices) {
        const text = document.createElement("p")
        text.textContent = `${choice.author} · ${choice.updatedAt} · ${choice.addons.join(", ") || "No addons"} · Tokens present: ${choice.connections.join(", ") || "none"}`
        review.append(text, button(`Keep version from ${choice.author}`, () => void run(async () => {
          await client.resolveAddonVault(choice.revision, expected)
          review.remove()
        })))
      }
      recovery.replaceChildren(review)
      recovery.hidden = false
    })))
  }
  const refresh = async () => {
    try {
      const state = await client.getAddonVaultStatus()
      status.textContent = state.message
      if (busy || signature === `${state.state}:${state.protectedStorage}`) return
      signature = `${state.state}:${state.protectedStorage}`
      configure(state)
    } catch { status.textContent = "Could not read encrypted sync status" }
  }
  client.subscribe("settingsChanged", ({ section }) => { if (section === "addons" || section === "sync") void refresh() })
  void refresh()
}

function button(text: string, run: () => void): HTMLButtonElement {
  const element = document.createElement("button")
  element.type = "button"
  element.className = "button"
  element.textContent = text
  element.addEventListener("click", run)
  return element
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
  label.className = "field"
  const input = document.createElement("input")
  input.type = "checkbox"
  input.checked = value
  label.append(input, document.createTextNode(text))
  parent.append(label)
  return input
}
