import { ipcRenderer } from "electron"
import * as StoryFilterView from "../view/StoryFilterView"
import { StoryMap } from "../data/StoryMap"
import * as story_list from "./StoryList"
import { search_stories } from "../data/search"
import { Story } from "../data/Story"

declare interface WranglerOptions {
  addtab_button: boolean
}

export class TabWrangler {
  tabhandler_element: HTMLElement
  tabcontent_element: HTMLElement
  tabs: HTMLElement[];
  [index: string]:
    | HTMLElement
    | number
    | HTMLElement[]
    | WranglerOptions
    | ((...args: unknown[]) => unknown)
  active_wc_id: number
  static instance: TabWrangler

  static ops = {
    proxy_func: function (func_name: string, ...args: string[]): void {
      if (TabWrangler.instance) {
        const func = TabWrangler.instance[func_name]
        if (typeof func == "function") {
          func.call(TabWrangler.instance, ...args)
        }
      } else {
        ipcRenderer.send("forward_to_parent", func_name, ...args)
      }
    },
    send_to_new_tab: function (
      channel: string,
      ...args: (string | Blob | Buffer)[]
    ): void {
      this.proxy_func("send_to_new_tab", channel, ...args)
    },
    send_or_create_tab: function (
      channel: string,
      ...args: (string | Blob | Buffer)[]
    ): void {
      this.proxy_func("send_or_create_tab", channel, ...args)
    },
    open_in_tab(href: string): void {
      this.proxy_func("open_in_tab", href)
    },
    open_in_new_tab(href: string): void {
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

    this.init_webtab_comms()
    this.init_draggable_tabs()

    if (options) {
      this.options = options
    }
    if (options && options.addtab_button) {
      const addtab_button = document.createElement("div")
      // document.querySelector<HTMLElement>("#addtab")
      addtab_button.id = "addtab_button"
      addtab_button.title = "open new tab"
      addtab_button.innerText = "+"
      addtab_button.setAttribute("draggable", "false")
      addtab_button.addEventListener("click", () => {
        this.new_webtab()
      })
      tabhandler_element.append(addtab_button)
    }

    tabhandler_element.addEventListener("wheel", (event) => {
      tabhandler_element.scrollBy(event.deltaY, 0)
      event.preventDefault()
    })

    TabWrangler.instance = this
  }

  //close the window if we have no more tabs and are not the last window open
  maybe_close_window(): void {
    if (document.querySelectorAll(".tab").length == 0) {
      ipcRenderer.send("no_more_tabs_can_i_go")
    }
  }

  init_webtab_comms(): void {
    ipcRenderer.on(
      "search_stories",
      (event: Electron.IpcRendererEvent, needle) => {
        console.debug("search_stories", needle)
        search_stories(needle)
      }
    )

    ipcRenderer.on(
      "send_to_new_tab",
      (
        event: Electron.IpcRendererEvent,
        channel: string,
        ...args: string[]
      ) => {
        console.debug("send_to_new_tab", ...args)
        this.send_to_new_tab(channel, ...args)
      }
    )

    ipcRenderer.on(
      "send_or_create_tab",
      (
        event: Electron.IpcRendererEvent,
        channel: string,
        ...args: string[]
      ) => {
        console.debug("send_or_create_tab", ...args)
        this.send_or_create_tab(channel, ...args)
      }
    )

    ipcRenderer.on(
      "update-target-url",
      (event: Electron.IpcRendererEvent, url: string) => {
        const url_target = document.querySelector<HTMLElement>("#url_target")
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
      "open_in_new_window",
      (event: Electron.IpcRendererEvent, url: string) => {
        ipcRenderer.send("open_in_new_window", url)
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

    ipcRenderer.on(
      "show_filter",
      (event: Electron.IpcRendererEvent, data: string) => {
        StoryFilterView.show_filter(data)
      }
    )

    ipcRenderer.on(
      "update_tab_info",
      (event: Electron.IpcRendererEvent, href: string, title?: string) => {
        this.update_tab_info(event.senderId, href, title)
      }
    )

    ipcRenderer.on(
      "tab_close",
      (event: Electron.IpcRendererEvent, wc_id: string) => {
        this.close_tab(this.tab_el_from_id(parseInt(wc_id)))
      }
    )

    ipcRenderer.on(
      "tab_dupe",
      (event: Electron.IpcRendererEvent, wc_id: string) => {
        const tab_el = this.tab_el_from_id(parseInt(wc_id))
        this.open_in_new_tab(tab_el.dataset.href)
      }
    )

    ipcRenderer.on(
      "tab_media_paused",
      (event: Electron.IpcRendererEvent, audible) => {
        console.debug("tab_media_paused", event, audible)
        const tab_el = this.tab_el_from_id(event.senderId)
        tab_el.setAttribute("media", "paused")
      }
    )

    ipcRenderer.on(
      "tab_media_started_playing",
      (event: Electron.IpcRendererEvent, audible) => {
        console.debug("tab_media_started_playing", event, audible)
        const tab_el = this.tab_el_from_id(event.senderId)
        tab_el.setAttribute("media", "started")
      }
    )
  }

  insert_tab_by_offleft(tab_el: HTMLElement): void {
    const all_tabs = Array.from(
      this.tabhandler_element.querySelectorAll<HTMLElement>(".tab")
    )
    //reset placeholder space
    all_tabs.forEach((tab) => {
      tab.style.marginLeft = ""
    })

    const tabs = all_tabs.filter((x) => x != tab_el)
    if (tabs.length == 0) {
      return
    }

    let i = 0
    let current_el = tabs[i]
    while (
      i < tabs.length &&
      current_el.offsetLeft - this.tabhandler_element.scrollLeft <
        tab_el.offsetLeft - tab_el.clientWidth / 2
    ) {
      i += 1
      current_el = tabs[i]
    }

    const before_el = tabs[i]

    if (before_el) {
      before_el.style.marginLeft = tab_el.clientWidth + "px"
      this.tabhandler_element.insertBefore(tab_el, before_el)
    } else {
      this.tabhandler_element.append(tab_el)
    }
  }

  tab_image_overly: HTMLImageElement

  drag_reset_listener(): void {
    if (this.tab_image_overly && this.active_wc_id != null) {
      console.log("reset on mousemove")
      this.reset_drag()
    }
    window.removeEventListener("mousemove", this.drag_reset_listener)
  }

  init_draggable_tabs(): void {
    window.addEventListener("dragover", (x) => {
      window.addEventListener("mousemove", this.drag_reset_listener)
      x.preventDefault()
      document.body.style.background = "green"
    })

    window.addEventListener("dragenter", (x) => {
      x.dataTransfer.dropEffect = "link"
      x.preventDefault()
      console.debug("ondragenter", x)
      document.body.style.background = "green"

      const window_content = document.querySelector("#window_content")
      window_content.classList.add("active_drag")

      if (!this.tab_image_overly && this.active_wc_id != null) {
        this.tab_image_overly = document.createElement("img")
        this.tab_image_overly.classList.add("pic_webtab")
        this.tab_image_overly.style.position = "absolute"
        this.tab_image_overly.style.opacity = "0.8"

        const gen_img = async () => {
          const img_url = await ipcRenderer.invoke(
            "pic_webtab",
            this.active_wc_id
          )
          if (this.tab_image_overly) {
            this.tab_image_overly.src = img_url
          }
        }
        gen_img()

        this.tabcontent_element.append(this.tab_image_overly)
        ipcRenderer.send("hide_webtab", this.active_wc_id)
      }
      return true
    })

    window.addEventListener("dragleave", (x) => {
      console.debug("ondragleave", x)
      document.body.style.background = ""
      if (x.pageX == 0 && x.pageY == 0) {
        const window_content = document.querySelector("#window_content")
        window_content.classList.remove("active_drag")
      }
    })

    window.addEventListener("drop", (x) => {
      x.preventDefault()
      this.reset_drag()
      console.debug("on drop", x)

      const tap_drop = x.dataTransfer.getData("tab_drop")
      if (tap_drop && tap_drop.startsWith("{")) {
        try {
          const tab_info = JSON.parse(tap_drop)
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

      const text = x.dataTransfer.getData("text")
      if (
        text &&
        (text.startsWith("https://") || text.startsWith("https://"))
      ) {
        try {
          const url = new URL(text)
          this.open_in_new_tab(url.toString())
        } catch (e) {
          console.error("ondrop", "thought it was an URL, but it wasn't", e)
        }
      }

      const view_id = parseInt(x.dataTransfer.getData("text"))
      if (!view_id || isNaN(view_id)) {
        return
      }

      this.attach_webtab(view_id)
    })
  }

  reset_drag(): void {
    const window_content = document.querySelector("#window_content")
    window_content.classList.remove("active_drag")

    if (this.tab_image_overly) {
      ipcRenderer.send("attach_wc_id", this.active_wc_id)
      this.tab_image_overly.outerHTML = ""
      this.tab_image_overly = null
    }
    document.body.style.background = ""
    const active_el = this.get_active_tab_el()
    if (active_el) {
      active_el.style.display = ""
    }
  }

  make_tab_el_draggable(tab_el: HTMLElement): void {
    let start_offset = -1

    tab_el.ondrag = (drag) => {
      drag.preventDefault()
      if (drag.target == tab_el) {
        tab_el.style.position = "absolute"
        if (drag.pageX > this.tabcontent_element.offsetLeft) {
          tab_el.style.display = ""
          tab_el.style.left = drag.pageX - start_offset + "px"
        } else {
          tab_el.style.display = "none"
        }
        this.insert_tab_by_offleft(tab_el)
      }
    }

    tab_el.ondragstart = (drag) => {
      if (start_offset == -1) {
        start_offset = drag.offsetX
      }
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
      this.insert_tab_by_offleft(tab_el)
      this.reset_drag()
      //reset placeholder space
      const all_tabs = Array.from(
        this.tabhandler_element.querySelectorAll<HTMLElement>(".tab")
      )

      all_tabs.forEach((tab) => {
        tab.style.marginLeft = ""
      })

      tab_el.style.position = ""
      tab_el.style.left = ""

      start_offset = -1
      drag.preventDefault()
      this.reset_drag()

      console.log("drop tab_el", drag.dataTransfer.dropEffect)

      if (drag.dataTransfer.dropEffect == "none") {
        const offset = JSON.stringify([drag.offsetX, drag.offsetY])
        this.send_to_id(parseInt(tab_el.dataset.wc_id), "pop_out", offset)
        //this.remove_tab_el(tab_el.dataset.wc_id)
      }
    }

    tab_el.addEventListener("mousedown", (e) => {
      if (e.button == 0) {
        this.activate_tab(tab_el)
      } else if (e.button == 1) {
        this.close_tab(tab_el)
      }
    })

    tab_el.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault()
        ipcRenderer.send(
          "show_tab_menu",
          e.x,
          e.y,
          tab_el.dataset.href,
          tab_el.dataset.wc_id
        )
      },
      false
    )
  }

  async add_tab(wc_id: number, title?: string, href?: string): Promise<void> {
    if (!wc_id) {
      console.error("can't add tab with incomplete information")
      return
    }
    const existing_tab = this.tab_el_from_id(wc_id)
    if (existing_tab) {
      this.attach_webtab(wc_id)
      this.mark_tab_active(existing_tab)
    } else {
      const ret_wc_id = await this.grab_webtab(wc_id)
      if (ret_wc_id == wc_id) {
        this.update_tab_info(ret_wc_id, href, title)
      }
    }
  }

  async update_tab_info(
    wc_id: number,
    href: string,
    title?: string
  ): Promise<void> {
    console.debug("update_tab_info", wc_id, href, title)
    const tab_el = this.tab_el_from_id(wc_id)
    if (tab_el) {
      if (tab_el.dataset.href != href) {
        tab_el.removeAttribute("media")
      }
      tab_el.dataset.href = href
      if (!title || (href != "about:blank" && title == "about:blank")) {
        // try to find story with url and get title
        const story = await StoryMap.remote.get(href)
        if (story) {
          title = story.title
        }
      }
      if (title) {
        tab_el.querySelector<HTMLElement>(
          ".tab_title"
        ).innerText = title.substring(0, 22)
        tab_el.title = title
      }
    }
  }

  send_to_id(
    id: number,
    channel: string,
    ...args: (string | Story | story_list.DataChangeEvent)[]
  ): void {
    args = [...args].map((x) => {
      if (typeof x == "object") {
        x = JSON.parse(JSON.stringify(x))
      }
      return x
    })

    ipcRenderer.sendTo(id, channel, ...args)
  }

  async send_to_new_tab(channel: string, ...args: string[]): Promise<number> {
    const wc_id = await this.new_webtab()
    ipcRenderer.send("when_webview_ready", wc_id, channel, ...args)
    return wc_id
  }

  get_active_tab_el(): HTMLElement | null {
    const active_tab = document.querySelector<HTMLElement>(
      "#tab_dropzone .tab.active"
    )
    const tab_content = document.querySelector<HTMLElement>("#tab_content")
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

  send_or_create_tab(channel: string, ...args: string[]): void {
    const active = this.get_active_tab_el()
    if (active) {
      this.send_to_id(parseInt(active.dataset.wc_id), channel, ...args)
    } else {
      this.send_to_new_tab(channel, ...args)
    }
  }

  open_in_tab(href: string): void {
    this.send_or_create_tab("open_in_webview", href)
  }

  async open_in_new_tab(href: string): Promise<void> {
    const wc_id = await this.send_to_new_tab("open_in_webview", href)
    if (wc_id) {
      const tab_el = this.tab_el_from_id(wc_id)
      if (tab_el) {
        tab_el.dataset.href = href
      }
    }
  }

  remove_tab_el(wc_id: number): void {
    const tab_el = this.tab_el_from_id(wc_id)
    if (tab_el) {
      if (this.active_wc_id == wc_id) {
        const prev = tab_el.previousElementSibling as HTMLElement
        if (prev && prev.classList.contains("tab")) {
          this.activate_tab(prev)
        } else {
          const next = tab_el.nextElementSibling as HTMLElement
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

  close_tab(tab_el: HTMLElement): void {
    this.send_to_id(parseInt(tab_el.dataset.wc_id), "closed")
    this.remove_tab_el(parseInt(tab_el.dataset.wc_id))
  }

  async new_webtab(): Promise<number> {
    return this.grab_webtab(0)
  }

  activate_tab(tab_el: HTMLElement): void {
    this.attach_webtab(parseInt(tab_el.dataset.wc_id))
    this.mark_tab_active(tab_el)
  }

  new_tab_element(wc_id: number): HTMLElement | null {
    const tab_el = document.createElement("div")
    tab_el.setAttribute("draggable", "true")
    tab_el.classList.add("tab")

    const mediastate = document.createElement("div")
    mediastate.classList.add("tab_mediastate")
    mediastate.onclick = () => {
      if (tab_el.getAttribute("media") == "paused") {
        ipcRenderer.sendTo(wc_id, "start_media")
      } else {
        ipcRenderer.sendTo(wc_id, "pause_media")
      }
    }
    tab_el.append(mediastate)

    const tab_title = document.createElement("div")
    tab_title.classList.add("tab_title")
    tab_title.innerText = "New tab"
    tab_el.append(tab_title)

    tab_el.dataset.wc_id = wc_id.toString()

    const dropzone = document.querySelector("#tab_dropzone")
    if (dropzone) {
      dropzone.append(tab_el)
    } else {
      console.error("failed to find dropzone for tabs")
      return null
    }

    this.make_tab_el_draggable(tab_el)

    return tab_el
  }

  tab_el_from_id(wc_id: number): HTMLElement {
    return document.querySelector<HTMLElement>(`.tab[data-wc_id="${wc_id}"]`)
  }

  async grab_attached_or_new(): Promise<boolean> {
    const wc_id = await ipcRenderer.invoke("get_attached_wc_id")

    console.log("attacjed?", wc_id, wc_id != null)

    if (wc_id != null) {
      this.grab_webtab(wc_id)
      return true
    } else {
      this.new_webtab()
      return false
    }
  }

  async grab_webtab(wc_id: number): Promise<number> {
    const ret_wc_id = await this.attach_webtab(wc_id)
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

    const new_el = this.new_tab_element(ret_wc_id)
    this.mark_tab_active(new_el)

    return ret_wc_id
  }

  mark_tab_active(tab_el: HTMLElement): void {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.remove("active")
    })
    tab_el.classList.add("active")
  }

  async attach_webtab(wc_id: number): Promise<number> {
    let re_wc_id = null
    if (wc_id != null && wc_id != 0) {
      re_wc_id = await ipcRenderer.invoke("attach_wc_id", wc_id)
    } else {
      re_wc_id = await ipcRenderer.invoke("attach_new_tab")
    }

    if (!re_wc_id) {
      console.error("failed to create or retrieve view to attach")
      return
    }

    if (this.tabcontent_element) {
      const size_to_el = this.tabcontent_element
      this.active_wc_id = re_wc_id

      //TODO: use polyfill if we ever leave electron?
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.target.id == size_to_el.id && this.active_wc_id) {
            const bounds = {
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

declare class ResizeObserver {
  constructor(callback: (entries: { target: HTMLElement }[]) => unknown)
  observe(entry: HTMLElement): void
}
