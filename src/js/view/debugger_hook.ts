import { WebContents } from "electron"

function addEventListener(
  webContents: WebContents,
  event: string,
  inline_js: string,
  callback: (a: unknown) => unknown
): void {
  try {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach()
    }
  } catch (e) {
    console.log(e)
  }

  webContents.debugger.on("message", function (event, method, params) {
    //console.log("debug_message", event, method, params)
    if (method == "Runtime.bindingCalled") {
      const name = params.name

      if (name == "mhook") {
        callback(params.payload)
      }
    }
  })

  //both need to be enabled to call Page.addScriptToEvaluateOnNewDocument, set the hook and receive messages
  webContents.debugger.sendCommand("Runtime.enable")
  webContents.debugger.sendCommand("Page.enable")

  webContents.debugger.sendCommand("Runtime.addBinding", {
    name: "mhook",
  })

  /*
  if (false) {
    webContents.debugger.sendCommand("Page.setLifecycleEventsEnabled", {
      enabled: true,
    })
  }
  */

  const event_string = JSON.stringify(event.toString())

  webContents.debugger
    .sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: `
      {
        const ßß = (x) => {
          let ß = window.mhook
          window.addEventListener(${event_string}, (e) => {
            ß(${inline_js})
          })  
        }
        ßß()
      }
      delete window.mhook
      `,
    })
    .then((e) => {
      console.log("ok hooked", e)
    })
    .catch((e) => {
      console.log("fudged", e)
    })
}

export function history_nav(webContents: WebContents): void {
  addEventListener(
    webContents,
    "mousedown",
    "e.button.toString()",
    (payload: string) => {
      if (payload == "3") {
        webContents.goBack()
      } else if (payload == "4") {
        webContents.goForward()
      }
    }
  )
}
