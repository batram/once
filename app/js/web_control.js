module.exports = {
  open_in_tab,
  attach_webtab,
  send_or_create_tab,
  send_to_webtab,
}

const { remote, ipcRenderer, WebContents } = require("electron")
const contextmenu = require("./view/contextmenu")
const filters = require("./data/filters")
const fullscreen = require("./view/fullscreen")
const webtab = require("./view/webtab")

function attach_webtab(size_to_el) {
  webtab_comms()

  let cwin = remote.getCurrentWindow()
  let view = webtab.create(cwin.id)

  window.addEventListener("beforeunload", (x) => {
    //kill all attached browserviews
    if (cwin && cwin.getBrowserViews().length != 0) {
      cwin.getBrowserViews().forEach((v) => {
        cwin.removeBrowserView(v)
        v.destroy()
      })
    }
  })

  if (size_to_el) {
    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        if ((entry.target.id = "content")) {
          let box = entry.contentRect
          let cwin = remote.getCurrentWindow()
          if (cwin) {
            let bw = cwin.getBrowserView()
            if (bw && !bw.isDestroyed()) {
              bw.setBounds({
                x: Math.floor(entry.target.offsetLeft),
                y: Math.floor(box.y),
                width: Math.floor(box.width),
                height: Math.floor(box.height),
              })
            }
          }
        }
      }
    })

    resizeObserver.observe(size_to_el)
    view.setBounds({
      x: Math.floor(size_to_el.offsetLeft),
      y: Math.floor(size_to_el.offsetTop),
      width: Math.floor(size_to_el.clientWidth),
      height: Math.floor(size_to_el.clientHeight),
    })
  }

  return view
}

function webtab_comms() {
  ipcRenderer.on("mark_selected", mark_selected)
  ipcRenderer.on("update_story", update_story)
  ipcRenderer.on("show_filter", show_filter)
  ipcRenderer.on("add_filter", add_filter)
  ipcRenderer.on("subscribe_to_change", subscribe_to_change)
  ipcRenderer.on("update-target-url", contextmenu.show_target_url)

  window.addEventListener("beforeunload", (x) => {
    ipcRenderer.removeListener("mark_selected", mark_selected)
    ipcRenderer.removeListener("update_story", update_story)
    ipcRenderer.removeListener("show_filter", show_filter)
    ipcRenderer.removeListener("add_filter", add_filter)
    ipcRenderer.removeListener("subscribe_to_change", subscribe_to_change)
    //TODO: remove presenter listeners
  })

  function show_filter(event, data) {
    filters.show_filter(data)
  }

  function add_filter(event, data) {
    filters.add_filter(data)
  }

  function update_story(event, data) {
    story_loader.story_map.update_story(data.href, data.path, data.value)
  }

  function subscribe_to_change(event, data) {
    console.log("subscribe_to_change", data)
    if (data.wc_id) {
      //TODO: filter here or on tab?
      document.body.addEventListener("data_change", function update(e) {
        //TODO: detect closed webcontent and remove listener
        send_to_id(data.wc_id, "data_change", e.detail.story)
      })
    }
  }

  function mark_selected(event, href) {
    let colors = [...document.querySelectorAll(".tag_style")]
      .map((x) => {
        return x.innerText
      })
      .join("\n")

    const { mark_selected } = require("./view/StoryList")
    let story = mark_selected(null, href)

    if (href == "about:gone") {
      return
    }
    //ipcRenderer.sendTo
    send_to_id(event.senderId, "update_selected", story, colors)
  }
}

function send_to_id(id, ...args) {
  let { remote } = require("electron")
  let webc = remote.webContents.fromId(id)
  if (webc && !webc.isDestroyed()) {
    //active found
    webc.send(...args)
  }
}

function send_to_webtab(...args) {
  let cwin = remote.getCurrentWindow()
  if (cwin && cwin.getBrowserView()) {
    let view = cwin.getBrowserView()
    if (view && !view.isDestroyed()) {
      //active found
      view.webContents.send(...args)
    }
  }
}

function send_or_create_tab(name, value) {
  let cwin = remote.getCurrentWindow()
  if (cwin && cwin.getBrowserView()) {
    let view = cwin.getBrowserView()
    if (view && !view.isDestroyed()) {
      //active found
      view.webContents.send(name, value)
      return
    }
  }
  if (document.querySelector("#content")) {
    //creating new webtab
    let view = attach_webtab(content)
    view.webContents.once("did-finish-load", (x) => {
      view.webContents.send(name, value)
    })
  }
}

function open_in_tab(href, force_new = false, pop_up = false) {
  //do we need to start looking at target dingens?
  let is_in_tab =
    document.querySelector("#webtab") && document.querySelector("#webview")
  if (is_in_tab && !force_new) {
    webtab.open_in_webview(href)
  } else {
    send_or_create_tab("open_in_webview", href)
  }
}
