import { AddonRedirectView, OnceClient } from "@once/app"
import { createListCard, createRowBody } from "./form"

const watched = new WeakSet<OnceClient>()

/**
 * The redirects installed add-ons contribute, under the user's own rules.
 * They are the add-on's to define, so a row only says what it does and where
 * it points now, and offers the one choice that is the user's: on or off.
 */
export function renderAddonRedirectCard(root: HTMLElement, client: OnceClient): void {
  root.append(addonRedirectCard(client))
  if (watched.has(client)) return
  watched.add(client)
  // A dynamic rule moves on its own; redraw just this card, never an open editor above it.
  client.subscribe("redirectsChanged", () => {
    for (const card of document.querySelectorAll<HTMLElement>("[data-testid='addon-redirects']")) {
      card.replaceWith(addonRedirectCard(client))
    }
  })
}

function addonRedirectCard(client: OnceClient): HTMLElement {
  const redirects = client.getAddonRedirects()
  const { card, rows } = createListCard("From add-ons", redirects.length)
  card.dataset.testid = "addon-redirects"
  card.hidden = redirects.length === 0
  for (const redirect of redirects) rows.append(addonRedirectRow(client, redirect))
  return card
}

function addonRedirectRow(client: OnceClient, redirect: AddonRedirectView): HTMLElement {
  const row = document.createElement("div")
  row.className = "structured_row structured_row_unbadged"
  row.dataset.addonRedirect = redirect.key
  row.dataset.searchValue = [redirect.title, redirect.addonName, redirect.match_url, redirect.replace_url]
    .filter(Boolean).join(" ").toLowerCase()
  const main = document.createElement("div")
  main.className = "structured_row_main"
  main.title = `${redirect.match_url} => ${redirect.replace_url ?? "…"}`
  const title = document.createElement("span")
  title.className = "structured_row_primary"
  title.textContent = redirect.title
  const detail = document.createElement("span")
  detail.className = "structured_row_secondary"
  detail.dataset.testid = "addon-redirect-target"
  detail.textContent = `${redirect.addonName} · ${target(redirect)}`
  main.append(title, detail)
  const toggle = document.createElement("input")
  toggle.type = "checkbox"
  toggle.className = "switch"
  toggle.checked = redirect.enabled
  toggle.dataset.testid = "addon-redirect-toggle"
  toggle.setAttribute("aria-label", `Use ${redirect.title}`)
  toggle.addEventListener("change", () => {
    const enabled = toggle.checked
    void client.setAddonRedirectEnabled(redirect.key, enabled).catch((error) => {
      toggle.checked = !enabled
      console.error(`Could not switch ${redirect.title}`, error)
    })
  })
  row.append(createRowBody(main, toggle))
  return row
}

function target(redirect: AddonRedirectView): string {
  if (!redirect.replace_url) return "choosing where to point…"
  try {
    return `=> ${new URL(redirect.replace_url.replace(/\$\d+/g, "")).host}`
  } catch {
    return `=> ${redirect.replace_url}`
  }
}
