import {
  BrowserView,
  BrowserWindow,
  WebContents,
  webContents,
  ipcMain,
} from "electron"
import * as path from "path"
export { create_view, pop_new_main, pop_no_tabs, tab_listeners }

const tab_views: Record<number, BrowserView> = {}
const parent_windows: Record<number, BrowserWindow> = {}

export function send_to_parent(
  event: { sender: WebContents },
  secondary_channel: string,
  ...args: string[]
): void {
  console.log(secondary_channel, ...args)
  console.log(
    event.sender.id,
    event.sender.getType(),
    Object.keys(parent_windows)
  )
  console.log(event.sender.id, event.sender.getType(), Object.keys(tab_views))

  const parent = get_parent_window(event.sender)

  if (parent) {
    parent.webContents.send(secondary_channel, ...args)
  }
}

function get_parent_window(webcontents: WebContents) {
  switch (webcontents.getType()) {
    case "window":
      return BrowserWindow.fromWebContents(webcontents)
    case "browserView": {
      const view = BrowserView.fromWebContents(webcontents)
      return BrowserWindow.fromBrowserView(view)
    }
    case "webview": {
      const window = BrowserWindow.fromWebContents(webcontents.hostWebContents)
      if (!window) {
        const view = BrowserView.fromWebContents(webcontents.hostWebContents)
        return BrowserWindow.fromBrowserView(view)
      }
      return window
    }
  }
  return null
}

function tab_listeners(win: BrowserWindow): void {
  ipcMain.on("forward_to_parent", send_to_parent)

  ipcMain.on("get_attached_wc_id", (event) => {
    console.log("get_attached_view", event.sender.id)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) {
      const attached_view = window.getBrowserView()
      if (attached_view && !attached_view.isDestroyed()) {
        const view_wc_id = attached_view.webContents.id
        event.returnValue = view_wc_id
        return
      }
    }

    event.returnValue = null
  })

  ipcMain.on("end_me", (event) => {
    const view = BrowserView.fromWebContents(event.sender)
    if (view) {
      const window = BrowserWindow.fromBrowserView(view)
      if (window) {
        window.removeBrowserView(view)
      }
      view.destroy()
    }
  })

  ipcMain.on("hide_webtab", (event, wc_id) => {
    const wc = webContents.fromId(parseInt(wc_id))
    const view = BrowserView.fromWebContents(wc)
    if (view) {
      const window = BrowserWindow.fromBrowserView(view)
      if (window) {
        window.removeBrowserView(view)
      }
    }
  })

  ipcMain.on("show_webtab", (event, wc_id) => {
    const wc = webContents.fromId(parseInt(wc_id))
    const view = BrowserView.fromWebContents(wc)
    if (view) {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (window) {
        window.setBrowserView(view)
      }
    }
    event.returnValue = wc_id
  })

  ipcMain.on("bound_attached", (event, wc_id, bounds) => {
    console.log("bound_attached", wc_id)
    const window = BrowserWindow.fromWebContents(event.sender)
    const attached_view = window.getBrowserView()
    if (attached_view && !attached_view.isDestroyed()) {
      const view_wc_id = attached_view.webContents.id
      if (view_wc_id == wc_id) {
        //console.log("bound_attached", event, view_wc_id, wc_id, bounds)
        attached_view.setBounds(bounds)
      }

      event.returnValue = view_wc_id
    }
  })

  ipcMain.on("get_parent_id", (event) => {
    const parent = get_parent_window(event.sender)
    if (parent) {
      event.returnValue = parent.webContents.id
    }
    event.returnValue = null
  })

  ipcMain.on("no_more_tabs_can_i_go", (event) => {
    const windows = BrowserWindow.getAllWindows()
    if (windows && windows.length > 2) {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (window) {
        window.close()
      }
    }
  })

  ipcMain.on("tab_me_out", (event, data) => {
    console.log("tab_me_out", event, data)
    const view = BrowserView.fromWebContents(event.sender)
    if (view) {
      const window = BrowserWindow.fromBrowserView(view)
      if (data.type == "main") {
        pop_new_main(window, event.sender, data.offset)
      } else if (data.type == "notabs") {
        pop_no_tabs(window, event.sender)
      }
    }
  })

  ipcMain.on("when_webview_ready", (event, wc_id, channel, ...args) => {
    const wc_target = webContents.fromId(wc_id)
    if (wc_target) {
      wc_target.once("did-attach-webview", () => {
        console.log("when_ready target ready", channel, ...args)
        wc_target.send(channel, ...args)
      })
    }
  })

  ipcMain.on("attach_new_tab", (event) => {
    const view = create_view(event.sender.id)
    if (view) {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (window) {
        window.setBrowserView(view)
        console.log("attach_new_tab", event.sender.id, view.webContents.id)
        tab_views[view.webContents.id] = view
        parent_windows[window.webContents.id] = window
        event.returnValue = view.webContents.id
      }
    }
    event.returnValue = null
  })

  ipcMain.on("attach_wc_id", (event, wc_id: string) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) {
      const view_wc = webContents.fromId(parseInt(wc_id))
      if (view_wc) {
        const view = BrowserView.fromWebContents(view_wc)
        if (view) {
          const old_parent = BrowserWindow.fromBrowserView(view)
          if (old_parent && old_parent.id != window.id) {
            console.debug(
              "removing from old_parent",
              old_parent.webContents.id,
              window.webContents.id,
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

  ipcMain.on("pic_webtab", async (event, wc_id: string) => {
    const wc = webContents.fromId(parseInt(wc_id))
    if (wc) {
      const cap = await wc.capturePage()
      if (cap) {
        event.returnValue = cap.toDataURL()
      }
    }
    event.returnValue = null
  })

  win.on("close", () => {
    //kill all attached browserviews before close
    if (win) {
      const views = win.getBrowserViews()
      if (views) {
        win.getBrowserViews().forEach((v) => {
          win.removeBrowserView(v)
          v.destroy()
        })
      }
    }
    win.destroy()
    win.close()
  })
}

function create_view(parent_id: number): BrowserView {
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: false,
      webSecurity: false,
      webviewTag: true,
      preload: global.paths.tab_view_preload,
    },
  })

  view.webContents.loadFile(global.paths.tab_view_html)

  view.webContents.once("dom-ready", () => {
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
  const size = parent.getSize()
  let poped_view = parent.getBrowserView()
  if (!poped_view) {
    poped_view = BrowserView.fromWebContents(wc)
  }
  const view_bound = poped_view.getBounds()
  const parent_pos = parent.getPosition()
  parent.removeBrowserView(poped_view)

  let initial_x = parent_pos[0] + view_bound.x
  let initial_y = parent_pos[1]

  if (initial_offset != null && initial_offset.length == 2) {
    initial_x += initial_offset[0]
    initial_y += initial_offset[1]
  }

  const win_popup = new BrowserWindow({
    x: initial_x,
    y: initial_y,
    width: view_bound.width + 50,
    height: size[1],
    autoHideMenuBar: true,
    icon: global.paths.icon_path,
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: false,
      webSecurity: false,
      webviewTag: true,
      preload: global.paths.main_window_preload,
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
  const box = win_popup.getContentBounds()
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
): void {
  parent.webContents.send("detaching")
  new_relative_win(
    parent,
    wc,
    path.join(global.paths.main_window_html),
    false,
    offset
  )
}

function pop_no_tabs(parent: BrowserWindow, wc: webContents): void {
  parent.webContents.send("detaching")
  new_relative_win(parent, wc, "", true)
}
