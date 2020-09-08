module.exports = {
  story_menu,
  inspect_menu,
}

const { remote, shell, clipboard } = require("electron")
const { Menu, MenuItem } = remote

const cmenu_data = {
  rightClickPosition: null,
  href: null,
  sender: null,
}

const strory_m = new Menu()
strory_m.append(
  new MenuItem({
    label: "Copy URL",
    click() {
      clipboard.writeText(cmenu_data.href, "selection")
    },
  })
)
strory_m.append(
  new MenuItem({
    label: "Open in Browser",
    click: async () => {
      await shell.openExternal(cmenu_data.href)
    },
  })
)
strory_m.append(
  new MenuItem({
    label: "inspect",
    click: () => {
      remote
        .getCurrentWindow()
        .inspectElement(
          cmenu_data.rightClickPosition.x,
          cmenu_data.rightClickPosition.y
        )
    },
  })
)

const inspect_m = new Menu()
inspect_m.append(
  new MenuItem({
    id: "cp_url",
    label: "Copy URL",
    visible: false,
    click() {
      clipboard.writeText(cmenu_data.href, "selection")
    },
  })
)
inspect_m.append(
  new MenuItem({
    id: "open",
    label: "Open in Browser",
    visible: false,
    click: async () => {
      await shell.openExternal(cmenu_data.href)
    },
  })
)
inspect_m.append(
  new MenuItem({
    label: "inspect",
    click: () => {
      if (cmenu_data.sender) {
        cmenu_data.sender.inspectElement(
          cmenu_data.rightClickPosition.x,
          cmenu_data.rightClickPosition.y
        )
      } else {
        remote
          .getCurrentWindow()
          .inspectElement(
            cmenu_data.rightClickPosition.x,
            cmenu_data.rightClickPosition.y
          )
      }
    },
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
    inspect_m.getMenuItemById("cp_url").visible = true
    inspect_m.getMenuItemById("open").visible = true
    cmenu_data.href = params.linkURL
  } else {
    inspect_m.getMenuItemById("cp_url").visible = false
    inspect_m.getMenuItemById("open").visible = false
    cmenu_data.href = null
  }

  cmenu_data.rightClickPosition = {
    x: params.x,
    y: params.y,
  }
  inspect_m.popup({
    window: remote.getCurrentWindow(),
  })
}

function story_menu(e, x) {
  e.preventDefault()
  cmenu_data.href = x.href
  cmenu_data.rightClickPosition = {
    x: e.x,
    y: e.y,
  }
  strory_m.popup({
    window: remote.getCurrentWindow(),
  })
}
