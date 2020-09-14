module.exports = {
  init_menu,
  story_menu,
  inspect_menu,
  show_target_url,
}

const { remote, shell, clipboard } = require("electron")
const { Menu, MenuItem } = remote
const fullscreen = require("./fullscreen")

function init_menu() {
  let wc = remote.getCurrentWebContents()

  wc.on("update-target-url", show_target_url)
  wc.on("context-menu", inspect_menu)

  window.addEventListener("beforeunload", (x) => {
    //Clean up listiners
    wc.removeListener("context-menu", inspect_menu)
    wc.removeListener("update-target-url", show_target_url)
  })

  window.addEventListener("keyup", fullscreen.key_handler)
}

function show_target_url(event, url) {
  if (!document.querySelector("#url_target")) {
    return
  }

  if (url != "") {
    url_target.style.opacity = "1"
    url_target.style.zIndex = "16"
    if (url.length <= 63) {
      url_target.innerText = url
    } else {
      url_target.innerText = url.substring(0, 60) + "..."
    }
  } else {
    url_target.style.opacity = "0"
    url_target.style.zIndex = "-1"
  }
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
  con_menu.popup({
    window: remote.getCurrentWindow(),
  })
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
  con_menu.popup({
    window: remote.getCurrentWindow(),
  })
}
