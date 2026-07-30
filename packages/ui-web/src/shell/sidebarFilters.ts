import * as StorySearch from "../story/storySearch"
import { OnceClient } from "@once/app"
import { requireElement } from "../dom"
import { active_flash_panel, open_panel } from "./panelNavigation"

// The sidebar's type and group buttons are saved searches: clicking one opens
// the stories panel and runs its label as a local query. `#mobile_filter_chips`
// mirrors them for layouts where the sidebar itself is not shown.
let commsRegistered = false

export function add_type(type: string): void {
  add_entry("[" + type + "]", "type", "types")
}

function syncEntries(
  values: string[],
  className: "group" | "type",
  containerId: "groups" | "types",
  decorate: (value: string) => string
): void {
  const container = requireElement<HTMLElement>(`#menu #${containerId}`)
  const labels = values.map(decorate)
  const wanted = new Set(labels)
  container.querySelectorAll<HTMLButtonElement>(":scope > .button").forEach((entry) => {
    if (!wanted.has(entry.dataset.type || "")) entry.remove()
  })
  labels.forEach((label) => {
    add_entry(label, className, containerId)
    const entry = container.querySelector<HTMLElement>(
      `:scope > .button[data-type="${CSS.escape(label)}"]`
    )
    if (entry) container.append(entry)
  })
  syncMobileFilterChips()
}

export function add_entry(
  label: string,
  class_name: string,
  container_id: string
): void {
  if (!document.querySelector('#menu button[data-type="' + label + '"]')) {
    const type_el = document.createElement("button")
    type_el.type = "button"
    type_el.dataset.type = label
    type_el.classList.add("button")
    type_el.classList.add("menu_btn")
    type_el.classList.add(class_name)
    type_el.innerText = label
    type_el.dataset.panel = "stories"

    type_el.onclick = () => {
      open_panel("stories")
      const search_scope = requireElement<HTMLInputElement>("#search_scope")
      search_scope.value = "local"

      const searchfield = requireElement<HTMLInputElement>("#searchfield")
      searchfield.value = label
      StorySearch.searchStories(label)
    }
    active_flash_panel(type_el)
    requireElement("#menu #" + container_id).appendChild(type_el)
    syncMobileFilterChips()
  }
}

function syncMobileFilterChips(): void {
  const host = document.querySelector<HTMLElement>("#mobile_filter_chips")
  if (!host) return
  host.replaceChildren()
  document.querySelectorAll<HTMLButtonElement>(
    "#menu #types > .button, #menu #groups > .button"
  )
    .forEach((entry) => {
      const chip = document.createElement("button")
      chip.type = "button"
      chip.className = entry.className
      chip.classList.add("mobile_filter_chip")
      chip.textContent = entry.textContent
      chip.dataset.type = entry.dataset.type
      chip.onclick = () => entry.click()
      host.append(chip)
    })
}

export function init(client?: OnceClient): void {
  if (!commsRegistered) {
    commsRegistered = true
    client?.subscribe("menuChanged", ({ groups, types }) => {
      syncEntries(groups, "group", "groups", (group) => `*${group}`)
      syncEntries(types, "type", "types", (type) => `[${type}]`)
    })
  }

  if (document.querySelector("#menu")) {
    //Add special types for search
    add_type("ALL")
    add_type("filtered")
    add_type("stared")
    add_type("new")
  }
}
