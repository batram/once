module.exports = {
  open_in_webview,
  outline,
}

const { remote, contentTracing } = require("electron")
const contextmenu = require("./contextmenu")
const { webContents } = remote

const outline_api = "https://api.outline.com/v3/parse_article?source_url="
const data_outline_url = "data:text/html;charset=utf-8,"

let webview = document.querySelector("#frams")

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
webview.addEventListener("enter-html-full-screen", go_fullscreen)
webview.addEventListener("leave-html-full-screen", leave_fullscreen)
//webview.addEventListener("load-commit", loadcommit)
webview.addEventListener("did-stop-loading", inject_css)
webview.addEventListener("did-start-loading", load_started)
webview.addEventListener("did-navigate", update_url)
window.addEventListener("keyup", key_fullscreen)

let win = remote.getCurrentWindow()

function key_fullscreen(e) {
  //console.log(e)
  if (e.key == "F11") {
    if (win.fullScreen) {
      leave_fullscreen()
      return true
    } else {
      go_fullscreen()
      return true
    }
  }
  if (e.key == "Escape") {
    if (win.fullScreen) {
      leave_fullscreen()
      return true
    }
  }
}

function go_fullscreen() {
  let bwin = remote.getCurrentWindow()
  document.body.classList.add("fullscreen")
  content.style.minWidth = "100%"
  bwin.setFullScreen(true)
  win.setFullScreen(true)
}

function leave_fullscreen() {
  let bwin = remote.getCurrentWindow()
  document.body.classList.remove("fullscreen")

  content.style.minWidth = ""
  webview.executeJavaScript(
    "if(document.fullscreenElement) document.exitFullscreen()"
  )
  bwin.setFullScreen(false)
  win.setFullScreen(false)
}

function show_target_url(event, url) {
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

let wc = remote.getCurrentWebContents()

wc.on("update-target-url", show_target_url)
wc.on("context-menu", contextmenu.inspect_menu)

window.addEventListener("beforeunload", (x) => {
  //Clean up listiners
  wc.removeListener("context-menu", contextmenu.inspect_menu)
  wc.removeListener("update-target-url", show_target_url)
})

webview.addEventListener("new-window", async (e) => {
  //console.log("webview new-window", e.url)
})

let once = true

function update_url(e) {
  let url = e.url
  outline_button_inactive()

  if (url.startsWith(outline_api)) {
    webview.executeJavaScript("(" + outline_jshook.toString() + ")()")
    outline_button_active()
  } else if (url.startsWith(data_outline_url)) {
    outline_button_active()
  } else {
    urlfield.value = url
  }

  let story_el = document.querySelector(`.story[data-href="${urlfield.value}"]`)

  stories.mark_selected(story_el, urlfield.value)
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

function open_in_webview(e, story) {
  e.preventDefault()
  e.stopPropagation()
  if (e.target.href) {
    webview.loadURL(e.target.href)
    urlfield.value = e.target.href
  } else if (story && story.href) {
    webview.loadURL(story.href)
    urlfield.value = story.href
  }
}

reload_webview_btn.onclick = (x) => {
  webview.reload()
}

close_webview_btn.onclick = (x) => {
  webview.loadURL("about:blank")
}

outline_webview_btn.onclick = (x) => {
  //TODO: track state in a different way
  if (outline_webview_btn.classList.contains("active")) {
    webview.loadURL(urlfield.value)
  } else {
    outline(urlfield.value)
  }
}

async function outline(url) {
  urlfield.value = url

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

  let title = document.createElement("h1")
  title.innerText = article.title
  title.classList.add("outlined")

  webview.loadURL(
    data_outline_url +
      encodeURIComponent(base.outerHTML) +
      encodeURIComponent(title.outerHTML) +
      encodeURIComponent(article.content)
  )
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
  webview.loadURL(outline_api + escape(url), options)
}

function outline_jshook() {
  let data = JSON.parse(document.body.innerText).data
  let title = document.createElement("h1")
  title.innerText = data.title
  document.body.innerHTML = title.outerHTML
  document.body.innerHTML += data.html
}
