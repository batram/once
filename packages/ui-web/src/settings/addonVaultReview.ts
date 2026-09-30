import { OnceClient } from "@once/app"
import { addonButton } from "./addonManagement"

export async function renderAddonVaultReview(client: OnceClient, review: HTMLElement, run: (work: () => Promise<void>) => Promise<void>): Promise<void> {
  const choices = await client.getAddonVaultChoices()
  const expected = choices.map(item => item.revision)
  const warning = document.createElement("p")
  warning.textContent = "Choose the complete version to keep on all devices. Other versions' settings and token changes will be discarded."
  review.replaceChildren(warning)
  for (const choice of choices) {
    const text = document.createElement("p")
    text.textContent = `${choice.author} · ${new Date(choice.updatedAt).toLocaleString()} · ${choice.addons.join(", ") || "No add-ons"} · Saved connections: ${choice.connections.join(", ") || "none"}`
    review.append(text, addonButton(`Keep version from ${choice.author}`, () => run(async () => {
      await client.resolveAddonVault(choice.revision, expected)
      review.replaceChildren()
    })))
  }
}
