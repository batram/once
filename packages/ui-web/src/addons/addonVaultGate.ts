import type { OnceClient } from "@once/app"

type VaultClient = Pick<OnceClient, "getAddonVaultStatus" | "unlockAddonVault">

/**
 * Whether the stored add-ons can be read on a page without the panel. They may
 * sit in the encrypted vault, whose key normally lives with the device; when it
 * was not remembered only an unlock opens it, and without one every add-on
 * would look uninstalled rather than locked. A locked vault asks for its
 * passphrase in `root`; a conflicted or broken one says so and resolves false.
 */
export async function addonVaultReady(client: VaultClient, root: HTMLElement): Promise<boolean> {
  const status = await client.getAddonVaultStatus()
  if (status.state === "ready" || status.state === "disabled" || status.state === "unavailable") return true
  if (status.state !== "locked") {
    root.textContent = `${status.message} Open the Once panel to resolve it, then choose the action again.`
    return false
  }
  return new Promise(resolve => {
    const form = root.ownerDocument.createElement("form")
    form.className = "addon_conversation_unlock"
    const label = root.ownerDocument.createElement("label")
    label.textContent = "Your synced add-ons are locked. Enter the vault passphrase to run this action."
    const input = root.ownerDocument.createElement("input")
    input.type = "password"
    input.autocomplete = "current-password"
    input.required = true
    const button = root.ownerDocument.createElement("button")
    button.type = "submit"
    button.textContent = "Unlock"
    const error = root.ownerDocument.createElement("p")
    error.setAttribute("role", "alert")
    label.append(input)
    form.append(label, button, error)
    form.addEventListener("submit", event => {
      event.preventDefault()
      button.disabled = true
      // Not remembered: the key stays with this page, as an unlock would in a panel.
      client.unlockAddonVault(input.value, false, false, "").then(() => {
        root.replaceChildren()
        resolve(true)
      }, (reason: unknown) => {
        error.textContent = reason instanceof Error ? reason.message : "The vault could not be unlocked."
        button.disabled = false
      })
    })
    root.replaceChildren(form)
    input.focus()
  })
}
