import {
  Menu,
  MenuItem,
  shell,
  clipboard,
  WebContents,
  ipcMain,
} from "electron"
import { NavigationHandler } from "../view/NavigationHandler"

export function init_menu(wc: WebContents): void {
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
}

declare interface CMenuData {
  rightClickPosition: { x: number; y: number }
  href: string
  sender: WebContents
  wc_id?: string
}

const cmenu_data: CMenuData = {
  rightClickPosition: null,
  href: null,
  sender: null,
  wc_id: null,
}

function inspect(_menuItem: Electron.MenuItem, cwin: Electron.BrowserWindow) {
  let wc = cwin.webContents

  if (cmenu_data.sender) {
    wc = cmenu_data.sender
  }

  wc.inspectElement(
    cmenu_data.rightClickPosition.x,
    cmenu_data.rightClickPosition.y
  )
  if (wc.isDevToolsOpened()) {
    wc.devToolsWebContents.focus()
  }
}

function inspect_menu(
  sender: Electron.WebContents,
  params: { linkURL?: string; x?: number; y?: number; wc_id?: string }
) {
  cmenu_data.sender = sender
  const con_menu = new Menu()
  con_menu.append(
    new MenuItem({
      label: "inspect",
      click: inspect,
    })
  )

  if (params.linkURL && params.linkURL != "") {
    con_menu.append(new MenuItem({ type: "separator", id: "url_sep" }))
    con_menu.append(
      new MenuItem({
        id: "url_copy",
        label: "Copy URL",
        click() {
          clipboard.writeText(cmenu_data.href, "selection")
        },
      })
    )
    con_menu.append(
      new MenuItem({
        id: "url_open",
        label: "Open in Browser",
        click: () => {
          shell.openExternal(cmenu_data.href)
        },
      })
    )
    con_menu.append(
      new MenuItem({
        id: "url_open",
        label: "Open in new window",
        click: (_e, _x, event) => {
          NavigationHandler.open_url(
            cmenu_data.sender,
            event as Event,
            cmenu_data.href,
            "popout-window"
          )
        },
      })
    )
    con_menu.append(
      new MenuItem({
        id: "url_open",
        label: "Open in new tab",
        click: (_e, _x, event) => {
          NavigationHandler.open_url(
            cmenu_data.sender,
            event as Event,
            cmenu_data.href,
            "new-tab"
          )
        },
      })
    )
    cmenu_data.href = params.linkURL
  } else {
    cmenu_data.href = null
  }

  if (params.wc_id && params.wc_id != "") {
    con_menu.append(new MenuItem({ type: "separator", id: "tab_sep" }))
    con_menu.append(
      new MenuItem({
        id: "tab_close",
        label: "Close Tab",
        click() {
          cmenu_data.sender.send("tab_close", cmenu_data.wc_id)
        },
      })
    )
    con_menu.append(
      new MenuItem({
        id: "tab_dupe",
        label: "Duplicate Tab",
        click: async () => {
          cmenu_data.sender.send("tab_dupe", cmenu_data.wc_id)
        },
      })
    )
    cmenu_data.wc_id = params.wc_id
  } else {
    cmenu_data.wc_id = null
  }

  cmenu_data.rightClickPosition = {
    x: params.x,
    y: params.y,
  }

  con_menu.popup()
}
