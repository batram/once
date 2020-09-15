module.exports = {
  key_handler,
  set,
  leave,
  enter,
  entered,
  left,
  init_listeners,
}

const { remote, ipcRenderer } = require("electron")
const { BrowserWindow } = remote
const webtab = require("./webtab")

function init_listeners() {
  let webview = document.querySelector("#webview")
  if (webview) {
    webview.addEventListener("enter-html-full-screen", enter)
    webview.addEventListener("leave-html-full-screen", leave)
  }

  ipcRenderer.on("fullscreen", set)
  window.addEventListener("beforeunload", (x) => {
    //Clean up listener
    ipcRenderer.removeListener("fullscreen", set)
  })

  window.addEventListener("keyup", key_handler)
}

function set(event, fullscreen) {
  if (fullscreen) {
    entered(event)
  } else {
    left(event)
  }
}

function key_handler(e) {
  let win = remote.getCurrentWindow() || BrowserWindow.getFocusedWindow()

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
  if (webtab.is_attached()) {
    webtab.send_to_main("fullscreen", true)
  }

  try {
    document.body.classList.add("fullscreen")
    let win = remote.getCurrentWindow() || BrowserWindow.getFocusedWindow()
    if (win) {
      let bw = win.getBrowserView()
      if (bw && !bw.isDestroyed()) {
        bw.webContents.send("fullscreen", true)
      }

      win.setFullScreen(true)
    }

    entered(e)
  } catch (e) {
    console.log("full error", e)
  }
}

function entered(e) {
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
          //document.body.requestFullscreen()
        }
      }        
      `,
      true
    )
  }
}

function leave(e) {
  if (webtab.is_attached()) {
    webtab.send_to_main("fullscreen", false)
  }

  document.body.classList.remove("fullscreen")
  let win = BrowserWindow.getFocusedWindow()
  if (win) {
    let bw = win.getBrowserView()
    if (bw && !bw.isDestroyed()) {
      bw.webContents.send("fullscreen", false)
    }

    win.setFullScreen(false)
    left(e)
  }
}

function left(e) {
  console.log("leave full")

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
