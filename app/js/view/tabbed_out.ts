import {
  BrowserView,
  BrowserWindow,
  WebContents,
  webContents,
  ipcMain,
} from "electron"
import * as path from "path"

export { create_view, pop_new_main, pop_no_tabs, tab_listeners }

function tab_listeners(win: BrowserWindow) {
  ipcMain.on("get_attached_wc_id", (event) => {
    console.log("get_attached_view", event.sender.id)
    let window = BrowserWindow.fromWebContents(event.sender)
    if (window) {
      let attached_view = window.getBrowserView()
      if (attached_view && !attached_view.isDestroyed()) {
        let view_wc_id = attached_view.webContents.id
        event.returnValue = view_wc_id
        return
      }
    }

    event.returnValue = null
  })

  ipcMain.on("end_me", (event) => {
    let view = BrowserView.fromWebContents(event.sender)
    if (view) {
      let window = BrowserWindow.fromBrowserView(view)
      if (window) {
        window.removeBrowserView(view)
        //.destroy()
      }
    }
  })

  ipcMain.on("bound_attached", (event, wc_id, bounds) => {
    console.log("bound_attached", wc_id)
    let window = BrowserWindow.fromWebContents(event.sender)
    let attached_view = window.getBrowserView()
    if (attached_view && !attached_view.isDestroyed()) {
      let view_wc_id = attached_view.webContents.id
      if (view_wc_id == wc_id) {
        //console.log("bound_attached", event, view_wc_id, wc_id, bounds)
        attached_view.setBounds(bounds)
      }

      event.returnValue = view_wc_id
    }
  })

  ipcMain.on("get_parent_id", (event) => {
    let view = BrowserView.fromWebContents(event.sender)
    if (view) {
      let window = BrowserWindow.fromBrowserView(view)
      if (window) {
        event.returnValue = window.webContents.id
        return
      }
    }
    event.returnValue = null
  })

  ipcMain.on("no_more_tabs_can_i_go", (event) => {
    let windows = BrowserWindow.getAllWindows()
    if (windows && windows.length > 2) {
      let window = BrowserWindow.fromWebContents(event.sender)
      if (window) {
        window.close()
      }
    }
  })

  ipcMain.on("tab_me_out", (event, data) => {
    console.log("tab_me_out", event, data)
    let view = BrowserView.fromWebContents(event.sender)
    if (view) {
      let window = BrowserWindow.fromBrowserView(view)
      if (window) {
        if (data.type == "main") {
          pop_new_main(window, event.sender, data.offset)
        } else if (data.type == "notabs") {
          pop_no_tabs(window, event.sender)
        }
      }
    }
  })

  ipcMain.on("attach_new_tab", (event) => {
    let view = create_view(event.sender.id)
    if (view) {
      let window = BrowserWindow.fromWebContents(event.sender)
      if (window) {
        window.setBrowserView(view)
        console.log("attach_new_tab", event.sender.id, view.webContents.id)
        event.returnValue = view.webContents.id
      }
    }
    event.returnValue = null
  })

  ipcMain.on("attach_wc_id", (event, wc_id: string) => {
    let window = BrowserWindow.fromWebContents(event.sender)
    if (window) {
      let view_wc = webContents.fromId(parseInt(wc_id))
      if (view_wc) {
        let view = BrowserView.fromWebContents(view_wc)
        if (view) {
          let old_parent = BrowserWindow.fromBrowserView(view)
          if (old_parent) {
            console.debug(
              "removing from old_parent",
              old_parent.webContents.id,
              wc_id,
              view.webContents.id
            )
            old_parent.removeBrowserView(view)
          }

          window.setBrowserView(view)

          view.webContents.send("attached", event.sender.id)

          console.log(
            "attach_wc_id",
            event.sender.id,
            wc_id,
            view.webContents.id
          )
          event.returnValue = view.webContents.id
          return
        }
      }
    }
    event.returnValue = null
  })

  win.on("close", (x) => {
    //kill all attached browserviews before close
    if (win && win.getBrowserViews().length != 0) {
      win.getBrowserViews().forEach((v) => {
        win.removeBrowserView(v)
        v.destroy()
      })
    }
    win.destroy()
    win.close()
  })
}

function create_view(parent_id: number) {
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: false,
      webSecurity: false,
      webviewTag: true,
      preload: global.tab_view_preload,
    },
  })

  view.webContents.loadFile(path.join(__dirname, "..", "..", "webtab.html"))

  view.webContents.once("dom-ready", (x) => {
    view.webContents.send("attached", parent_id)
  })

  return view
}

function new_relative_win(
  parent: BrowserWindow,
  wc: WebContents,
  path: string,
  full_resize = false,
  initial_offset: [number, number] = null
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
    width: view_bound.width + 50,
    height: size[1],
    autoHideMenuBar: true,
    icon: global.icon_path,
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: false,
      webSecurity: false,
      webviewTag: true,
      preload: global.main_window_preload,
    },
  })

  win_popup.setBrowserView(poped_view)
  wc.send("attached", win_popup.webContents.id)

  if (full_resize) {
    win_popup.on("resize", () => {
      follow_resize(win_popup, poped_view)
    })
    win_popup.setSize(view_bound.width, size[1] + 1)
  }

  win_popup.loadFile(path)

  //return win_popup
  win_popup.on("close", (x) => {
    console.log(
      "closing had attached",
      win_popup.getBrowserViews().length,
      win_popup.getBrowserViews()
    )
    if (win_popup.getBrowserViews().length != 0) {
      win_popup.getBrowserViews().forEach((v) => {
        console.log(
          "remaining views",
          win_popup.webContents.id,
          v.webContents.id
        )
        win_popup.removeBrowserView(v)
        v.destroy()
      })
    }
    x.preventDefault()
    win_popup.destroy()
  })
}

function follow_resize(win_popup: BrowserWindow, poped_view: BrowserView) {
  let box = win_popup.getContentBounds()
  console.debug("follow_resize", box)
  poped_view.setBounds({
    x: 0,
    y: 0,
    width: box.width,
    height: box.height,
  })
}

function pop_new_main(
  parent: BrowserWindow,
  wc: webContents,
  offset: [number, number] = null
) {
  parent.webContents.send("detaching")
  new_relative_win(
    parent,
    wc,
    path.join(__dirname, "..", "..", "main_window.html"),
    false,
    offset
  )
}

function pop_no_tabs(parent: BrowserWindow, wc: webContents) {
  parent.webContents.send("detaching")
  new_relative_win(parent, wc, "", true)
}
