import { OnceClient } from "@once/app"
import { addonButton } from "./addonManagement"

/** One card per concurrent version: who saved it and when, what it holds, and the button that keeps it. */
export async function renderAddonVaultReview(client: OnceClient, review: HTMLElement, run: (work: () => Promise<void>) => Promise<void>): Promise<void> {
  const choices = await client.getAddonVaultChoices()
  const expected = choices.map(item => item.revision)
  const newest = Math.max(...choices.map(item => Date.parse(item.updatedAt) || 0))
  const warning = document.createElement("p")
  warning.className = "addon_vault_review_intro"
  warning.textContent = "Choose the complete version to keep on all devices. Other versions' settings and token changes will be discarded."
  const list = document.createElement("ul")
  list.className = "addon_vault_choices"
  review.replaceChildren(warning)
  const differences = choices[0]?.differences ?? []
  if (differences.length) {
    const details = document.createElement("dl")
    details.className = "addon_vault_choice_details addon_vault_differences"
    detail(details, "They differ in", differences)
    review.append(details)
  }
  review.append(list)
  for (const choice of choices) {
    const card = document.createElement("li")
    card.className = "addon_vault_choice"
    const head = document.createElement("div")
    head.className = "addon_vault_choice_head"
    const author = document.createElement("strong")
    author.textContent = choice.author
    const time = document.createElement("time")
    time.dateTime = choice.updatedAt
    time.textContent = new Date(choice.updatedAt).toLocaleString()
    head.append(author, time)
    if (choices.length > 1 && Date.parse(choice.updatedAt) === newest) {
      const badge = document.createElement("span")
      badge.className = "addon_vault_choice_badge"
      badge.textContent = "Newest"
      head.append(badge)
    }
    const details = document.createElement("dl")
    details.className = "addon_vault_choice_details"
    detail(details, "Add-ons", choice.addons.length ? choice.addons : ["None"])
    // A connection is "addon:name"; the name is what the reader recognises, the full key stays in the tooltip.
    detail(details, "Saved connections", choice.connections.length ? choice.connections : ["None"], item => item.slice(item.indexOf(":") + 1))
    const keep = addonButton(`Keep version from ${choice.author}`, () => run(async () => {
      await client.resolveAddonVault(choice.revision, expected)
      review.replaceChildren()
    }))
    card.append(head, details, keep)
    list.append(card)
  }
}

function detail(list: HTMLElement, name: string, items: string[], show: (item: string) => string = item => item): void {
  const term = document.createElement("dt")
  term.textContent = name
  const value = document.createElement("dd")
  for (const item of items) {
    const chip = document.createElement("span")
    chip.className = "addon_vault_chip"
    chip.textContent = show(item)
    if (chip.textContent !== item) chip.title = item
    value.append(chip)
  }
  list.append(term, value)
}
