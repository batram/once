const path = require("path")
const { BrowserView, BrowserWindow } = require("electron")

module.exports = {
  create_view,
  pop_new_main,
  pop_no_tabs,
}

function create_view(parent_id) {
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: false,
      webSecurity: false,
      webviewTag: true,
    },
  })

  view.webContents.loadFile(path.join(__dirname, "..", "..", "webtab.html"))

  view.webContents.once("dom-ready", (x) => {
    view.webContents.send("attached", parent_id)
  })

  return view
}

function new_relative_win(
  parent,
  wc,
  path,
  full_resize = false,
  initial_offset = null
) {
  let size = parent.getSize()
  let poped_view = parent.getBrowserView()
  if (!poped_view) {
    poped_view = BrowserView.fromWebContents(wc)
  }
  let view_bound = poped_view.getBounds()
  let parent_pos = parent.getPosition()
  parent.removeBrowserView(poped_view)

  let initial_x = parent_pos[0] + view_bound.x
  let initial_y = parent_pos[1]

  if (initial_offset != null && initial_offset.length == 2) {
    initial_x += initial_offset[0]
    initial_y += initial_offset[1]
  }

  let win_popup = new BrowserWindow({
    x: initial_x,
    y: initial_y,
    width: view_bound.width,
    height: size[1],
    autoHideMenuBar: true,
    icon: global.icon_path,
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: false,
      webSecurity: false,
      webviewTag: true,
    },
  })

  win_popup.setBrowserView(poped_view)
  wc.send("attached", win_popup.webContents.id)

  if (full_resize) {
    function follow_resize() {
      let box = win_popup.getContentBounds()
      console.debug("follow_resize", box)
      poped_view.setBounds({
        x: 0,
        y: 0,
        width: box.width,
        height: box.height,
      })
    }
    win_popup.on("resize", follow_resize)
    win_popup.setSize(view_bound.width, size[1] + 1)
  }

  win_popup.loadFile(path)
  //return win_popup
  win_popup.on("close", (x) => {
    if (win_popup.getBrowserViews().length != 0) {
      win_popup.getBrowserViews().forEach((v) => {
        win_popup.removeBrowserView(v)
        win_popup.destroy()
      })
    }

    win_popup.destroy()
  })
}

function pop_new_main(parent, wc, offset = null) {
  //parent.send("detaching")
  new_relative_win(
    parent,
    wc,
    path.join(__dirname, "..", "..", "main_window.html"),
    false,
    offset
  )
}

function pop_no_tabs(parent, wc) {
  //parent.send("detaching")
  new_relative_win(parent, wc, "", true)
}
