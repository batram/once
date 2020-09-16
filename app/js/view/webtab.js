module.exports = {
  init,
  open_in_webview,
  create,
  is_attached,
}

const { remote, ipcRenderer } = require("electron")
const { BrowserWindow, BrowserView } = remote
const presenters = require("../presenters")
const contextmenu = require("../view/contextmenu")
const fullscreen = require("../view/fullscreen")

function create(parent_id) {
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: true,
      webSecurity: false,
      webviewTag: true,
    },
  })

  view.webContents.loadFile("app/webtab.html").then((x) => {
    view.webContents.send("attached", parent_id)
  })

  return view
}

function tab_move_handler(el) {
  let offset = 0

  function swivle(e) {
    let win_popup = get_parent_win()
    console.log("swivle", e)
    let new_pos_x = offset + e.x
    if (is_attached()) {
      e.preventDefault()
      if (new_pos_x < 0) {
        pop_out()
      }
      el.style.marginLeft = new_pos_x + "px"
    } else if (win_popup) {
      el.setAttribute("style", "-webkit-app-region: drag")
      /*
      let pos = win_popup.getPosition()
      let x = pos[0] + e.movementX
      let y = pos[1] + e.movementY
      win_popup.setPosition(x, y)*/
    }
  }

  function deswivle() {
    document.body.style.cursor = ""
    document.removeEventListener("mousemove", swivle)
    document.removeEventListener("mouseup", deswivle)
  }

  document.addEventListener("mouseout", (e) => {
    console.log("mouseout")
    e.preventDefault()
    document.body.style.cursor = ""
    document.removeEventListener("mousemove", swivle)
    document.removeEventListener("mouseup", deswivle)
  })

  el.addEventListener("mousedown", (e) => {
    offset = -e.x
    console.log("mousedown tab")
    e.preventDefault()
    document.body.style.cursor = "move"
    document.addEventListener("mousemove", swivle)
    document.addEventListener("mouseup", deswivle)
  })
}

function get_parent_win() {
  if (window.parent_id && parseInt(window.parent_id)) {
    let paren = BrowserWindow.fromBrowserView(parseInt(window.parent_id))
    return BrowserWindow.fromId(parseInt(window.parent_id))
  }
}

function init() {
  window.use_console_catch_mouse = true
  let cwin = remote.getCurrentWindow()
  let cview = cwin.getBrowserView()

  let current_wc = remote.getCurrentWebContents()

  window.addEventListener("mouseup", handle_history)
  ipcRenderer.on("pop_out", (event, offset) => {
    pop_new_main(offset)
  })
  ipcRenderer.on("attached", (event, data) => {
    console.log("attached", data)
    let parent_window = BrowserWindow.fromId(parseInt(data))
    if (window.parent_id && window.parent_id != parent_window.id) {
      send_to_parent("detaching")
      let old_parent = BrowserWindow.fromId(parseInt(window.parent_id))
      old_parent.removeBrowserView(cview)
    }
    window.parent_id = data
    window.parent_wc_id = parent_window.webContents.id
    window.tab_state = "attached"
    send_to_parent("subscribe_to_change", { wc_id: current_wc.id })
  })

  ipcRenderer.on("detach", (event, data) => {
    window.tab_state = "detached"
  })

  presenters.init_in_webtab()

  handle_urlbar()
  ipcRenderer.on("size_changed", size_changed)

  function size_changed(event, data) {
    console.log("size_changed", event, data)
    cview.setBounds(data)
  }

  ipcRenderer.on("closed", (event, data) => {
    console.debug("closed", event, data)
    window.tab_state = "closed"
    ipcRenderer.removeAllListeners()
    let parent = get_parent_win()
    if (parent) {
      parent.removeBrowserView(cview)
    }
    //current_wc.destroy()
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

  current_wc.on("update-target-url", (event, url) => {
    send_to_parent("update-target-url", url)
  })

  webview.addEventListener("page-title-updated", (e) => {
    console.log("page-title-updated", e.title.toString())
    send_to_parent("page-title-updated", e.title.toString())
  })
  webview.addEventListener("destroyed", (e) => {
    console.log("webview destroyed", e)
    send_to_parent("mark_selected", "about:gone")
  })

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

  reload_webview_btn.onclick = (x) => {
    webview.reload()
  }

  close_webview_btn.onclick = (x) => {
    //TODO: maybe just close the tag
    send_to_parent("page-title-updated", "about:blank")
    webview.loadURL("about:blank")
  }

  pop_out_btn.onauxclick = pop_no_tabs
  pop_out_btn.onclick = pop_new_main
}

function new_relative_win(url, full_resize = false, initial_offset = null) {
  let cwin = BrowserWindow.fromId(window.parent_id)
  let size = cwin.getSize()
  let poped_view = cwin.getBrowserView()
  let view_bound = poped_view.getBounds()
  let parent_pos = cwin.getPosition()
  cwin.removeBrowserView(poped_view)

  let initial_x = parent_pos[0] + view_bound.x
  let initial_y = parent_pos[1]

  if (initial_offset != null && initial_offset.length == 2) {
    initial_x += initial_offset[0]
    initial_y += initial_offset[1]
  }

  let win_popup = new BrowserWindow({
    x: initial_x,
    y: initial_y,
    width: view_bound.width,
    height: size[1],
    autoHideMenuBar: true,
    icon: remote.getGlobal("icon_path"),
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: true,
      webSecurity: false,
      webviewTag: true,
    },
  })

  win_popup.setBrowserView(poped_view)
  window.tab_state = "detached"
  window.parent_id = win_popup.id

  if (full_resize) {
    function follow_resize() {
      if (!is_attached()) {
        let box = win_popup.getContentBounds()
        console.log("follow_resize", box)
        poped_view.setBounds({
          x: 0,
          y: 0,
          width: box.width,
          height: box.height,
        })
      }
    }
    win_popup.on("resize", follow_resize)
    win_popup.setSize(view_bound.width, size[1] + 1)
  }

  win_popup.loadFile(url)
  return win_popup
}

function pop_new_main(offset = null) {
  send_to_parent("detaching")
  let win_popup = new_relative_win("app/main_window.html", false, offset)
  return win_popup
}

function pop_no_tabs() {
  pop_out_btn.style.display = "none"
  if (window.tab_state == "detached") {
    return
  }

  send_to_parent("detaching")
  let win_popup = new_relative_win("", true)
  return win_popup
}

function destory_on_close() {
  /*
  win_popup.off("close", destory_on_close)
  if (is_attached()) {
    return
  }
  let main_browser_window = BrowserWindow.fromId(winid)
  if (main_browser_window && !main_browser_window.isDestroyed()) {
    main_browser_window.webContents.send("mark_selected", "about:gone")
  }
  poped_view.destroy()*/
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
  let webviewContents = remote.webContents.fromId(webview.getWebContentsId())

  try {
    if (!webviewContents.debugger.isAttached()) {
      webviewContents.debugger.attach()
    }
  } catch (e) {
    console.log(e)
  }

  webviewContents.debugger.on("message", function (event, method, params) {
    console.debug(event, method, params)
    if (method == "Runtime.bindingCalled") {
      let name = params.name
      let payload = params.payload

      if (name == "mhook") {
        if (payload == "3") {
          webview.goBack()
        } else if (payload == "4") {
          webview.goForward()
        }
      }
    }
  })
  webviewContents.debugger.sendCommand("Runtime.addBinding", {
    name: "mhook",
  })

  webviewContents.debugger.sendCommand("Runtime.enable")
  webviewContents.debugger.sendCommand("Page.enable")
  webviewContents.debugger.sendCommand("Page.setLifecycleEventsEnabled", {
    enabled: true,
  })

  webviewContents.debugger.sendCommand(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `
      {
        let ß = window.mhook
        window.addEventListener("mousedown", (e) => {
          ß(e.button.toString())
        })
      }
    
      delete window.mhook
      `,
    }
  )

  webviewContents.on("context-menu", contextmenu.inspect_menu)
  webviewContents.on("update-target-url", (event, url) => {
    send_to_parent("update-target-url", url)
  })

  webviewContents.on("before-input-event", (event, input) => {
    if (input.type == "keyUp") {
      let e = { key: input.key }
      if (fullscreen.key_handler(e)) {
        event.preventDefault()
      }
    }
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
  if (window.parent_wc_id) {
    ipcRenderer.sendTo(window.parent_wc_id, ...args)
  }
}
