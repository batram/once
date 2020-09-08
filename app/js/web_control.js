module.exports = {
  open_in_webview,
  outline,
}

const { remote } = require("electron")
const { webContents } = remote

let webview = document.querySelector("#frams")
webview.addEventListener("did-stop-loading", loadstop)

const outline_api = "https://api.outline.com/v3/parse_article?source_url="
const data_outline_url = "data:text/html;charset=utf-8,"

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

webview.addEventListener("update-target-url", (event, input) => {
  console.log(event, input)
})

webview.addEventListener("new-window", async (e) => {
  //console.log("webview new-window", e.url)
})

function loadstop(e) {
  let url = webview.getURL()
  webview.openDevTools()
  webviewContents = webContents.fromId(webview.getWebContentsId())

  webviewContents.on("before-input-event", (event, input) => {
    //console.log(event, input)
  })

  webview.executeJavaScript(`document.addEventListener('mousedown', (e) => {
    console.log('mousedown', e.button)
  })`)

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
      color: #bcc2cd;
      background: #383a59;
    }
  }
`

  webview.insertCSS(css)

  if (url.startsWith(outline_api)) {
    webview.executeJavaScript("(" + outline_jshook.toString() + ")()")
  } else if (url.startsWith(data_outline_url)) {
    console.log("url outline", url)
  } else {
    urlfield.value = webview.getURL()
  }
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
  let url = webview.getURL()
  if (!url.startsWith(outline_api)) {
    outline(url)
  } else {
    url = unescape(url.replace(outline_api, ""))
    webview.loadURL(url)
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
    console.log("got webarchive", arch_url)
    url = arch_url
  }

  let f2 = await fetch(url)
  let resp2 = await f2.text()
  let dom_parser = new DOMParser()
  let doc = dom_parser.parseFromString(resp2, "text/html")

  var article = new Readability(doc).parse()
  let title = document.createElement("h1")
  title.innerText = article.title
  title.classList.add("outlined")
  console.log(article)
  webview.loadURL(
    data_outline_url +
      encodeURIComponent(title.outerHTML) +
      encodeURIComponent(article.content)
  )
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
