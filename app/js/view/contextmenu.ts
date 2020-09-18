import { Menu, MenuItem, shell, clipboard, webContents } from "electron"

export { init_menu, inspect_menu }

function init_menu(wc: webContents) {
  wc.on("context-menu", inspect_menu)

  wc.on("update-target-url", (event, url) => {
    wc.send("update-target-url", url)
  })
}

declare interface CMenuData {
  rightClickPosition: { x: number; y: number }
  href: string
  sender: null
}

const cmenu_data: CMenuData = {
  rightClickPosition: null,
  href: null,
  sender: null,
}

//Dafug why event: Electron.KeyboardEvent, ELectron why???
function inspect(
  menuItem: Electron.MenuItem,
  cwin: Electron.BrowserWindow,
  event: Electron.KeyboardEvent
) {
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
  event: Electron.Event,
  params: Electron.ContextMenuParams
) {
  event.preventDefault()
  if (event.hasOwnProperty("sender")) {
    // @ts-ignore
    cmenu_data.sender = event.sender
  } else {
    cmenu_data.sender = null
  }

  if (params.hasOwnProperty("linkURL") && params.linkURL != "") {
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
