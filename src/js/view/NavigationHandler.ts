import { URLRedirect } from "../data/URLRedirect"
import * as tabbed_out from "../view/tabbed_out"

export class NavigationHandler {
  webContents: Electron.webContents
  custom_protocol_handlers: Record<
    string,
    (url: string, target: string) => void
  > = {
    search: (url) => {
      tabbed_out.send_to_parent(
        { sender: this.webContents },
        "search_stories",
        url
      )
    },
  }

  constructor(webContents: Electron.webContents) {
    this.webContents = webContents

    webContents.on(
      "new-window",
      (event, url, frameName, disposition, ...args) => {
        console.debug("new-window", frameName, args)
        if (frameName == "popout-window" || disposition == "new-window") {
          this.open_url(event, url, "popout-window")
        } else {
          this.open_url(event, url, "blank")
        }
      }
    )

    webContents.on("will-navigate", (event, url) => {
      this.open_url(event, url, "self")
    })

    webContents.on("will-redirect", (event, url) => {
      this.open_url(event, url, "self")
    })
  }

  open_url(event: Electron.Event, url: string, target: string): void {
    console.log("open_url", url, target, this.webContents.getType())
    if (url.startsWith("http:") || url.startsWith("https:")) {
      const new_url = URLRedirect.redirect_url(url)
      if (new_url != url) {
        event.preventDefault()
        url = new_url
      } else if (this.webContents.getType() == "webview" && target == "self") {
        console.log("open_url: let webview navigate on its own", url)
        return
      }

      if (target == "blank") {
        event.preventDefault()
        tabbed_out.send_to_parent(
          { sender: this.webContents },
          "open_in_new_tab",
          url
        )
      } else if (target == "popout-window") {
        event.preventDefault()
        tabbed_out.open_in_new_window(this.webContents, url)
      } else {
        event.preventDefault()
        tabbed_out.send_to_parent(
          { sender: this.webContents },
          "open_in_tab",
          url
        )
      }
    } else {
      // Not http or https can't let that through to default
      event.preventDefault()
      // check if we have custom protocoll
      const split = url.split(":")
      if (split.length > 1) {
        const proto = split.shift()
        const url = split.join(":")
        console.debug(
          "custom proto?",
          proto,
          url,
          this.custom_protocol_handlers[proto]
        )
        if (this.custom_protocol_handlers[proto]) {
          this.custom_protocol_handlers[proto](url, target)
        }
      }
    }
  }
}
