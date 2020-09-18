import { ipcRenderer } from "electron"
import * as filters from "./data/filters"
import * as webtab from "./view/webtab"
import * as story_map from "./data/StoryMap"
import * as story_list from "./view/StoryList"

export {
  open_in_tab,
  open_in_new_tab,
  webtab_comms,
  new_webtab,
  grab_attached_or_new,
  attach_webtab,
  send_or_create_tab,
}

function grab_attached_or_new() {
  let wc_id = ipcRenderer.sendSync("get_attached_wc_id")

  console.log("attacjed?", wc_id, wc_id != null)

  if (wc_id != null) {
    grab_webtab(document.querySelector("#tab_content"), wc_id)
    return true
  } else {
    new_webtab(document.querySelector("#tab_content"))
    return false
  }
}

function new_tab_element(
  size_to_el: HTMLElement,
  wc_id: number
): HTMLElement | null {
  let tab_el = document.createElement("div")
  tab_el.setAttribute("draggable", "true")
  tab_el.classList.add("tab")
  tab_el.innerText = "New tab"
  tab_el.dataset.size_to = size_to_el.id
  tab_el.dataset.wc_id = wc_id.toString()

  let dropzone = document.querySelector("#tab_dropzone")
  if (dropzone) {
    dropzone.append(tab_el)
  } else {
    console.error("failed to find dropzone for tabs")
    return null
  }

  tab_el.ondrag = (drag) => {
    //drag.preventDefault()
    //console.log("ondrag", drag)
  }
  tab_el.ondragstart = (drag) => {
    drag.dataTransfer.setData(
      "tab_drop",
      JSON.stringify({
        wc_id: tab_el.dataset.wc_id,
      })
    )
    if (tab_el.dataset.href) {
      drag.dataTransfer.setData("text", tab_el.dataset.href)
    }
  }
  tab_el.ondragend = (drag) => {
    drag.preventDefault()
    console.log("ondragend", drag.dataTransfer.dropEffect, drag)

    if (drag.dataTransfer.dropEffect == "none") {
      let offset = JSON.stringify([drag.offsetX, drag.offsetY])
      send_to_id(parseInt(tab_el.dataset.wc_id), "pop_out", offset)
    }
  }

  tab_el.addEventListener("mousedown", (e) => {
    if (e.button == 0) {
      activate_tab(tab_el)
    } else if (e.button == 1) {
      close_tab(tab_el)
    }
  })

  return tab_el
}

function grab_webtab(size_to_el: HTMLElement, wc_id: number) {
  let ret_wc_id = attach_webtab(size_to_el, wc_id)
  if (wc_id != 0 && ret_wc_id != wc_id) {
    throw `Wanted to grab ${wc_id} but got ${ret_wc_id}`
  }

  if (ret_wc_id && ret_wc_id == 0) {
    console.error(
      "failed to attach tab",
      `wc_id ${wc_id}, ret_wc_id ${ret_wc_id}`
    )
    return
  }

  let new_el = new_tab_element(size_to_el, ret_wc_id)
  mark_tab_active(new_el)

  return ret_wc_id
}

function new_webtab(size_to_el: HTMLElement): number {
  return grab_webtab(size_to_el, 0)
}

function activate_tab(tab_el: HTMLElement) {
  let size_to_el = document.getElementById(tab_el.dataset.size_to)
  attach_webtab(size_to_el, parseInt(tab_el.dataset.wc_id))
  mark_tab_active(tab_el)
}

function close_tab(tab_el: HTMLElement) {
  send_to_id(parseInt(tab_el.dataset.wc_id), "closed")
  remove_tab_el(parseInt(tab_el.dataset.wc_id))
}

function get_active_wc_id(size_to_el: HTMLElement): number {
  return parseInt(size_to_el.dataset.active_wc_id)
}

function remove_tab_el(wc_id: number) {
  let tab_el = tab_el_from_id(wc_id)
  if (tab_el) {
    let size_to_el = document.getElementById(tab_el.dataset.size_to)
    if (get_active_wc_id(size_to_el) == wc_id) {
      size_to_el.dataset.active_wc_id = ""
      let prev = tab_el.previousElementSibling as HTMLElement
      if (prev && prev.classList.contains("tab")) {
        activate_tab(prev)
      } else {
        let next = tab_el.nextElementSibling as HTMLElement
        if (next && next.classList.contains("tab")) {
          next
          activate_tab(next)
        }
      }
    }

    tab_el.outerHTML = ""
  }

  maybe_close_window()
}

//close the window if we have no more tabs and are not the last window open
function maybe_close_window() {
  if (document.querySelectorAll("tab").length == 0) {
    ipcRenderer.send("no_more_tabs_can_i_go")
  }
}

function tab_el_from_id(id: number) {
  return document.querySelector<HTMLElement>(`.tab[data-wc_id="${id}"]`)
}

function mark_tab_active(tab_el: HTMLElement) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.remove("active")
  })
  tab_el.classList.add("active")
}

function attach_webtab(size_to_el: HTMLElement, wc_id: number) {
  let re_wc_id = null
  if (wc_id != null && wc_id != 0) {
    re_wc_id = ipcRenderer.sendSync("attach_wc_id", wc_id)
  } else {
    re_wc_id = ipcRenderer.sendSync("attach_new_tab")
  }

  if (!re_wc_id) {
    console.error("failed to create or retrieve view to attach")
    return
  }

  if (size_to_el) {
    size_to_el.dataset.active_wc_id = re_wc_id

    //TODO: use polyfill if we ever leave electron?
    // @ts-ignore
    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        if (
          entry.target.id == size_to_el.id &&
          size_to_el.dataset.active_wc_id
        ) {
          let bounds = {
            x: Math.floor(size_to_el.offsetLeft),
            y: Math.floor(size_to_el.offsetTop),
            width: Math.floor(size_to_el.clientWidth),
            height: Math.floor(size_to_el.clientHeight),
          }
          ipcRenderer.send(
            "bound_attached",
            size_to_el.dataset.active_wc_id,
            bounds
          )
        }
      }
    })

    resizeObserver.observe(size_to_el)
  }

  return re_wc_id
}

function webtab_comms() {
  let addtab_button = document.querySelector("#addtab")
  addtab_button.addEventListener("click", (x) => {
    let tab_content = document.querySelector<HTMLElement>("#tab_content")
    new_webtab(tab_content)
  })

  ipcRenderer.on("mark_selected", mark_selected)
  ipcRenderer.on("update_story", update_story)
  ipcRenderer.on("show_filter", show_filter)
  ipcRenderer.on("add_filter", add_filter)
  ipcRenderer.on("subscribe_to_change", subscribe_to_change)
  ipcRenderer.on("page-title-updated", update_title)
  ipcRenderer.on("detaching", detaching)
  ipcRenderer.on("open_in_new_tab", open_in_new_tab_event)
  ipcRenderer.on("update-target-url", show_target_url)
  ipcRenderer.on("open_in_tab", open_in_tab_event)

  function show_target_url(event: Electron.IpcRendererEvent, url: string) {
    let url_target = document.querySelector<HTMLElement>("#url_target")
    if (!url_target || !url) {
      return
    }

    if (url != "") {
      url_target.style.opacity = "1"
      url_target.style.zIndex = "16"
      if (url.length <= 63) {
        url_target.innerText = url
      } else {
        url_target.innerText = url.substring(0, 60) + "..."
      }
    } else {
      url_target.style.opacity = "0"
      url_target.style.zIndex = "-1"
    }
  }

  window.addEventListener("beforeunload", (x) => {
    //TODO: move all listeners to channel "tabcoms"
    ipcRenderer.removeAllListeners("tabcoms")
  })

  function open_in_new_tab_event(
    event: Electron.IpcRendererEvent,
    url: string
  ) {
    open_in_new_tab(url)
  }
  function open_in_tab_event(event: Electron.IpcRendererEvent, url: string) {
    open_in_tab(url)
  }

  function detaching(event: Electron.IpcRendererEvent) {
    console.log("detaching", event)
    remove_tab_el(event.senderId)
  }

  function show_filter(event: Electron.IpcRendererEvent, data: string) {
    filters.show_filter(data)
  }

  function add_filter(event: Electron.IpcRendererEvent, data: string) {
    filters.add_filter(data)
  }

  function update_story(
    event: Electron.IpcRendererEvent,
    data: { href: string; path: string; value: string }
  ) {
    story_map.update_story(data.href, data.path, data.value)
  }

  let subscribers: number[] = []

  function subscribe_to_change(event: Electron.IpcRendererEvent) {
    if (event.senderId && !subscribers.includes(event.senderId)) {
      console.debug("subscribe_to_change", event.senderId)
      subscribers.push(event.senderId)
      //TODO: filter here or on tab?
      document.body.addEventListener("data_change", function update(
        e: CustomEvent
      ) {
        //TODO: detect closed webcontent and remove listener
        send_to_id(event.senderId, "data_change", e.detail.story)
      })
    }
  }

  function mark_selected(event: Electron.IpcRendererEvent, href: string) {
    let colors = Array.from(
      document.querySelectorAll<HTMLElement>(".tag_style")
    )
      .map((x) => {
        return x.innerText
      })
      .join("\n")

    let tab_el = tab_el_from_id(event.senderId)
    if (tab_el) {
      tab_el.dataset.href = href
    }

    let story = story_list.mark_selected(null, href)

    if (href == "about:gone") {
      return
    }
    //ipcRenderer.sendTo
    send_to_id(event.senderId, "update_selected", story, colors)
  }

  function update_title(event: any, title: string) {
    let sender_tab = tab_el_from_id(event.senderId)
    console.log(event.senderId, title, sender_tab)
    if (sender_tab) {
      sender_tab.innerText = title.substring(0, 22)
      sender_tab.title = title
    }
  }

  document.ondragover = (x) => {
    x.preventDefault()
    console.debug("ondragover", x)
    document.body.style.background = "red"
  }

  document.ondragleave = (x) => {
    console.debug("ondragleave", x)
    document.body.style.background = ""
  }

  document.addEventListener("drop", (x) => {
    document.body.style.background = ""
    x.preventDefault()
    console.debug("ondrop", x)

    console.log(
      "ondrop",
      "text/html",
      x.dataTransfer.getData("text/html"),
      "tab_drop",
      x.dataTransfer.getData("tab_drop"),
      "text",
      x.dataTransfer.getData("text")
    )

    let tap_drop = x.dataTransfer.getData("tab_drop")
    if (tap_drop && tap_drop.startsWith("{")) {
      try {
        let tab_info = JSON.parse(tap_drop)
        add_tab(tab_info.wc_id)
        return
      } catch (e) {
        console.error("ondrop", "thought it was an tap_drop, but it wasn't", e)
      }
    }

    let text = x.dataTransfer.getData("text")
    if (text && (text.startsWith("https://") || text.startsWith("https://"))) {
      try {
        let url = new URL(text)
        open_in_new_tab(url.toString())
      } catch (e) {
        console.error("ondrop", "thought it was an URL, but it wasn't", e)
      }
    }

    let view_id = parseInt(x.dataTransfer.getData("text"))
    let tab_cnt = document.querySelector<HTMLElement>("#tab_content")
    if (!view_id || isNaN(view_id)) {
      return
    }

    attach_webtab(tab_cnt, view_id)
  })
}

function add_tab(wc_id: number) {
  if (!wc_id) {
    console.error("can't add tab with incomplete information")
    return
  }
  let existing_tab = tab_el_from_id(wc_id)
  if (existing_tab) {
    mark_tab_active(existing_tab)
  } else {
    let tab_content = document.querySelector<HTMLElement>("#tab_content")
    if (tab_content) {
      grab_webtab(tab_content, wc_id)
    } else {
      console.error("failed to find tab_content to attach tabs")
      return
    }
  }
}

function send_to_id(id: number, channel: string, ...args: any[]) {
  args = [...args].map((x) => {
    if (typeof x == "object") {
      x = JSON.parse(JSON.stringify(x))
    }
    return x
  })

  ipcRenderer.sendTo(id, channel, ...args)
}

function send_to_new_tab(channel: string, ...args: any[]) {
  let tab_cnt = document.querySelector<HTMLElement>("#tab_content")
  if (tab_cnt) {
    //creating new webtab
    let wc_id = new_webtab(tab_cnt)
    send_to_id(wc_id, channel, ...args)
  }
}

function get_active_tab_el(): HTMLElement | null {
  let active_tab = document.querySelector<HTMLElement>(
    "#tab_dropzone .tab.active"
  )
  let tab_content = document.querySelector<HTMLElement>("#tab_content")
  if (
    tab_content &&
    tab_content.dataset.active_wc_id &&
    active_tab &&
    active_tab.dataset.wc_id == tab_content.dataset.active_wc_id
  ) {
    return active_tab
  }
  return null
}

function send_or_create_tab(channel: string, ...args: any[]) {
  let active = get_active_tab_el()
  if (active) {
    send_to_id(parseInt(active.dataset.wc_id), channel, ...args)
  } else {
    send_to_new_tab(channel, ...args)
  }
}

function open_in_tab(href: string) {
  //do we need to start looking at target dingens?
  let is_in_tab =
    document.querySelector("#webtab") && document.querySelector("#webview")
  if (is_in_tab) {
    webtab.WebTab.open_in_webview(href)
  } else {
    send_or_create_tab("open_in_webview", href)
  }
}

function open_in_new_tab(href: string) {
  send_to_new_tab("open_in_webview", href)
}
