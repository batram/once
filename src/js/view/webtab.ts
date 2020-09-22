import { ipcRenderer } from "electron"
import * as fullscreen from "../view/fullscreen"
import * as presenters from "../view/presenters"
import * as story_list from "../view/StoryList"
import { StoryListItem } from "../view/StoryListItem"
import { Story } from "../data/Story"
import { DataChangeEvent } from "../data/StoryMap"

export class WebTab {
  tab_state: string
  parent_id: number
  webview_ready: boolean
  current_story: Story

  constructor() {
    this.webview_ready = false
    let webview = document.querySelector<Electron.WebviewTag>("#webview")
    webview.addEventListener("dom-ready", (x) => {
      this.webview_ready = true
      this.send_update_tab_info()
    })

    ipcRenderer.on("open_in_webview", (event, href) => {
      console.debug("open_in_webview", href)
      WebTab.open_in_webview(href)
    })

    window.addEventListener("mouseup", (e: MouseEvent) => {
      let webview = this.get_webview()

      if (e.button == 3) {
        if (webview.canGoBack()) {
          webview.goBack()
        }
        return true
      }
      if (e.button == 4) {
        if (webview.canGoForward()) {
          webview.goForward()
        }
        return true
      }
      return false
    })

    fullscreen.render_listeners()

    ipcRenderer.on("pop_out", (event, offset) => {
      this.pop_new_main(JSON.parse(offset))
    })

    ipcRenderer.on("attached", (event, data) => {
      console.debug("attached", data)

      if (this.parent_id && this.parent_id != data) {
        this.send_to_parent("detaching")
        //let old_parent = BrowserWindow.fromId(parseInt(this.parent_id))
        //old_parent.removeBrowserView(cview)
      }

      this.parent_id = data
      this.tab_state = "attached"
      this.send_to_parent("subscribe_to_change")

      this.send_update_tab_info()
    })

    ipcRenderer.on("detach", (event, data) => {
      this.tab_state = "detached"
    })

    presenters.init_in_webtab()

    this.handle_urlbar()

    ipcRenderer.on("closed", (event, data) => {
      console.debug("closed", event, data)
      this.tab_state = "closed"
      ipcRenderer.removeAllListeners("push_tab_data_change")
      ipcRenderer.removeAllListeners("closed")
      //...
      //detach and destroy
      ipcRenderer.send("end_me")
    })

    ipcRenderer.on(
      "push_tab_data_change",
      (ipc_event, change_event: DataChangeEvent) => {
        console.debug("push_tab_data_change", ipc_event, change_event)
        let selected = story_list.get_by_href(change_event.detail.story.href)
        if (selected) {
          selected.dispatchEvent(
            new DataChangeEvent("data_change", change_event.detail)
          )
          this.current_story = change_event.detail.story
        } else {
          this.current_story = null
        }
      }
    )

    ipcRenderer.on("update_selected", (event, story, colors) => {
      console.debug("update_selected", story)
      this.update_selected(story, colors)
    })

    ipcRenderer.on("update-target-url", (event, url) => {
      this.send_to_parent("update-target-url", url)
    })

    webview.addEventListener("page-title-updated", (e) => {
      this.send_update_tab_info()
      console.log("page-title-updated", e.title.toString())
    })

    webview.addEventListener("did-fail-load", (e) => {
      console.log("webview did-fail-load", e)
    })

    webview.addEventListener("dom-ready", () => {
      this.inject_css()
    })

    webview.addEventListener(
      "update-target-url",
      (e: Electron.UpdateTargetUrlEvent) => {
        console.debug("update-target-url", e)
        this.send_to_parent("update-target-url", e.url)
      }
    )

    webview.addEventListener("load-commit", (event: Electron.LoadCommitEvent) => {
      if (event.isMainFrame && this.is_attached()) {
        this.send_to_parent("tab_url_changed", event.url)
      } 
    })

    webview.addEventListener("did-start-loading", () => {
      this.inject_css()
    })
    webview.addEventListener("did-navigate", (e: Electron.DidNavigateEvent) => {
      let url = e.url
      url = presenters.modify_url(url)
      if (this.is_attached()) {
        this.send_to_parent("tab_url_changed", url)
      } else {
        let selected = story_list.get_by_href(url)
        if (!selected) {
          this.update_selected(null, null)
        }
      }
      this.send_update_tab_info()
      let urlfield = document.querySelector<HTMLInputElement>("#urlfield")
      urlfield.value = url
    })

    webview.addEventListener("did-navigate-in-page", console.debug)

    let reload_tab_btn = document.querySelector<HTMLElement>("#reload_tab_btn")
    reload_tab_btn.onclick = (x) => {
      webview.reload()
    }

    let close_tab_btn = document.querySelector<HTMLElement>("#close_tab_btn")
    close_tab_btn.onclick = (x) => {
      webview.loadURL("about:blank")
      this.send_to_parent("page-title-updated", "about:blank", "about:blank")
      this.send_to_parent("detaching")
      ipcRenderer.send("end_me")
    }

    let pop_out_btn = document.querySelector<HTMLElement>("#pop_out_btn")
    pop_out_btn.onauxclick = (x) => {
      this.pop_no_tabs()
    }

    pop_out_btn.onclick = (x) => {
      this.pop_new_main()
    }
  }

  send_update_tab_info(e?: any) {
    if (this.webview_ready) {
      let webview = this.get_webview()
      let urlfield = document.querySelector<HTMLInputElement>("#urlfield")
      this.send_to_parent("update_tab_info", webview.getTitle(), urlfield.value)
    }
  }

  pop_no_tabs() {
    ipcRenderer.send("tab_me_out", { type: "notabs" })
  }

  pop_new_main(offset: [] | null = null) {
    offset = JSON.parse(JSON.stringify(offset))
    ipcRenderer.send("tab_me_out", { type: "main", offset: offset })
  }

  handle_urlbar() {
    let urlfield = document.querySelector<HTMLInputElement>("#urlfield")
    if (urlfield) {
      urlfield.addEventListener("focus", (e) => {
        urlfield.select()
      })

      urlfield.addEventListener("keyup", (e) => {
        if (e.key == "Enter") {
          if (urlfield.value == "") {
            urlfield.value = "about:blank"
          }
          WebTab.open_in_webview(urlfield.value)
        }
      })
    }
  }

  is_attached() {
    return this.tab_state == "attached" && this.parent_id
  }

  //object | Story
  update_selected(story: Story, colors?: string) {
    let selected_container = document.querySelector("#selected_container")

    if (colors != undefined) {
      var style =
        document.querySelector<HTMLStyleElement>(".tag_style") ||
        document.createElement("style")
      style.classList.add("tag_style")
      style.type = "text/css"
      style.innerHTML = colors
      document.head.append(style)
    }

    selected_container.innerHTML = ""
    if (!story) {
      return
    }

    let story_el = new StoryListItem(story)
    story_el.classList.add("selected")
    selected_container.append(story_el)
  }

  get_webview(): Electron.WebviewTag {
    return document.querySelector<Electron.WebviewTag>("webview")
  }

  send_to_parent(channel: string, ...args: any) {
    ipcRenderer.sendTo(this.parent_id, channel, ...args)
  }

  load_started(_e: any) {}

  inject_css() {
    let css = `
  html {
    margin: 0;
    padding: 0;
    display: flex;
    box-sizing: content-box;
    width: 100%;    
  }

  body {
    margin: 0;
    padding: 0px 10px;
    box-sizing: border-box;
    width: 100%;    
    display: flex;
    flex-direction: column;
  }

  a {
    color: #6b6bef;
  }


  img, pre, p {
    max-width: 100%;
    max-height: 350px;
    width: auto;
    height: auto;  
  }

  pre {
    overflow-x: auto;
    padding: 10px;
  }

  ul {
    margin: 5px;
    padding: 0 25px;
  }

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
    let webview = document.querySelector<Electron.WebviewTag>("webview")
    webview.insertCSS(css)
  }

  static open_in_webview(href: string) {
    let webview = document.querySelector<Electron.WebviewTag>("#webview")
    let urlfield = document.querySelector<HTMLInputElement>("#urlfield")
    if (webview && urlfield) {
      ipcRenderer.send("forward_to_parent", "tab_url_changed", href)
      webview.loadURL(href).then(e => {
        console.debug("open_in_webview load", e, href)
      }).catch((e) => {
        console.log("webview.loadURL error", e)
      })
      urlfield.value = href
    } else {
      console.error("tried to open not in webtab", href)
    }
  }
}
