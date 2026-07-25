import * as Search from "./search"
import { OnceClient } from "@once/app"
import { requireElement } from "./dom"

let commsRegistered = false

function panelFor(button: HTMLElement): string {
  const panel = button.dataset.panel
  if (panel) return panel
  throw new Error("Menu button is missing data-panel")
}

export function open_panel(panel: string): void {
  const left_panel = requireElement<HTMLElement>("#left_panel")
  left_panel.setAttribute("active_panel", panel)
  document.dispatchEvent(new CustomEvent("once-panel-changed", {
    detail: { panel }
  }))
}

function highlight_panel(panel: string) {
  const target_panel = requireElement<HTMLElement>(
    "#" + panel + "_panel"
  )
  target_panel.classList.add("pseudo_active")
}
function delight_panel(panel: string) {
  const target_panel = requireElement<HTMLElement>(
    "#" + panel + "_panel"
  )
  target_panel.classList.remove("pseudo_active")
}

export function add_group(group_name: string): void {
  add_entry("*" + group_name, "group", "groups")
}

export function add_type(type: string): void {
  add_entry("[" + type + "]", "type", "types")
}

export function add_entry(
  label: string,
  class_name: string,
  container_id: string
): void {
  if (!document.querySelector('#menu div[data-type="' + label + '"]')) {
    const type_el = document.createElement("div")
    type_el.dataset.type = label
    type_el.classList.add("btn")
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
      Search.searchStories(label)
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
  document.querySelectorAll<HTMLElement>("#menu #types > .btn, #menu #groups > .btn")
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

function active_flash_panel(btn: HTMLElement) {
  btn.onmousedown = () => {
    highlight_panel(panelFor(btn))
  }
  btn.onmouseup = () => {
    delight_panel(panelFor(btn))
  }
  btn.onmouseout = () => {
    delight_panel(panelFor(btn))
  }
}

export function init(client?: OnceClient): void {
  if (!commsRegistered) {
    commsRegistered = true
    client?.subscribe("menuChanged", ({ groups, types }) => {
      groups.forEach(add_group)
      types.forEach(add_type)
    })
  }

  document.querySelectorAll<HTMLElement>("#menu .sub").forEach((sub_menu) => {
    sub_menu.onclick = () => {
      open_panel(panelFor(sub_menu))
    }
    sub_menu.querySelectorAll("img").forEach((x) => {
      x.setAttribute("draggable", "false")
    })
    active_flash_panel(sub_menu)
  })

  open_panel("stories")

  if (document.querySelector("#menu")) {
    //Add special types for search
    add_type("ALL")
    add_type("filtered")
    add_type("stared")
    add_type("new")
  }
}
