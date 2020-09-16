module.exports = {
  init,
  open_in_webview,
  send_to_parent,
  is_attached,
}

const { ipcRenderer } = require("electron")
const presenters = require("../presenters")
const fullscreen = require("../view/fullscreen")

function init() {
  window.addEventListener("mouseup", handle_history)

  ipcRenderer.on("pop_out", (event, offset) => {
    pop_new_main(JSON.parse(offset))
  })

  ipcRenderer.on("attached", (event, data) => {
    console.log("attached", data)

    if (window.parent_id && window.parent_id != data) {
      send_to_parent("detaching")
      //let old_parent = BrowserWindow.fromId(parseInt(window.parent_id))
      //old_parent.removeBrowserView(cview)
    }

    window.parent_id = data
    window.tab_state = "attached"
    send_to_parent("subscribe_to_change")
  })

  ipcRenderer.on("detach", (event, data) => {
    window.tab_state = "detached"
  })

  presenters.init_in_webtab()

  handle_urlbar()

  ipcRenderer.on("closed", (event, data) => {
    console.debug("closed", event, data)
    window.tab_state = "closed"
    ipcRenderer.removeAllListeners()
    //detach and destroy
    ipcRenderer.send("end_me")
  })

  ipcRenderer.on("data_change", (event, data) => {
    console.debug("data_change", event, data)
    const story_list = require("../view/StoryList")
    let selected = story_list.get_by_href(data.href)
    if (selected) {
      update_selected(data)
    }
  })

  ipcRenderer.on("open_in_webview", (event, href) => {
    open_in_webview(href)
  })
  ipcRenderer.on("update_selected", (event, story, colors) => {
    console.debug("update_selected", story)
    update_selected(story, colors)
  })
  window.webview = document.querySelector("#webview")

  ipcRenderer.on("update-target-url", (event, url) => {
    send_to_parent("update-target-url", url)
  })

  webview.addEventListener("page-title-updated", (e) => {
    console.log("page-title-updated", e.title.toString())
    send_to_parent("page-title-updated", e.title.toString())
  })
  /*
  webview.addEventListener("destroyed", (e) => {
    console.log("webview destroyed", e)
    send_to_parent("mark_selected", "about:gone")
  })
*/
  webview.addEventListener("did-fail-load", (e) => {
    console.log("webview did-fail-load", e)
  })

  //webview.addEventListener("load-commit", loadcommit)
  webview.addEventListener("dom-ready", dom_ready)
  webview.addEventListener("load-commit", load_once)
  webview.addEventListener("did-start-loading", load_started)
  webview.addEventListener("did-navigate", update_url)
  webview.addEventListener("did-navigate-in-page", console.debug)

  webview.addEventListener("new-window", async (e) => {
    send_to_parent("open_in_new_tab", e.url)
    console.log("webview new-window", e.url)
  })

  reload_tab_btn.onclick = (x) => {
    webview.reload()
  }

  close_tab_btn.onclick = (x) => {
    webview.loadURL("about:blank")
    send_to_parent("page-title-updated", "about:blank")
    send_to_parent("detaching")
    ipcRenderer.send("end_me")
  }

  pop_out_btn.onauxclick = (x) => {
    pop_no_tabs()
  }
  pop_out_btn.onclick = (x) => {
    pop_new_main()
  }
}

function pop_no_tabs() {
  ipcRenderer.send("tab_me_out", { type: "notabs" })
}

function pop_new_main(offset = null) {
  console.log(offset)
  offset = JSON.parse(JSON.stringify(offset))
  ipcRenderer.send("tab_me_out", { type: "main", offset: offset })
}

function handle_urlbar() {
  let urlfield = document.querySelector("#urlfield")
  if (urlfield) {
    urlfield.addEventListener("focus", (e) => {
      urlfield.select()
    })

    urlfield.addEventListener("keyup", (e) => {
      if (e.key == "Enter") {
        if (urlfield.value == "") {
          urlfield.value = "about:blank"
        }
        open_in_webview(urlfield.value)
      }
    })
  }
}

function handle_history(e) {
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
}

function is_attached() {
  return window.tab_state == "attached" && window.parent_id
}

function update_selected(story, colors) {
  if (typeof colors == "string") {
    var style =
      document.querySelector(".tag_style") || document.createElement("style")
    style.classList.add("tag_style")
    style.type = "text/css"
    style.innerHTML = colors
    document.head.append(style)
  } else {
    console.log("what are these colors", colors)
  }

  selected_container.innerHTML = ""
  if (!story) {
    return
  }

  const { story_html } = require("../view/StoryListItem")

  let story_el = story_html(story, false)
  story_el.classList.add("selected")
  selected_container.append(story_el)
}

function update_url(e) {
  let url = e.url
  url = presenters.modify_url(url)
  if (is_attached()) {
    send_to_parent("mark_selected", url)
  } else {
    const story_list = require("../view/StoryList")
    let selected = story_list.get_by_href(url)
    if (!selected) {
      update_selected(null, null)
    }
  }

  send_to_parent("page-title-updated", webview.getTitle())

  urlfield.value = url
}

function load_once() {
  //waiting for the webcontents of webview to be intialized
  webview = document.querySelector("#webview")
  webview.removeEventListener("load-commit", load_once)

  webview.addEventListener("update-target-url", (e) => {
    console.log("update-target-url", e)
    send_to_parent("update-target-url", e.url)
  })
}

function dom_ready() {
  inject_css()
}

function load_started(e, x) {
  inject_css()
}

function inject_css() {
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

  webview.insertCSS(css)
}

function open_in_webview(href) {
  let webview = document.querySelector("#webview")
  if (webview) {
    webview.loadURL(href).catch((e) => {
      console.log("webview.loadURL error", e)
    })
    urlfield.value = href
  }
}

function send_to_parent(...args) {
  if (window.parent_id) {
    console.log(send_to_parent, ...args)
    ipcRenderer.sendTo(window.parent_id, ...args)
  }
}
