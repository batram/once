import * as search from "../data/search"
import * as seperation_slider from "../view/sep_slider"

export function open_panel(panel: string): void {
  seperation_slider.expand_left()
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

export function add_tag(type: string, colors: [string, string]): void {
  if (!document.querySelector('#menu div[data-type="' + type + '"]')) {
    const tag = document.createElement("div")
    tag.dataset.type = type
    tag.classList.add("btn")
    tag.classList.add("menu_btn")
    tag.classList.add("tag")
    tag.classList.add("tag")
    tag.innerText = "[" + type + "]"
    tag.style.backgroundColor = colors[0]
    tag.style.color = colors[1]
    tag.dataset.panel = "stories"

    if (colors && colors[0] != "") {
      //inject css for story tags
      const style = document.createElement("style")
      style.classList.add("tag_style")
      style.type = "text/css"
      style.innerHTML = `
      .info[data-tag='${tag.innerText}'] .tag {
        background-color: ${colors[0]};
        border-color: ${colors[1]};
        color: ${colors[1]};
      }
      `
      document.head.append(style)
    }

    tag.onclick = () => {
      open_panel("stories")
      const search_scope = document.querySelector<HTMLInputElement>(
        "#search_scope"
      )
      search_scope.value = "local"

      const searchfield = document.querySelector<HTMLInputElement>(
        "#searchfield"
      )
      searchfield.value = "[" + type + "]"
      search.search_stories("[" + type + "]")
    }
    active_flash_panel(tag)
    document.querySelector("#menu").appendChild(tag)
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
    //Add special tags for search
    add_tag("ALL", ["", ""])
    add_tag("filtered", ["", ""])
    add_tag("stared", ["", ""])
    add_tag("new", ["", ""])
  }
}
