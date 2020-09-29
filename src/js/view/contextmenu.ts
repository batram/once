import {
  Menu,
  MenuItem,
  shell,
  clipboard,
  webContents,
  WebContents,
} from "electron"

export function init_menu(wc: webContents): void {
  wc.on("context-menu", (event, params) => {
    event.preventDefault()
    inspect_menu(wc, params)
  })

  wc.on("update-target-url", (_event, url) => {
    wc.send("update-target-url", url)
  })
}

declare interface CMenuData {
  rightClickPosition: { x: number; y: number }
  href: string
  sender: WebContents
}

const cmenu_data: CMenuData = {
  rightClickPosition: null,
  href: null,
  sender: null,
}

//Dafug why event: Electron.KeyboardEvent, ELectron why???
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

const con_menu = new Menu()
con_menu.append(
  new MenuItem({
    id: "cp_url",
    label: "Copy URL",
    visible: false,
    click() {
      clipboard.writeText(cmenu_data.href, "selection")
    },
  })
)
con_menu.append(
  new MenuItem({
    id: "open",
    label: "Open in Browser",
    visible: false,
    click: async () => {
      await shell.openExternal(cmenu_data.href)
    },
  })
)
con_menu.append(
  new MenuItem({
    label: "inspect",
    click: inspect,
  })
)

function inspect_menu(
  sender: Electron.WebContents,
  params: Electron.ContextMenuParams
) {
  cmenu_data.sender = sender

  if (
    Object.prototype.hasOwnProperty.call(params, "linkURL") &&
    params.linkURL != ""
  ) {
    con_menu.getMenuItemById("cp_url").visible = true
    con_menu.getMenuItemById("open").visible = true
    cmenu_data.href = params.linkURL
  } else {
    con_menu.getMenuItemById("cp_url").visible = false
    con_menu.getMenuItemById("open").visible = false
    cmenu_data.href = null
  }

  cmenu_data.rightClickPosition = {
    x: params.x,
    y: params.y,
  }
  con_menu.popup()
}
