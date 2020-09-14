module.exports = {
  init_webtab,
  open_in_webview,
  attach_webtab,
  send_to_main,
  send_or_create,
}

const { remote, ipcRenderer } = require("electron")
const { webContents, BrowserWindow, BrowserView } = remote
const contextmenu = require("./view/contextmenu")
const filters = require("./data/filters")
const presenters = require("./presenters")
const fullscreen = require("./view/fullscreen")

let once = true

function attach_webtab() {
  ipcRenderer.on("mark_selected", mark_selected)
  ipcRenderer.on("update_story", update_story)
  ipcRenderer.on("show_filter", show_filter)
  ipcRenderer.on("add_filter", add_filter)
  ipcRenderer.on("update-target-url", contextmenu.show_target_url)

  window.addEventListener("beforeunload", (x) => {
    ipcRenderer.removeListener("mark_selected", mark_selected)
    ipcRenderer.removeListener("update_story", update_story)
    ipcRenderer.removeListener("show_filter", show_filter)
    ipcRenderer.removeListener("add_filter", add_filter)
    //TODO: remove presenter listeners
  })

  function show_filter(event, data) {
    filters.show_filter(data)
  }

  function add_filter(event, data) {
    filters.add_filter(data)
  }

  function update_story(event, data) {
    story_loader.story_map.update_story(data.href, data.path, data.value)
  }

  function mark_selected(event, href) {
    let colors = [...document.querySelectorAll(".tag_style")]
      .map((x) => {
        return x.innerText
      })
      .join("\n")

    const { mark_selected } = require("./view/StoryList")
    let story = mark_selected(null, href)

    if (href == "about:gone") {
      return
    }

    send_to_webtab("update_selected", story, colors)
    let select_el = document.querySelector(".selected")
    if (select_el) {
      select_el.addEventListener("data_change", function select_change(e) {
        if (select_el.classList.contains("selected")) {
          send_to_webtab("update_selected", e.detail.story, colors)
        } else {
          select_el.removeEventListener("data_change", select_change)
        }
      })
    }
  }

  create_webtab(content)
  let cwin = remote.getCurrentWindow()

  cwin.on("enter-full-screen", fullscreen.entered)
  cwin.on("leave-full-screen", fullscreen.left)

  window.addEventListener("beforeunload", (x) => {
    cwin.off("enter-full-screen", fullscreen.entered)
    cwin.off("leave-full-screen", fullscreen.left)

    //kill all attached browserviews
    if (cwin && cwin.getBrowserViews().length != 0) {
      cwin.getBrowserViews().forEach((v) => {
        cwin.removeBrowserView(v)
        v.destroy()
      })
    }
  })
}

function create_webtab(size_to_el) {
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: true,
      webSecurity: false,
      webviewTag: true,
    },
  })

  let cwin = remote.getCurrentWindow()
  cwin.setBrowserView(view)

  let cwin_id = cwin.id

  view.webContents.loadFile("app/webtab.html")
  view.webContents.on("dom-ready", (x) => {
    view.webContents.executeJavaScript(`
      document.body.dataset.main_winid = ${cwin_id}
    `)
  })

  if (size_to_el) {
    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        if ((entry.target.id = "content")) {
          let box = entry.contentRect
          let cwin = remote.getCurrentWindow()
          if (cwin) {
            let bw = cwin.getBrowserView()
            if (bw && !bw.isDestroyed()) {
              bw.setBounds({
                x: Math.floor(entry.target.offsetLeft),
                y: Math.floor(box.y),
                width: Math.floor(box.width),
                height: Math.floor(box.height),
              })
            }
          }
        }
      }
    })

    resizeObserver.observe(size_to_el)

    view.setBounds({
      x: Math.floor(size_to_el.offsetLeft),
      y: Math.floor(size_to_el.offsetTop),
      width: Math.floor(size_to_el.clientWidth),
      height: Math.floor(size_to_el.clientHeight),
    })
  }

  return view
}

function init_webtab() {
  presenters.init_in_webtab()

  ipcRenderer.on("open_in_webview", (event, href) => {
    open_in_webview(href)
  })
  ipcRenderer.on("update_selected", (event, story, colors) => {
    console.log("update_selected", story)
    update_selected(story, colors)
  })
  window.webview = document.querySelector("#webview")

  remote.getCurrentWebContents().on("update-target-url", (event, url) => {
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
  webview.addEventListener("did-stop-loading", inject_css)
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
    detach_browserview(cwin, poped_view)

    win_popup.on("close", (x) => {
      let main_browser_window = BrowserWindow.fromId(winid)
      if (main_browser_window && !main_browser_window.isDestroyed()) {
        main_browser_window.webContents.send("mark_selected", "about:gone")
      }
      poped_view.destroy()
    })
  }
}

function detach_browserview(win, view) {
  win.removeBrowserView(view)
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

  const { story_html } = require("./view/StoryListItem")

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

function load_started(e, x) {
  if (once) {
    once = false

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
  } else {
    send_or_create("open_in_webview", href)
  }
}

function send_to_webtab(...args) {
  let cwin = remote.getCurrentWindow()
  if (cwin && cwin.getBrowserView()) {
    let view = cwin.getBrowserView()
    if (view && !view.isDestroyed()) {
      //active found
      view.webContents.send(...args)
      return
    }
  }
}

function send_to_main(...args) {
  let main_winid = document.body.dataset.main_winid

  if (main_winid) {
    main_winid = parseInt(main_winid)
    let main_browser_window = BrowserWindow.fromId(main_winid)
    if (main_browser_window && !main_browser_window.isDestroyed()) {
      main_browser_window.send(...args)
    }
  }
}

function send_or_create(name, value) {
  let cwin = remote.getCurrentWindow()
  if (cwin && cwin.getBrowserView()) {
    let view = cwin.getBrowserView()
    if (view && !view.isDestroyed()) {
      //active found
      view.webContents.send(name, value)
      return
    }
  }
  //creating new webtab
  let view = create_webtab(content)
  view.webContents.once("did-finish-load", (x) => {
    view.webContents.send(name, value)
  })
}
