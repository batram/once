import { ipcRenderer, WebContents, BrowserWindow } from "electron"
import { ipcMain } from "electron"

export {
  key_handler,
  set,
  leave,
  enter,
  entered,
  left,
  render_listeners,
  main_listener,
  webview_key_catcher,
}

function main_listener(): void {
  ipcMain.on("change_fullscreen", (event, value) => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) {
      const bw = win.getBrowserView()
      if (bw && !bw.isDestroyed()) {
        bw.webContents.send("fullscreen_changed", value)
      }
      win.webContents.send("fullscreen_changed", value)
      win.setFullScreen(value)
    }
  })
}

function webview_key_catcher(webContents: WebContents): void {
  webContents.on("did-attach-webview", (event, guest_webContents) => {
    guest_webContents.on("before-input-event", (event, input) => {
      const focused = BrowserWindow.getFocusedWindow()

      if (input.code == "F11") {
        console.log(
          "webview_key_catcher F11",
          guest_webContents.id,
          webContents.id
        )

        focused.webContents.sendInputEvent({
          keyCode: "F11",
          type: input.type == "keyUp" ? "keyUp" : "keyDown",
        })
      }

      if (input.key == "Escape") {
        focused.webContents.sendInputEvent({
          keyCode: "Escape",
          type: input.type == "keyUp" ? "keyUp" : "keyDown",
        })
      }
    })
  })
}

function render_listeners(): void {
  const webview = document.querySelector("#webview")
  if (webview) {
    webview.addEventListener("enter-html-full-screen", enter)
    webview.addEventListener("leave-html-full-screen", leave)
  }

  ipcRenderer.on("fullscreen_changed", set)

  window.removeEventListener("keyup", key_handler)
  window.addEventListener("keyup", key_handler)
}

function set(_: unknown, fullscreen_value: boolean): void {
  if (fullscreen_value) {
    entered()
  } else {
    left()
  }
}

function key_handler(e: KeyboardEvent): boolean {
  const is_fullscreen = document.body.classList.contains("fullscreen")

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

function enter(): void {
  console.debug("fullscreen enter")
  document.body.classList.add("fullscreen")
  ipcRenderer.send("change_fullscreen", true)
  entered()
}

function entered(): void {
  document.body.classList.add("fullscreen")
  const right_panel = document.querySelector<HTMLElement>("#right_panel")
  if (right_panel) {
    right_panel.style.minWidth = "100%"
  }

  const webview = document.querySelector<Electron.WebviewTag>("#webview")
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

function leave(): void {
  document.body.classList.remove("fullscreen")
  ipcRenderer.send("change_fullscreen", false)
}

function left(): void {
  console.debug("leave full")

  try {
    document.body.classList.remove("fullscreen")
    const right_panel = document.querySelector<HTMLElement>("#right_panel")
    if (right_panel) {
      right_panel.style.minWidth = ""
    }
    const webview = document.querySelector<Electron.WebviewTag>("webview")
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
