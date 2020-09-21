import { filter_url } from "../data/URLFilters"
import * as tabbed_out from "../view/tabbed_out"
//import { TabWrangler } from "./TabWrangler"

export class NavigationHandler {
  webContents: Electron.webContents
  custom_protocol_handlers: Record<
    string,
    (url: string, target: string) => void
  > = {
    search: (url, target) => {
      tabbed_out.tab_intercom(
        { sender: this.webContents },
        "search_stories",
        url
      )
      //TabWrangler.ops.search_stories(url)
    },
  }

  constructor(webContents: Electron.webContents) {
    this.webContents = webContents

    webContents.on(
      "new-window",
      (event, url, frameName, disposition, additionalFeatures) => {
        event.preventDefault()
        console.debug(
          "caught new-window",
          url,
          frameName,
          disposition,
          additionalFeatures
        )
        this.open_url(url, "blank")
      }
    )

    webContents.on("will-navigate", (event, url) => {
      event.preventDefault()
      console.debug("caught will-navigate", url, event)
      this.open_url(url, "self")
    })

    webContents.on(
      "will-redirect",
      (event, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) => {
        event.preventDefault()
        console.debug(
          "caught will-redirect",
          url,
          //event,
          isInPlace,
          isMainFrame
        )
        this.open_url(url, "self")
      }
    )
  }

  open_url(url: string, target: string) {
    url = filter_url(url)

    if (url.startsWith("http:") || url.startsWith("https:")) {
      if (target == "blank") {
        tabbed_out.tab_intercom(
          { sender: this.webContents },
          "open_in_new_tab",
          url
        )
      } else {
        tabbed_out.tab_intercom(
          { sender: this.webContents },
          "open_in_tab",
          url
        )
      }
    } else {
      let split = url.split(":")
      if (split.length > 1) {
        let proto = split.shift()
        let url = split.join(":")
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
