module.exports = {
  init_webtab,
  init_menu,
  open_in_webview,
  outline,
  attach_webtab,
}

const { remote, ipcRenderer } = require("electron")
const contextmenu = require("./contextmenu")
const { Story } = require("./data/Story")
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

  wc.on("enter-html-full-screen", gone_fullscreen)
  wc.on("leave-html-full-screen", leave_fullscreen)
  window.addEventListener("keyup", key_fullscreen)
}

function attach_webtab() {
  const { ipcMain } = remote

  ipcMain.on("mark_selected", mark_selected)
  ipcMain.on("update_story", update_story)

  function update_story(event, data) {
    console.log("ipcMain update_story", event, data)
    story_loader.story_map.update_story(data.href, data.path, data.value)
  }

  function mark_selected(event, href) {
    let colors = [...document.querySelectorAll(".tag_style")]
      .map((x) => {
        return x.innerText
      })
      .join("\n")
    let story = stories.mark_selected(null, href)
    event.sender.send("update_selected", story, colors)
    let select_el = document.querySelector(".selected")
    if (select_el) {
      select_el.addEventListener("change", function select_change(e) {
        if (select_el.classList.contains("selected")) {
          event.sender.send("update_selected", e.detail.story, story, colors)
        } else {
          select_el.removeEventListener("change", select_change)
        }
      })
    }
  }

  window.addEventListener("beforeunload", (x) => {
    //Clean up listiners
    ipcMain.removeListener("mark_selected", mark_selected)
    ipcMain.removeListener("update_story", mark_selected)
  })

  let view = create_webtab(content)
  let cwin = remote.getCurrentWindow()

  //TODO: which one do we really need?
  view.webContents.on("enter-html-full-screen", go_fullscreen)
  view.webContents.on("leave-html-full-screen", left_fullscreen)
  cwin.webContents.on("enter-html-full-screen", gone_fullscreen)
  cwin.webContents.on("leave-html-full-screen", left_fullscreen)
  cwin.on("enter-full-screen", gone_fullscreen)
  cwin.on("leave-full-screen", left_fullscreen)
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
  view.webContents.loadFile("app/webtab.html")
  window.activeWebtab = view

  const resizeObserver = new ResizeObserver((entries) => {
    for (let entry of entries) {
      if (
        content == entry.target &&
        BrowserWindow.fromBrowserView(view) == cwin
      ) {
        let box = entry.contentRect
        view.setBounds({
          x: entry.target.offsetLeft,
          y: box.y,
          width: Math.floor(box.width),
          height: Math.floor(box.height),
        })
      }
    }
  })

  resizeObserver.observe(size_to_el)

  return view
}

function init_webtab() {
  let win = remote.getCurrentWindow()
  ipcRenderer.on("open_in_webview", (event, href) => {
    open_in_webview(href)
  })
  ipcRenderer.on("outline", (event, href) => {
    console.log("outline", href)
    outline(href)
  })
  ipcRenderer.on("update_selected", (event, story, colors) => {
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
    console.log("webtab fullscreen")
    gone_fullscreen()
  })
  webview.addEventListener("leave-html-full-screen", left_fullscreen)
  //webview.addEventListener("load-commit", loadcommit)
  webview.addEventListener("did-stop-loading", inject_css)
  webview.addEventListener("did-start-loading", load_started)
  webview.addEventListener("did-navigate", update_url)
  window.addEventListener("keyup", key_fullscreen)

  webview.addEventListener("new-window", async (e) => {
    //console.log("webview new-window", e.url)
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
    let csize = cwin.getContentSize()

    let win_popup = new BrowserWindow({
      width: window.innerWidth,
      height: size[1],
    })
    win_popup.removeMenu()
    win_popup.loadURL(
      "data:text/html,<html style='width: 100%; height: 100%; background: black;'></html>"
    )
    win_popup.webContents.once("did-finish-load", (x) => {
      win_popup.webContents.on("console-message", (e, x, m) => {
        if (!m.startsWith("[")) {
          return
        }
        let size = JSON.parse(m)
        bw.setBounds({
          x: 0,
          y: 0,
          width: size[0],
          height: size[1],
        })
      })
      win_popup.webContents.executeJavaScript(
        `  
        console.log(JSON.stringify([window.innerWidth, window.innerHeight]));
        window.addEventListener("resize", (x) => {
          console.log(JSON.stringify([window.innerWidth, window.innerHeight]));
        });
        `
      )
    })
    let bw = cwin.getBrowserView()
    win_popup.setBrowserView(bw)
    cwin.removeBrowserView(bw)

    win_popup.on("close", (x) => {
      bw.destroy()
    })
  }
}

function key_fullscreen(e) {
  console.log("key_fullscreen", e)
  let win = remote.getCurrentWindow()
  //console.log(e)
  if (e.key == "F11") {
    if (win && win.fullScreen) {
      leave_fullscreen()
      return true
    } else {
      go_fullscreen()
      return true
    }
  }
  if (e.key == "Escape") {
    if (win && win.fullScreen) {
      leave_fullscreen()
      return true
    }
  }
}

function go_fullscreen() {
  document.body.classList.add("fullscreen")
  let win = remote.getCurrentWindow()
  if (win.getBrowserViews().length != 0) {
    win.getBrowserViews().forEach((v) => {
      v.webContents.executeJavaScript(
        "document.body.classList.add('fullscreen')"
      )
    })
  }
  win.setFullScreen(true)
}

function gone_fullscreen() {
  document.body.classList.add("fullscreen")
  if (document.querySelector("#content")) {
    content.style.minWidth = "100%"
  }
}

function leave_fullscreen() {
  document.body.classList.remove("fullscreen")
  let win = remote.getCurrentWindow()
  if (win.getBrowserViews().length != 0) {
    win.getBrowserViews().forEach((v) => {
      v.webContents.executeJavaScript(
        "document.body.classList.remove('fullscreen')"
      )
    })
  }
  win.setFullScreen(false)
}

function left_fullscreen() {
  document.body.classList.remove("fullscreen")
  if (document.querySelector("#content")) {
    content.style.minWidth = ""
  }
  if (document.querySelector("webview")) {
    webview.executeJavaScript(
      "if(document.fullscreenElement) document.exitFullscreen()"
    )
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
  var style =
    document.querySelector(".tag_style") || document.createElement("style")
  style.classList.add("tag_style")
  style.type = "text/css"
  style.innerHTML = colors
  document.head.append(style)

  selected_container.innerHTML = ""
  if (!story) {
    return
  }

  console.log(story instanceof Story)
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

  ipcRenderer.send("mark_selected", urlfield.value)

  //let story_el = document.querySelector(`.story[data-href="${urlfield.value}"]`)
  //stories.mark_selected(story_el, urlfield.value)
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
      //console.log(event, input)
    })
  }

  webviewContents = webContents.fromId(webview.getWebContentsId())

  webview.executeJavaScript(`document.addEventListener('mousedown', (e) => {
    console.log('mousedown', e.button)
  })`)

  darken_hn()

  inject_css()
}

function darken_hn() {
  if (urlfield.value.startsWith("https://news.ycombinator.com/")) {
    let css = `.c00, .c00 a:link { 
      color: #bcc2cd !important; 
    }`
    webview.insertCSS(css)

    webview.executeJavaScript(`
      if(matchMedia("(prefers-color-scheme: dark)").matches)
        hnmain.setAttribute("bgcolor", "#44475a")
    `)
  }
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

function send_or_create(name, value) {
  if (window.activeWebtab && !window.activeWebtab.isDestroyed()) {
    //active found
    activeWebtab.webContents.send(name, value)
  } else {
    //creating new webtab
    create_webtab(content)
    activeWebtab.webContents.once("did-finish-load", (x) => {
      activeWebtab.webContents.send(name, value)
    })
  }
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
