module.exports = {
  key_handler,
  set,
  leave,
  enter,
  entered,
  left,
  init_listeners,
}

const { ipcRenderer } = require("electron")
const webtab = require("./webtab")

function init_listeners() {
  let webview = document.querySelector("#webview")
  if (webview) {
    webview.addEventListener("enter-html-full-screen", enter)
    webview.addEventListener("leave-html-full-screen", leave)
  }

  ipcRenderer.on("fullscreen", set)

  window.removeEventListener("keyup", key_handler)
  window.addEventListener("keyup", key_handler)

  window.addEventListener("beforeunload", (x) => {
    //Clean up listener
    ipcRenderer.removeListener("fullscreen", set)
    window.removeEventListener("keyup", key_handler)
  })
}

function set(e, fullscreen_value) {
  if (fullscreen_value) {
    entered(e)
  } else {
    left(e)
  }
}

function key_handler(e) {
  let is_fullscreen = document.body.classList.contains("fullscreen")

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
  console.debug("fullscreen enter", e)
  if (webtab.is_attached()) {
    webtab.send_to_parent("fullscreen", true)
  }

  document.body.classList.add("fullscreen")
  ipcRenderer.send("fullscreen", true)
  entered(e)
}

function entered(e) {
  console.debug("fullscreen entered", e)
  document.body.classList.add("fullscreen")
  let tab_cnt = document.querySelector("#right_panel")
  if (tab_cnt) {
    tab_cnt.style.minWidth = "100%"
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
  console.debug("fullscreen leave", e)
  if (webtab.is_attached()) {
    webtab.send_to_parent("fullscreen", false)
  }

  document.body.classList.remove("fullscreen")
  ipcRenderer.send("fullscreen", false)
}

function left(e) {
  console.log("leave full")

  try {
    document.body.classList.remove("fullscreen")
    let tab_cnt = document.querySelector("#right_panel")
    if (tab_cnt) {
      tab_cnt.style.minWidth = ""
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
