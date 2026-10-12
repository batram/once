import { OnceClient } from "@once/app"
import { button, field, input, feedback } from "./aiForm"

export async function legacyAiImportControls(client: OnceClient, parent: HTMLElement, run: (work: () => Promise<void>) => Promise<void>): Promise<void> {
  const message = await client.getLegacyAiImportStatus?.()
  if (!message || !parent.isConnected) return
  const section = document.createElement("section"); section.className = "settings_rows"
  feedback(section).textContent = message
  const secret = input("password"); secret.autocomplete = "current-password"
  const recovery = input("checkbox")
  field(section, "Earlier AI vault passphrase or recovery key", secret)
  field(section, "Use recovery key", recovery)
  section.append(button("Import earlier AI settings", () => void run(async () => {
    if (!await client.importLegacyAiVault(secret.value || undefined, recovery.checked)) throw new Error("Unlock shared sync before importing the earlier AI vault")
    secret.value = ""
  })))
  parent.append(section)
}
