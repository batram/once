exports.open_in_webview = open_in_webview
let webview = document.querySelector("#frams")
webview.addEventListener("did-stop-loading", loadstart)

function loadstart(e) {
  console.log(e)
  urlfield.value = webview.getURL()
}

function open_in_webview(e) {
  e.preventDefault()
  e.stopPropagation()
  webview.loadURL(e.target.href)
  urlfield.value = e.target.href
}

reload_webview_btn.onclick = (x) => {
  webview.reload()
}

close_webview_btn.onclick = (x) => {
  webview.loadURL("about:blank")
}
