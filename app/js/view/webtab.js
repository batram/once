module.exports = {
  init,
  open_in_webview,
  create,
  send_to_main,
  is_attached,
}

const { remote, ipcRenderer } = require("electron")
const { BrowserWindow, BrowserView } = remote
const presenters = require("../presenters")
const contextmenu = require("../view/contextmenu")
const fullscreen = require("../view/fullscreen")

function create(main_id) {
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: true,
      webSecurity: false,
      webviewTag: true,
    },
  })

  let main_window = BrowserWindow.fromId(main_id)
  main_window.setBrowserView(view)

  view.webContents.loadFile("app/webtab.html").then((x) => {
    view.webContents.send("set_main_id", main_id)
  })

  return view
}

function init() {
  window.use_console_catch_mouse = true

  window.addEventListener("mouseup", handle_history)

  ipcRenderer.on("set_main_id", (event, data) => {
    window.main_id = data
    window.tab_state = "attached"
    send_to_main("subscribe_to_change", { wc_id: current_wc.id })
  })

  ipcRenderer.on("detach", (event, data) => {
    window.tab_state = "detached"
  })

  presenters.init_in_webtab()

  handle_urlbar()

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
  let current_wc = remote.getCurrentWebContents()

  current_wc.on("update-target-url", (event, url) => {
    send_to_main("update-target-url", url)
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
    //TODO: open in own popup
    console.log("webview new-window", e.url)
  })

  reload_webview_btn.onclick = (x) => {
    webview.reload()
  }

  close_webview_btn.onclick = (x) => {
    webview.loadURL("about:blank")
  }

  pop_out_btn.onclick = pop_out
}

function pop_out() {
  pop_out_btn.style.display = "none"
  if (window.tab_state == "detached") {
    return
  }

  let cwin = remote.getCurrentWindow()
  let size = cwin.getSize()
  let poped_view = cwin.getBrowserView()
  let view_bound = poped_view.getBounds()
  let parent_pos = cwin.getPosition()

  let win_popup = new BrowserWindow({
    x: parent_pos[0] + view_bound.x,
    y: parent_pos[1],
    width: view_bound.width,
    height: size[1],
    autoHideMenuBar: true,
    icon: remote.getGlobal("icon_path"),
  })

  function follow_resize() {
    let box = win_popup.getContentBounds()
    poped_view.setBounds({
      x: 0,
      y: 0,
      width: box.width,
      height: box.height,
    })
  }
  follow_resize()
  win_popup.on("resize", follow_resize)

  let winid = cwin.id
  win_popup.setBrowserView(poped_view)
  cwin.removeBrowserView(poped_view)

  window.tab_state = "detached"

  win_popup.on("close", (x) => {
    let main_browser_window = BrowserWindow.fromId(winid)
    if (main_browser_window && !main_browser_window.isDestroyed()) {
      main_browser_window.webContents.send("mark_selected", "about:gone")
    }
    poped_view.destroy()
  })
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
  return window.tab_state == "attached" && window.main_id
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
    send_to_main("mark_selected", url)
  } else {
    const story_list = require("../view/StoryList")
    let selected = story_list.get_by_href(url)
    if (!selected) {
      update_selected(null, null)
    }
  }
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
    send_to_main("update-target-url", url)
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

function send_to_main(...args) {
  let main_winid = window.main_id

  if (main_winid) {
    main_winid = parseInt(main_winid)
    let main_browser_window = BrowserWindow.fromId(main_winid)
    if (main_browser_window && !main_browser_window.isDestroyed()) {
      ipcRenderer.sendTo(main_winid, ...args)
    }
  } else {
    console.log("no main window id set", ...args)
  }
}
