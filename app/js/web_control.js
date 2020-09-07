module.exports = {
  open_in_webview,
  outline,
}

const { remote } = require("electron")
const { webContents } = remote

let webview = document.querySelector("#frams")
webview.addEventListener("did-stop-loading", loadstop)

const outline_api = "https://api.outline.com/v3/parse_article?source_url="

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
  //console.log(event, input)
})

webview.addEventListener("new-window", async (e) => {
  //console.log("webview new-window", e.url)
})

function loadstop(e) {
  let url = webview.getURL()
  webviewContents = webContents.fromId(webview.getWebContentsId())

  webviewContents.on("before-input-event", (event, input) => {
    //console.log(event, input)
  })

  webview.executeJavaScript(`document.addEventListener('mousedown', (e) => {
    console.log('mousedown', e.button)
  })`)

  if (url.startsWith(outline_api)) {
    webview.executeJavaScript("(" + outline_jshook.toString() + ")()")
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

function outline(url) {
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
  document.body.innerHTML = "<h1>" + data.title + "</h1>"
  document.body.innerHTML += data.html
}
