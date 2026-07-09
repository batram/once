import * as search from "../data/search"

export function open_panel(panel: string): void {
  const left_panel = document.querySelector<HTMLElement>("#left_panel")
  left_panel.setAttribute("active_panel", panel)
}

function highlight_panel(panel: string) {
  const target_panel = document.querySelector<HTMLElement>(
    "#" + panel + "_panel"
  )
  target_panel.classList.add("pseudo_active")
}
function delight_panel(panel: string) {
  const target_panel = document.querySelector<HTMLElement>(
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
      const search_scope =
        document.querySelector<HTMLInputElement>("#search_scope")
      search_scope.value = "local"

      const searchfield =
        document.querySelector<HTMLInputElement>("#searchfield")
      searchfield.value = label
      search.search_stories(label)
    }
    active_flash_panel(type_el)
    document.querySelector("#menu #" + container_id).appendChild(type_el)
  }
}

function active_flash_panel(btn: HTMLElement) {
  btn.onmousedown = () => {
    highlight_panel(btn.dataset.panel)
  }
  btn.onmouseup = () => {
    delight_panel(btn.dataset.panel)
  }
  btn.onmouseout = () => {
    delight_panel(btn.dataset.panel)
  }
}

export function init(): void {
  document.querySelectorAll<HTMLElement>("#menu .sub").forEach((sub_menu) => {
    sub_menu.onclick = () => {
      open_panel(sub_menu.dataset.panel)
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
