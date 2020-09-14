module.exports = {
  init_webtab,
  init_menu,
  open_in_webview,
  outline,
  attach_webtab,
  send_to_main,
}

const { remote, ipcRenderer } = require("electron")
const contextmenu = require("./contextmenu")
const filters = require("./filters")
const { webContents, BrowserWindow, BrowserView } = remote

const outline_api = "https://api.outline.com/v3/parse_article?source_url="
const data_outline_url = "data:text/html;charset=utf-8,"

let once = true

function init_menu() {
  let wc = remote.getCurrentWebContents()

  wc.on("update-target-url", show_target_url)
  wc.on("context-menu", contextmenu.inspect_menu)

  window.addEventListener("beforeunload", (x) => {
    //Clean up listiners
    wc.removeListener("context-menu", contextmenu.inspect_menu)
    wc.removeListener("update-target-url", show_target_url)
  })

  window.addEventListener("keyup", key_fullscreen)
}

function attach_webtab() {
  ipcRenderer.on("mark_selected", mark_selected)
  ipcRenderer.on("update_story", update_story)
  ipcRenderer.on("show_filter", show_filter)
  ipcRenderer.on("add_filter", add_filter)

  window.addEventListener("beforeunload", (x) => {
    ipcRenderer.removeListener("mark_selected", mark_selected)
    ipcRenderer.removeListener("update_story", update_story)
    ipcRenderer.removeListener("show_filter", show_filter)
    ipcRenderer.removeListener("add_filter", add_filter)
  })

  remote.getCurrentWebContents().on("ipc-message", console.log)

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

  cwin.on("enter-full-screen", gone_fullscreen)
  cwin.on("leave-full-screen", left_fullscreen)

  window.addEventListener("beforeunload", (x) => {
    cwin.removeListener("enter-full-screen", gone_fullscreen)
    cwin.removeListener("leave-full-screen", left_fullscreen)

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
  ipcRenderer.on("open_in_webview", (event, href) => {
    open_in_webview(href)
  })
  ipcRenderer.on("outline", (event, href) => {
    console.log("outline", href)
    outline(href)
  })
  ipcRenderer.on("update_selected", (event, story, colors) => {
    console.log("update_selected", story)
    update_selected(story, colors)
  })
  window.webview = document.querySelector("#webview")

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
    go_fullscreen()
  })
  webview.addEventListener("leave-html-full-screen", (e) => {
    leave_fullscreen()
  })
  //webview.addEventListener("load-commit", loadcommit)
  webview.addEventListener("did-stop-loading", inject_css)
  webview.addEventListener("did-start-loading", load_started)
  webview.addEventListener("did-navigate", update_url)
  window.addEventListener("keyup", key_fullscreen)

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

  outline_webview_btn.onclick = (x) => {
    //TODO: track state in a different way
    if (outline_webview_btn.classList.contains("active")) {
      webview.loadURL(urlfield.value).catch((e) => {
        console.log("webview.loadURL error", e)
      })
    } else {
      outline(urlfield.value)
    }
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

function key_fullscreen(e) {
  let win = BrowserWindow.getFocusedWindow()

  let is_fullscreen =
    (win && win.fullScreen) || document.body.classList.contains("fullscreen")

  if (e.key == "F11") {
    if (is_fullscreen) {
      leave_fullscreen()
      return true
    } else {
      go_fullscreen()
      return true
    }
  }
  if (e.key == "Escape") {
    if (is_fullscreen) {
      leave_fullscreen()
      return true
    }
  }
}

function go_fullscreen(e) {
  try {
    document.body.classList.add("fullscreen")
    let win = BrowserWindow.getFocusedWindow()
    if (win) {
      let bw = win.getBrowserView()
      if (bw && !bw.isDestroyed()) {
        bw.webContents
          .executeJavaScript("document.body.classList.add('fullscreen')")
          .catch(console.log)
      }

      win.setFullScreen(true)
    }

    gone_fullscreen()
  } catch (e) {
    console.log("full error", e)
  }
}

function gone_fullscreen() {
  document.body.classList.add("fullscreen")
  if (document.querySelector("#content")) {
    document.querySelector("#content").style.minWidth = "100%"
  }
  let webview = document.querySelector("#webview")
  if (webview) {
    webview.executeJavaScript(
      `
      if(!document.fullscreenElement){
        if(document.querySelector(".html5-video-player")){
          document.querySelector(".html5-video-player").requestFullscreen()
        } else {
          document.body.requestFullscreen()
        }
      }        
      `,
      true
    )
  }
}

function leave_fullscreen() {
  document.body.classList.remove("fullscreen")
  let win = BrowserWindow.getFocusedWindow()
  if (win) {
    let bw = win.getBrowserView()
    if (bw && !bw.isDestroyed()) {
      bw.webContents
        .executeJavaScript("document.body.classList.remove('fullscreen')")
        .catch(console.log)
    }

    win.setFullScreen(false)
    left_fullscreen()
  }
}

function left_fullscreen() {
  try {
    document.body.classList.remove("fullscreen")
    if (document.querySelector("#content")) {
      content.style.minWidth = ""
    }
    let webview = document.querySelector("webview")
    if (webview) {
      webview
        .executeJavaScript(
          `
        if(document.fullscreenElement){
          document.exitFullscreen().catch( e => {console.log(e)})
        }        
        `
        )
        .catch(console.log)
    }
  } catch (e) {
    console.log("left full error", e)
  }
}

function show_target_url(event, url) {
  if (!document.querySelector("#url_target")) {
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

  let story_el = story_html(story, true)
  story_el.classList.add("selected")
  selected_container.append(story_el)
}

function update_url(e) {
  let url = e.url
  outline_button_inactive()

  if (url.startsWith(outline_api)) {
    webview.executeJavaScript("(" + outline_jshook.toString() + ")()")
    outline_button_active()
  } else if (url.startsWith(data_outline_url)) {
    if (url.split("#").length > 1) {
      urlfield.value = decodeURIComponent(url.split("#")[1])
    }
    outline_button_active()
  } else {
    urlfield.value = url
  }

  send_to_main("mark_selected", urlfield.value)
}

function load_started(e, x) {
  if (once) {
    once = false

    webviewContents = webContents.fromId(webview.getWebContentsId())

    webviewContents.on("context-menu", contextmenu.inspect_menu)
    webviewContents.on("update-target-url", show_target_url)
    webviewContents.on("before-input-event", (event, input) => {
      if (input.type == "keyUp") {
        let e = { key: input.key }
        if (key_fullscreen(e)) {
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

function outline_button_active() {
  outline_webview_btn.classList.add("active")
}

function outline_button_inactive() {
  outline_webview_btn.classList.remove("active")
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

async function outline(url) {
  let urlfield = document.querySelector("#urlfield")
  if (urlfield == undefined) {
    send_or_create("outline", url)
    return
  }
  urlfield.value = url
  let og_url = url

  let f = await fetch("https://archive.org/wayback/available?url=" + url)
  let resp = await f.json()
  if (
    resp.hasOwnProperty("archived_snapshots") &&
    resp.archived_snapshots.hasOwnProperty("closest") &&
    resp.archived_snapshots.closest.available
  ) {
    let arch_url = new URL(resp.archived_snapshots.closest.url)
    arch_url.protocol = "https:"
    url = arch_url
  }

  let f2 = await fetch(url)
  let resp2 = await f2.text()
  let dom_parser = new DOMParser()
  let doc = dom_parser.parseFromString(resp2, "text/html")

  let base = document.createElement("base")
  base.setAttribute("href", url)

  if (
    doc.querySelector("base") &&
    doc.querySelector("base").hasAttribute("href")
  ) {
    console.log("base already there", doc.querySelector("base"))
  } else {
    doc.head.append(base)
  }

  doc.querySelectorAll("a, img").forEach((e) => {
    if (e.hasAttribute("href") && e.getAttribute("href") != e.href) {
      e.setAttribute("href", e.href)
    }
    if (e.hasAttribute("src") && e.getAttribute("src") != e.src) {
      e.setAttribute("src", e.src)
    }
  })

  var article = new Readability(doc).parse()
  if (!article) {
    article = {}
  }
  if (!article.content) {
    article.title = ""
  }
  if (!article.content) {
    article.content = "Readability fail"
  }

  let title = document.createElement("h1")
  title.innerText = article.title
  title.classList.add("outlined")

  webview
    .loadURL(
      data_outline_url +
        encodeURIComponent(base.outerHTML) +
        encodeURIComponent(title.outerHTML) +
        encodeURIComponent(article.content) +
        "#" +
        encodeURIComponent(og_url)
    )
    .catch((e) => {
      console.log("webview.loadURL error", e)
    })
}

function fix_rel(el, base_url) {
  if (el.hasAttribute("src") && el.getAttribute("src") != el.src) {
    if (el.getAttribute("src").startsWith("/")) {
      console.log(el.getAttribute("src"), "!=", el.src, el)
      /*
      console.log("fix_rel", el, el.src, el.protocol)
      el.protocol = base_url.protocol
      el.host = base_url.host
      console.log("fix_rel", el, el.href, el.protocol)  
      */
    }
  }
  if (el.hasAttribute("href") && el.getAttribute("href") != el.href) {
    if (el.getAttribute("href").startsWith("/")) {
      console.log(el.getAttribute("href"), "!=", el.href)
      console.log("fix_rel", el, el.href, el.protocol)
      el.protocol = base_url.protocol
      el.host = base_url.host
      console.log("fix_rel", el, el.href, el.protocol)
    }
  }
}

function outline_fallback(url) {
  urlfield.value = url
  let options = {
    httpReferrer: "https://outline.com/",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.125 Safari/537.36",
  }
  webview.loadURL(outline_api + escape(url), options).catch((e) => {
    console.log("webview.loadURL error", e)
  })
}

function outline_jshook() {
  let data = JSON.parse(document.body.innerText).data
  let title = document.createElement("h1")
  title.innerText = data.title
  document.body.innerHTML = title.outerHTML
  document.body.innerHTML += data.html
}
