module.exports = {
  init,
  open_in_webview,
  create,
  send_to_main,
}

const { remote, ipcRenderer } = require("electron")
const { webContents, BrowserWindow, BrowserView } = remote
const presenters = require("../presenters")
const contextmenu = require("../view/contextmenu")
const fullscreen = require("../view/fullscreen")

function create(main_winid) {
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: true,
      webSecurity: false,
      webviewTag: true,
    },
  })

  let main_window = BrowserWindow.fromId(main_winid)
  main_window.setBrowserView(view)

  view.webContents.loadFile("app/webtab.html").then((x) => {
    view.webContents.send("set_main_id", main_winid)
  })

  return view
}

function init() {
  ipcRenderer.on("set_main_id", (event, data) => {
    window.main_id = data
    send_to_main("subscribe_to_change", { wc_id: current_wc.id })
  })

  presenters.init_in_webtab()

  ipcRenderer.on("data_change", (event, data) => {
    console.log("data_change", event, data)
    if (data.href == document.querySelector(".selected").dataset.href) {
      update_selected(data)
    }
  })

  ipcRenderer.on("open_in_webview", (event, href) => {
    open_in_webview(href)
  })
  ipcRenderer.on("update_selected", (event, story, colors) => {
    console.log("update_selected", story)
    update_selected(story, colors)
  })
  window.webview = document.querySelector("#webview")
  let current_wc = remote.getCurrentWebContents()

  current_wc.on("update-target-url", (event, url) => {
    send_to_main("update-target-url", url)
  })

  webview.addEventListener("console-message", (e) => {
    if (e.message == "mousedown 3") {
      if (webview.canGoBack()) {
        webview.goBack()
      }
    } else if (e.message == "mousedown 4") {
      if (webview.canGoForward()) {
        webview.goForward()
      }
    }
  })

  webview.addEventListener("enter-html-full-screen", (e) => {
    fullscreen.enter()
  })
  webview.addEventListener("leave-html-full-screen", (e) => {
    fullscreen.leave()
  })

  //webview.addEventListener("load-commit", loadcommit)
  webview.addEventListener("dom-ready", inject_css)
  webview.addEventListener("load-commit", load_once)
  webview.addEventListener("did-start-loading", load_started)
  webview.addEventListener("did-navigate", update_url)
  window.addEventListener("keyup", fullscreen.key_handler)

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

  pop_out_btn.onclick = (x) => {
    let cwin = remote.getCurrentWindow()
    let size = cwin.getSize()
    let poped_view = cwin.getBrowserView()

    let win_popup = new BrowserWindow({
      width: window.innerWidth,
      height: size[1],
    })
    win_popup.removeMenu()
    win_popup.loadURL(
      "data:text/html,<html style='width: 100%; height: 100%; background: black;'></html>"
    )

    win_popup.webContents.on("console-message", (e, x, m) => {
      if (!m.startsWith("[")) {
        return
      }
      let size = JSON.parse(m)

      poped_view.setBounds({
        x: 0,
        y: 0,
        width: size[0],
        height: size[1],
      })
    })

    win_popup.webContents.on("did-finish-load", (x) => {
      win_popup.webContents.executeJavaScript(
        `  
        console.log(JSON.stringify([window.innerWidth, window.innerHeight]));
        window.addEventListener("resize", (x) => {
          console.log(JSON.stringify([window.innerWidth, window.innerHeight]));
        });
        `
      )
    })

    let winid = cwin.id
    win_popup.setBrowserView(poped_view)
    cwin.removeBrowserView(poped_view)

    win_popup.on("close", (x) => {
      let main_browser_window = BrowserWindow.fromId(winid)
      if (main_browser_window && !main_browser_window.isDestroyed()) {
        main_browser_window.webContents.send("mark_selected", "about:gone")
      }
      poped_view.destroy()
    })
  }
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
  send_to_main("mark_selected", url)
  urlfield.value = url
}

function load_once() {
  //waiting for the webcontents of webview to be intialized
  webview = document.querySelector("#webview")
  webview.removeEventListener("load-commit", load_once)

  webviewContents = webContents.fromId(webview.getWebContentsId())

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

function load_started(e, x) {
  webviewContents = webContents.fromId(webview.getWebContentsId())

  webview.executeJavaScript(`document.addEventListener('mousedown', (e) => {
    console.log('mousedown', e.button)
  })`)

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
