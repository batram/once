module.exports = {
  init_menu,
  story_menu,
  inspect_menu,
}

const { Menu, MenuItem, shell, clipboard, ipcMain } = require("electron")
//const fullscreen = require("./fullscreen")

function init_menu(wc) {
  wc.on("context-menu", inspect_menu)

  wc.on("update-target-url", (event, url) => {
    wc.send("update-target-url", url)
  })
}

const cmenu_data = {
  rightClickPosition: null,
  href: null,
  sender: null,
}

function inspect(e, cwin) {
  if (cmenu_data.sender) {
    cwin = cmenu_data.sender
  }

  cwin.inspectElement(
    cmenu_data.rightClickPosition.x,
    cmenu_data.rightClickPosition.y
  )
  if (cwin.isDevToolsOpened()) {
    cwin.devToolsWebContents.focus()
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

function inspect_menu(event, params) {
  event.preventDefault()
  if (event.hasOwnProperty("sender")) {
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

function story_menu(event, params) {
  if (event.hasOwnProperty("sender")) {
    cmenu_data.sender = event.sender
  } else {
    cmenu_data.sender = null
  }

  event.preventDefault()
  cmenu_data.href = params.href
  con_menu.getMenuItemById("cp_url").visible = true
  con_menu.getMenuItemById("open").visible = true
  cmenu_data.rightClickPosition = {
    x: event.x,
    y: event.y,
  }
  con_menu.popup()
}
