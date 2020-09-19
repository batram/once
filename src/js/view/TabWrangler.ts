import { ipcRenderer } from "electron"
import * as filters from "../data/filters"
import * as webtab from "./webtab"
import * as story_map from "../data/StoryMap"
import * as story_list from "./StoryList"

declare interface WranglerOptions {
  addtab_button: boolean
}

export class TabWrangler {
  tabhandler_element: HTMLElement
  tabcontent_element: HTMLElement
  tabs: HTMLElement[];
  [index: string]:
    | Function
    | HTMLElement
    | number
    | HTMLElement[]
    | WranglerOptions
  active_wc_id: number
  static instance: TabWrangler

  static ops = {
    proxy_func: function (func_name: string, ...args: any[]) {
      if (TabWrangler.instance) {
        let func = TabWrangler.instance[func_name]
        if (typeof func == "function") {
          func.call(TabWrangler.instance, ...args)
        }
      } else {
        //check comms
        console.log("comms", func_name, ...args)
        ipcRenderer.send("tab_intercom", func_name, ...args)
      }
    },
    send_to_new_tab: function (channel: string, ...args: any[]) {
      this.proxy_func("send_to_new_tab", channel, ...args)
    },
    send_or_create_tab: function (channel: string, ...args: any[]) {
      this.proxy_func("send_or_create_tab", channel, ...args)
    },
    open_in_tab(href: string) {
      this.proxy_func("open_in_tab", href)
    },
    open_in_new_tab(href: string) {
      this.proxy_func("open_in_new_tab", href)
    },
  }

  constructor(
    tabhandler_element: HTMLElement,
    tabcontent_element: HTMLElement,
    options?: WranglerOptions
  ) {
    if (TabWrangler.instance) {
      throw "There shall be only one TabWrangler ..."
    }

    this.tabs = []
    this.tabhandler_element = tabhandler_element
    this.tabcontent_element = tabcontent_element

    this.webtab_comms()
    if (options) {
      this.options = options
    }
    if (options && options.addtab_button) {
      let addtab_button = document.createElement("div")
      // document.querySelector<HTMLElement>("#addtab")
      addtab_button.id = "addtab_button"
      addtab_button.title = "open new tab"
      addtab_button.innerText = "+"
      addtab_button.setAttribute("draggable", "false")
      addtab_button.addEventListener("click", (x) => {
        this.new_webtab()
      })
      tabhandler_element.append(addtab_button)
    }

    TabWrangler.instance = this
  }

  //close the window if we have no more tabs and are not the last window open
  maybe_close_window() {
    if (document.querySelectorAll(".tab").length == 0) {
      ipcRenderer.send("no_more_tabs_can_i_go")
    }
  }

  webtab_comms() {
    ipcRenderer.on(
      "tab_intercom",
      (event: Electron.IpcRendererEvent, ...args: any) => {
        console.log("tab_intercom")
      }
    )

    ipcRenderer.on(
      "update-target-url",
      (event: Electron.IpcRendererEvent, url: string) => {
        let url_target = document.querySelector<HTMLElement>("#url_target")
        if (!url_target) {
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
    )

    ipcRenderer.on(
      "open_in_new_tab",
      (event: Electron.IpcRendererEvent, url: string) => {
        this.open_in_new_tab(url)
      }
    )

    ipcRenderer.on(
      "open_in_tab",
      (event: Electron.IpcRendererEvent, url: string) => {
        this.open_in_tab(url)
      }
    )

    ipcRenderer.on("detaching", (event: Electron.IpcRendererEvent) => {
      console.log("detaching", event)
      this.remove_tab_el(event.senderId)
    })

    ipcRenderer.on("update_story", update_story)
    ipcRenderer.on(
      "show_filter",
      (event: Electron.IpcRendererEvent, data: string) => {
        filters.show_filter(data)
      }
    )
    ipcRenderer.on(
      "add_filter",
      (event: Electron.IpcRendererEvent, data: string) => {
        filters.add_filter(data)
      }
    )

    function update_story(
      event: Electron.IpcRendererEvent,
      data: { href: string; path: string; value: string }
    ) {
      story_map.update_story(data.href, data.path, data.value)
    }

    let subscribers: number[] = []
    ipcRenderer.on(
      "subscribe_to_change",
      (event: Electron.IpcRendererEvent) => {
        if (event.senderId && !subscribers.includes(event.senderId)) {
          console.debug("subscribe_to_change", event.senderId)
          subscribers.push(event.senderId)
          //TODO: filter here or on tab?
          document.body.addEventListener("data_change", (e: CustomEvent) => {
            if (e.detail.story) {
              this.send_to_id(event.senderId, "data_change", e.detail.story)
            }
          })
        }
      }
    )

    ipcRenderer.on(
      "mark_selected",
      (event: Electron.IpcRendererEvent, href: string) => {
        let colors = Array.from(
          document.querySelectorAll<HTMLElement>(".tag_style")
        )
          .map((x) => {
            return x.innerText
          })
          .join("\n")

        let tab_el = this.tab_el_from_id(event.senderId)
        if (tab_el) {
          tab_el.dataset.href = href
        }

        let story = story_list.mark_selected(null, href)

        if (href == "about:gone") {
          return
        }
        //ipcRenderer.sendTo
        this.send_to_id(event.senderId, "update_selected", story, colors)
      }
    )

    ipcRenderer.on(
      "update_tab_info",
      (event: any, title: string, href: string) => {
        let sender_tab = this.tab_el_from_id(event.senderId)
        console.log(event.senderId, title, sender_tab)
        if (sender_tab) {
          sender_tab.dataset.href = href
          sender_tab.innerText = title.substring(0, 22)
          sender_tab.title = title
        }
      }
    )

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
          this.add_tab(tab_info.wc_id, tab_info.title, tab_info.href)
          return
        } catch (e) {
          console.error(
            "ondrop",
            "thought it was an tap_drop, but it wasn't",
            e
          )
        }
      }

      let text = x.dataTransfer.getData("text")
      if (
        text &&
        (text.startsWith("https://") || text.startsWith("https://"))
      ) {
        try {
          let url = new URL(text)
          this.open_in_new_tab(url.toString())
        } catch (e) {
          console.error("ondrop", "thought it was an URL, but it wasn't", e)
        }
      }

      let view_id = parseInt(x.dataTransfer.getData("text"))
      let tab_content = document.querySelector<HTMLElement>("#tab_content")
      if (!view_id || isNaN(view_id)) {
        return
      }

      this.attach_webtab(view_id)
    })
  }

  add_tab(wc_id: number, title?: string, href?: string) {
    if (!wc_id) {
      console.error("can't add tab with incomplete information")
      return
    }
    let existing_tab = this.tab_el_from_id(wc_id)
    if (existing_tab) {
      this.mark_tab_active(existing_tab)
    } else {
      let ret_wc_id = this.grab_webtab(wc_id)
      if (ret_wc_id == wc_id) {
        let tab_el = this.tab_el_from_id(ret_wc_id)
        tab_el.dataset.href = href
        tab_el.title = title
        tab_el.innerText = title.substring(0, 22)
      }
    }
  }

  send_to_id(id: number, channel: string, ...args: any[]) {
    args = [...args].map((x) => {
      if (typeof x == "object") {
        x = JSON.parse(JSON.stringify(x))
      }
      return x
    })

    ipcRenderer.sendTo(id, channel, ...args)
  }

  send_to_new_tab(channel: string, ...args: any[]) {
    let wc_id = this.new_webtab()
    ipcRenderer.send("when_webview_ready", wc_id, channel, ...args)
  }

  get_active_tab_el(): HTMLElement | null {
    let active_tab = document.querySelector<HTMLElement>(
      "#tab_dropzone .tab.active"
    )
    let tab_content = document.querySelector<HTMLElement>("#tab_content")
    if (
      tab_content &&
      this.active_wc_id &&
      active_tab &&
      parseInt(active_tab.dataset.wc_id) == this.active_wc_id
    ) {
      return active_tab
    }
    return null
  }

  send_or_create_tab(channel: string, ...args: any[]) {
    let active = this.get_active_tab_el()
    if (active) {
      this.send_to_id(parseInt(active.dataset.wc_id), channel, ...args)
    } else {
      this.send_to_new_tab(channel, ...args)
    }
  }

  open_in_tab(href: string) {
    //do we need to start looking at target dingens?
    let is_in_tab =
      document.querySelector("#webtab") && document.querySelector("#webview")
    if (is_in_tab) {
      webtab.WebTab.open_in_webview(href)
    } else {
      this.send_or_create_tab("open_in_webview", href)
    }
  }

  open_in_new_tab(href: string) {
    this.send_to_new_tab("open_in_webview", href)
  }

  remove_tab_el(wc_id: number) {
    let tab_el = this.tab_el_from_id(wc_id)
    if (tab_el) {
      if (this.active_wc_id == wc_id) {
        let prev = tab_el.previousElementSibling as HTMLElement
        if (prev && prev.classList.contains("tab")) {
          this.activate_tab(prev)
        } else {
          let next = tab_el.nextElementSibling as HTMLElement
          if (next && next.classList.contains("tab")) {
            next
            this.activate_tab(next)
          } else {
            this.active_wc_id = null
          }
        }
      }

      tab_el.outerHTML = ""
    }

    this.maybe_close_window()
  }

  close_tab(tab_el: HTMLElement) {
    this.send_to_id(parseInt(tab_el.dataset.wc_id), "closed")
    this.remove_tab_el(parseInt(tab_el.dataset.wc_id))
  }

  new_webtab(): number {
    return this.grab_webtab(0)
  }

  activate_tab(tab_el: HTMLElement) {
    this.attach_webtab(parseInt(tab_el.dataset.wc_id))
    this.mark_tab_active(tab_el)
  }

  new_tab_element(wc_id: number): HTMLElement | null {
    let tab_el = document.createElement("div")
    tab_el.setAttribute("draggable", "true")
    tab_el.classList.add("tab")
    tab_el.innerText = "New tab"
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
          title: tab_el.title,
          href: tab_el.dataset.href,
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
        this.send_to_id(parseInt(tab_el.dataset.wc_id), "pop_out", offset)
      }
    }

    tab_el.addEventListener("mousedown", (e) => {
      if (e.button == 0) {
        this.activate_tab(tab_el)
      } else if (e.button == 1) {
        this.close_tab(tab_el)
      }
    })

    return tab_el
  }

  tab_el_from_id(wc_id: number) {
    return document.querySelector<HTMLElement>(`.tab[data-wc_id="${wc_id}"]`)
  }

  grab_attached_or_new() {
    let wc_id = ipcRenderer.sendSync("get_attached_wc_id")

    console.log("attacjed?", wc_id, wc_id != null)

    if (wc_id != null) {
      this.grab_webtab(wc_id)
      return true
    } else {
      this.new_webtab()
      return false
    }
  }

  grab_webtab(wc_id: number) {
    let ret_wc_id = this.attach_webtab(wc_id)
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

    let new_el = this.new_tab_element(ret_wc_id)
    this.mark_tab_active(new_el)

    return ret_wc_id
  }

  mark_tab_active(tab_el: HTMLElement) {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.remove("active")
    })
    tab_el.classList.add("active")
  }

  attach_webtab(wc_id: number) {
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

    if (this.tabcontent_element) {
      let size_to_el = this.tabcontent_element
      this.active_wc_id = re_wc_id

      //TODO: use polyfill if we ever leave electron?
      // @ts-ignore
      const resizeObserver = new ResizeObserver((entries) => {
        for (let entry of entries) {
          if (entry.target.id == size_to_el.id && this.active_wc_id) {
            let bounds = {
              x: Math.floor(size_to_el.offsetLeft),
              y: Math.floor(size_to_el.offsetTop),
              width: Math.floor(size_to_el.clientWidth),
              height: Math.floor(size_to_el.clientHeight),
            }
            ipcRenderer.send("bound_attached", this.active_wc_id, bounds)
          }
        }
      })

      resizeObserver.observe(size_to_el)
    }

    return re_wc_id
  }
}
