exports.story_menu = story_menu

const cmenu_data = {
  rightClickPosition: null,
  href: null,
}

const menu = new Menu()
menu.append(
  new MenuItem({
    label: "Copy URL",
    click() {
      clipboard.writeText(cmenu_data.href, "selection")
    },
  })
)
menu.append(
  new MenuItem({
    label: "Open in Browser",
    click: async () => {
      await shell.openExternal(cmenu_data.href)
    },
  })
)
menu.append(
  new MenuItem({
    label: "test",
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

function story_menu(e, x) {
  e.preventDefault()
  cmenu_data.href = x.href
  cmenu_data.rightClickPosition = {
    x: e.x,
    y: e.y,
  }
  menu.popup({
    window: remote.getCurrentWindow(),
  })
}
