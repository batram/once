exports.story_menu = story_menu

const stupidMenu = {
  rightClickPosition: null,
  target: null,
}

const menu = new Menu()
menu.append(
  new MenuItem({
    label: "Copy URL",
    click() {
      clipboard.writeText(stupidMenu.target.href, "selection")
    },
  })
)
menu.append(
  new MenuItem({
    label: "Open in Browser",
    click: async () => {
      await shell.openExternal(stupidMenu.target.href)
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
          stupidMenu.rightClickPosition.x,
          stupidMenu.rightClickPosition.y
        )
    },
  })
)

function story_menu(e, story) {
  e.preventDefault()
  stupidMenu.target = story
  stupidMenu.rightClickPosition = {
    x: e.x,
    y: e.y,
  }
  menu.popup({
    window: remote.getCurrentWindow(),
  })
}
