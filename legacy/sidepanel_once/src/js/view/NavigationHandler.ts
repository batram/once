import { URLRedirect } from "../data/URLRedirect"

export class NavigationHandler {
  /*
  webContents: Electron.WebContents
  static custom_protocol_handlers: Record<
    string,
    (webContents: Electron.WebContents, url: string, target: string) => void
  > = {
    search: (webContents, url) => {
      tabbed_out.send_to_parent({ sender: webContents }, "search_stories", url)
    },
  }

  constructor(webContents: Electron.WebContents) {
    this.webContents = webContents

    webContents.on(
      "new-window",
      (event, url, frameName, disposition, ...args) => {
        console.log("new-window", event, url, frameName, disposition, args)
        console.debug("new-window", frameName, args)
        if (frameName == "popout-window" || disposition == "new-window") {
          NavigationHandler.open_url(webContents, event, url, "popout-window")
        } else if (disposition == "foreground-tab" && frameName != "new_tab") {
          event.preventDefault()
        } else {
          NavigationHandler.open_url(webContents, event, url, "blank")
        }
      }
    )

    webContents.on("will-navigate", (event, url) => {
      NavigationHandler.open_url(webContents, event, url, "self")
    })

    webContents.on("will-redirect", (event, url) => {
      NavigationHandler.open_url(webContents, event, url, "self")
    })
  }

  static open_url(
    webContents: Electron.WebContents,
    event: Electron.Event,
    url: string,
    target: string
  ): void {
    if (url.startsWith("http:") || url.startsWith("https:")) {
      const new_url = URLRedirect.redirect_url(url)
      if (new_url != url) {
        if (event.preventDefault) {
          event.preventDefault()
        }
        url = new_url
      } else if (webContents.getType() == "webview" && target == "self") {
        console.log("open_url: let webview navigate on its own", url)
        return
      }

      if (target == "blank") {
        if (event.preventDefault) {
          event.preventDefault()
        }
        tabbed_out.send_to_parent(
          { sender: webContents },
          "open_in_new_tab",
          url
        )
      } else if (target == "popout-window") {
        if (event.preventDefault) {
          event.preventDefault()
        }
        tabbed_out.open_in_new_window(webContents, url)
      } else {
        if (event.preventDefault) {
          event.preventDefault()
        }
        tabbed_out.send_to_parent({ sender: webContents }, "open_in_tab", url)
      }
    } else {
      // Not http or https can't let that through to default
      if (event.preventDefault) {
        event.preventDefault()
      }
      // check if we have custom protocoll
      const split = url.split(":")
      if (split.length > 1) {
        const proto = split.shift()
        const url = split.join(":")
        console.debug(
          "custom proto?",
          proto,
          url,
          NavigationHandler.custom_protocol_handlers[proto]
        )
        if (this.custom_protocol_handlers[proto]) {
          NavigationHandler.custom_protocol_handlers[proto](
            webContents,
            url,
            target
          )
        }
      }
    }
  }
  */
}
