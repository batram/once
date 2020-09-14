module.exports = {
  key_handler,
  leave,
  enter,
  entered,
  left,
}

const { remote } = require("electron")
const { BrowserWindow } = remote

function key_handler(e) {
  let win = BrowserWindow.getFocusedWindow()

  let is_fullscreen =
    (win && win.fullScreen) || document.body.classList.contains("fullscreen")

  if (e.key == "F11") {
    if (is_fullscreen) {
      leave()
      return true
    } else {
      enter()
      return true
    }
  }
  if (e.key == "Escape") {
    if (is_fullscreen) {
      leave()
      return true
    }
  }
}

function enter(e) {
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

    entered()
  } catch (e) {
    console.log("full error", e)
  }
}

function entered() {
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

function leave() {
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
    left()
  }
}

function left() {
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
