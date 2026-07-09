import { NavigationHandler } from "../view/NavigationHandler"
import { execFile } from "child_process"
import * as presenters_backend from "../view/presenters_backend"

export function init_menu(): void {
  /**
   * TODO: Add context menu
   * - maybe open in reader/video view???
   */
  /*
  wc.on("context-menu", (event, params) => {
    event.preventDefault()
    inspect_menu(wc, params)
  })

  wc.on("update-target-url", (_event, url) => {
    wc.send("update-target-url", url)
  })

  ipcMain.on("show_tab_menu", (event, x, y, url, wc_id) => {
    inspect_menu(event.sender, {
      x: parseInt(x),
      y: parseInt(y),
      linkURL: url,
      wc_id: wc_id,
    })
  })
  */
}
