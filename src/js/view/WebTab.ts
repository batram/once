import { ipcRenderer } from "electron"
import * as fullscreen from "./fullscreen"
import * as presenters from "./presenters"
import * as story_list from "./StoryList"
import { StoryListItem } from "./StoryListItem"
import { remote_story_change } from "./StoryList"
import { Story } from "../data/Story"
import { StoryMap } from "../data/StoryMap"

export class WebTab {
  tab_state: string
  parent_id: number
  webview_ready: boolean
  current_story: Story

  webview: Electron.WebviewTag
  urlfield: HTMLInputElement

  constructor() {
    this.webview_ready = false
    this.webview = document.querySelector<Electron.WebviewTag>("#webview")
    this.urlfield = document.querySelector<HTMLInputElement>("#urlfield")

    this.webview.addEventListener("dom-ready", () => {
      this.webview_ready = true
      this.send_update_tab_info()
    })

    remote_story_change()

    ipcRenderer.on("open_in_webview", (event, href) => {
      console.debug("open_in_webview", href)
      this.open_in_webview(href)
    })

    window.addEventListener("mouseup", (e: MouseEvent) => {
      if (e.button == 3) {
        if (this.webview.canGoBack()) {
          this.webview.goBack()
        }
        return true
      }
      if (e.button == 4) {
        if (this.webview.canGoForward()) {
          this.webview.goForward()
        }
        return true
      }
      return false
    })

    fullscreen.render_listeners()

    ipcRenderer.on("pop_out", (event, offset) => {
      this.pop_new_main(JSON.parse(offset))
    })

    ipcRenderer.on("attached", (event, new_parent_id) => {
      console.debug("attached", new_parent_id)

      if (this.parent_id && this.parent_id != new_parent_id) {
        this.send_to_parent("detaching")
      }

      this.parent_id = new_parent_id
      this.tab_state = "attached"
      this.send_update_tab_info()
    })

    presenters.init_in_webtab(this)

    this.handle_urlbar()

    ipcRenderer.on("closed", (event) => {
      console.debug("closed", event)
      this.tab_state = "closed"
      ipcRenderer.removeAllListeners("push_tab_data_change")
      ipcRenderer.removeAllListeners("closed")
      ipcRenderer.send(
        "forward_to_parent",
        "update_tab_info",
        "about:blank",
        "about:blank"
      )
      ipcRenderer.send("end_me")
    })

    ipcRenderer.on("update-target-url", (event, url) => {
      this.send_to_parent("update-target-url", url)
    })

    ipcRenderer.on("start_media", () => {
      console.debug("start_media")
      //Force stop via JS since sending key does not end up with the correct result
      this.webview.executeJavaScript(`
        document.querySelectorAll("video, audio").forEach(x => {if(x.played.length != 0) x.play()})
      `)
      this.webview.focus()
      this.webview.sendInputEvent({
        type: "keyDown",
        keyCode: "mediaplaypause",
      })
      this.webview.sendInputEvent({ type: "keyUp", keyCode: "mediaplaypause" })
    })

    ipcRenderer.on("pause_media", () => {
      console.debug("pause_media")
      //Force stop via JS since sending key does not end up with the correct result
      this.webview.executeJavaScript(`
        document.querySelectorAll("video, audio").forEach(x => x.pause())
      `)
      this.webview.focus()
      this.webview.sendInputEvent({
        type: "keyDown",
        keyCode: "mediaplaypause",
      })
      this.webview.sendInputEvent({ type: "keyUp", keyCode: "mediaplaypause" })
    })

    this.webview.addEventListener("page-title-updated", (e) => {
      this.send_update_tab_info()
      console.log("page-title-updated", e.title.toString())
    })

    this.webview.addEventListener("did-fail-load", (e) => {
      console.log("webview did-fail-load", e)
    })

    this.webview.addEventListener("dom-ready", () => {
      this.inject_css()
    })

    this.webview.addEventListener(
      "update-target-url",
      (e: Electron.UpdateTargetUrlEvent) => {
        console.debug("update-target-url", e)
        this.send_to_parent("update-target-url", e.url)
      }
    )

    this.webview.addEventListener(
      "load-commit",
      (event: Electron.LoadCommitEvent) => {
        if (event.isMainFrame && this.is_attached()) {
          this.url_changed(event.url)
        }
      }
    )

    this.webview.addEventListener("did-start-loading", () => {
      this.inject_css()
    })
    this.webview.addEventListener(
      "did-navigate",
      async (e: Electron.DidNavigateEvent) => {
        const url = await this.url_changed(e.url)
        if (!this.is_attached()) {
          const selected = story_list.get_by_href(url)
          if (!selected) {
            this.update_selected(null)
          }
        }
        this.send_update_tab_info()
      }
    )

    this.webview.addEventListener("did-navigate-in-page", console.debug)

    this.webview.addEventListener("media-started-playing", () => {
      this.send_to_parent(
        "tab_media_started_playing",
        this.webview.isCurrentlyAudible().toString()
      )
    })

    this.webview.addEventListener("media-paused", () => {
      this.send_to_parent(
        "tab_media_paused",
        this.webview.isCurrentlyAudible().toString()
      )
    })

    const reload_tab_btn = document.querySelector<HTMLElement>(
      "#reload_tab_btn"
    )
    reload_tab_btn.onclick = () => {
      this.webview.reload()
    }

    const close_tab_btn = document.querySelector<HTMLElement>("#close_tab_btn")
    close_tab_btn.onclick = () => {
      this.send_to_parent("update_tab_info", "about:blank", "about:blank")
      this.send_to_parent("detaching")
      this.tab_state = "closed"
      ipcRenderer.send("end_me")
    }

    const pop_out_btn = document.querySelector<HTMLElement>("#pop_out_btn")
    pop_out_btn.onauxclick = () => {
      this.pop_no_tabs()
    }

    pop_out_btn.onclick = () => {
      this.pop_new_main()
    }
  }

  send_update_tab_info(): void {
    this.send_to_parent(
      "update_tab_info",
      this.urlfield.value,
      this.webview_ready ? this.webview.getTitle() : null
    )
  }

  pop_no_tabs(): void {
    ipcRenderer.send("tab_me_out", { type: "notabs" })
  }

  pop_new_main(offset: [] | null = null): void {
    offset = JSON.parse(JSON.stringify(offset))
    ipcRenderer.send("tab_me_out", { type: "main", offset: offset })
  }

  handle_urlbar(): void {
    if (this.urlfield) {
      this.urlfield.addEventListener("focus", () => {
        this.urlfield.select()
      })

      this.urlfield.addEventListener("keyup", (e) => {
        if (e.key == "Enter") {
          if (this.urlfield.value == "") {
            this.urlfield.value = "about:blank"
          }
          this.open_in_webview(this.urlfield.value)
        }
      })
    }
  }

  is_attached(): boolean {
    return this.tab_state == "attached" && this.parent_id != null
  }

  update_selected(story: Story): void {
    const selected_container = document.querySelector("#selected_container")

    selected_container.innerHTML = ""
    if (!story) {
      return
    }

    const story_el = new StoryListItem(story)
    story_el.classList.add("selected")
    selected_container.append(story_el)
  }

  send_to_parent(channel: string, ...args: string[]): void {
    ipcRenderer.sendTo(this.parent_id, channel, ...args)
  }

  inject_css(): void {
    const css = `
  ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  
  ::-webkit-scrollbar-thumb {
    background: #0000008c;
    border: 2px solid grey;
  }
  
  ::-webkit-scrollbar-thumb:hover {
    opacity: 0.7;
  }  

  @media (prefers-color-scheme: dark) {
    body {
      color: #bcc2cd !important;
      background: #383a59 !important;
    }

    .athing .c00, .athing .c00 a:link, .athing a:link { 
      color: #bcc2cd !important;
    }

    #hnmain {
      background-color: #44475a !important;
    }

    a {
      color: #6b6bef !important;
    }
  }
`
    this.webview.insertCSS(css)
  }

  async set_url(url: string): Promise<void> {
    this.urlfield.value = url
    console.log("url_changed", url)
    const story = await StoryMap.remote.find_by_url(url)
    console.debug(story, url)
    this.update_selected(story)
    if (story) {
      if (story.matches_story_url(url) && story.read_state != "read") {
        StoryMap.remote.persist_story_change(story.href, "read_state", "read")
      }
    }
    this.send_update_tab_info()
  }

  async url_changed(url: string): Promise<string> {
    if (url) {
      url = presenters.modify_url(url)
      this.set_url(url)
    }

    return url
  }

  async open_in_webview(href: string): Promise<void> {
    if (this.webview && this.urlfield) {
      if (await presenters.handled_by(href)) {
        //a presenter will handle everything about this url
        return
      }
      this.url_changed(href)
      this.webview.setAttribute("src", href)
    } else {
      console.error(
        "webtab not ready to load:",
        href,
        this.webview,
        this.urlfield
      )
    }
  }
}
