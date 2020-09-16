module.exports = {
  open_in_tab,
  open_in_new_tab,
  webtab_comms,
  window_events,
  new_webtab,
  attach_webtab,
  send_or_create_tab,
  send_to_webtab,
}

const { remote, ipcRenderer } = require("electron")
const { BrowserView } = remote
const filters = require("./data/filters")
const webtab = require("./view/webtab")
const fullscreen = require("./view/fullscreen")

function new_webtab(size_to_el, tab_info = null) {
  let tab_el = document.createElement("div")
  tab_el.setAttribute("draggable", "true")
  tab_el.classList.add("tab")
  tab_el.innerText = "New tab"
  tab_el.dataset.size_to = size_to_el.id
  let view = null

  if (tab_info != null) {
    if (
      !tab_info ||
      !tab_info.wc_id ||
      !tab_info.view_id ||
      isNaN(parseInt(tab_info.view_id))
    ) {
      throw (
        "can't add tab with incomplete information {wc_id: i, view_id, i}: " +
        JSON.stringify(tab_info)
      )
    }
    view = attach_webtab(size_to_el, parseInt(tab_info.view_id))
    mark_tab_active(tab_el)
    tab_el.dataset.view_id = view.id
    tab_el.dataset.wc_id = view.webContents.id
  } else {
    view = attach_webtab(size_to_el)
    mark_tab_active(tab_el)
    tab_el.dataset.view_id = view.id
    tab_el.dataset.wc_id = view.webContents.id
  }

  if (view == null) {
    console.error("failed to attach tab")
    return
  }

  let dropzone = document.querySelector("#tab_dropzone")
  if (dropzone) {
    dropzone.append(tab_el)
  } else {
    console.error("failed to find dropzone for tabs")
    return
  }

  tab_el.ondrag = (drag) => {
    //drag.preventDefault()
    //console.log("ondrag", drag)
  }
  tab_el.ondragstart = (drag) => {
    drag.dataTransfer.setData(
      "tab_drop",
      JSON.stringify({
        view_id: tab_el.dataset.view_id,
        wc_id: tab_el.dataset.wc_id,
      })
    )
    if (tab_el.dataset.href) {
      drag.dataTransfer.setData("text", tab_el.dataset.href)
    }
  }
  tab_el.ondragend = (drag) => {
    drag.preventDefault()
    console.log("ondragend", drag.dataTransfer.dropEffect, drag)

    if (drag.dataTransfer.dropEffect == "none") {
      send_to_id(tab_el.dataset.wc_id, "pop_out", [drag.offsetX, drag.offsetY])
    }
  }

  tab_el.addEventListener("mousedown", (e) => {
    if (e.button == 0) {
      activate_tab(tab_el)
    } else if (e.button == 1) {
      close_tab(tab_el)
    }
  })

  return view
}

function activate_tab(tab_el) {
  let size_to_el = document.getElementById(tab_el.dataset.size_to)
  attach_webtab(size_to_el, parseInt(tab_el.dataset.view_id))
  mark_tab_active(tab_el)
}

function close_tab(tab_el) {
  send_to_id(tab_el.dataset.wc_id, "closed")
  remove_tab_el(tab_el.dataset.wc_id)
}

function add_tab(tab_info) {
  if (!tab_info || !tab_info.wc_id || !tab_info.view_id) {
    console.error(
      "can't add tab with incomplete information {wc_id: i, view_id, i}",
      e
    )
    return
  }
  let existing_tab = tab_el_from_id(tab_info.wc_id)
  if (existing_tab) {
    mark_tab_active(existing_tab)
  } else {
    let tab_content = document.querySelector("#tab_content")
    if (tab_content) {
      new_webtab(tab_content, tab_info)
    } else {
      console.error("failed to find tab_content to attach tabs")
      return
    }
  }
}

function remove_tab_el(wc_id) {
  let tab_el = tab_el_from_id(wc_id)
  if (tab_el) {
    let size_to_el = document.getElementById(tab_el.dataset.size_to)
    if (size_to_el.dataset.active_wc_id == wc_id) {
      size_to_el.dataset.active_wc_id = ""
      let prev = tab_el.previousElementSibling
      if (prev && prev.classList.contains("tab")) {
        activate_tab(prev)
      } else {
        let next = tab_el.nextElementSibling
        if (next && next.classList.contains("tab")) {
          next
          activate_tab(next)
        }
      }
    }

    tab_el.outerHTML = ""
  }

  maybe_close_window()
}

//close the window if we have no more tabs and are not the last window open
function maybe_close_window() {
  if (document.querySelectorAll("tab").length == 0) {
    let windows = remote.BrowserWindow.getAllWindows()
    if (windows && windows.length > 1) {
      console.log("all the windows", windows)
      ipcRenderer.removeAllListeners()
      remote.getCurrentWindow().close()
    }
  }
}

function tab_el_from_id(id) {
  return document.querySelector(`.tab[data-wc_id="${id}"]`)
}

function mark_tab_active(tab_el) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.remove("active")
  })
  tab_el.classList.add("active")
}

function attach_webtab(size_to_el, view_id = null) {
  let cwin = remote.getCurrentWindow()
  let view = null

  if (view_id != null) {
    view = BrowserView.fromId(view_id)
  } else {
    view = webtab.create(cwin.id)
    view_id = view.id
  }
  if (!view) {
    console.error("failed to create or retrieve view to attach")
    return
  }

  send_to_id(view.webContents.id, "attached", cwin.id)
  cwin.setBrowserView(view)

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
    let wc_id = view.webContents.id
    size_to_el.dataset.active_wc_id = view.webContents.id

    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        if ((entry.target.id = size_to_el.id)) {
          let cw = remote.getCurrentWindow()
          if (cw) {
            let attached_view = cw.getBrowserView()
            if (attached_view) {
              if (
                size_to_el.dataset.active_wc_id == attached_view.webContents.id
              ) {
                attached_view.setBounds({
                  x: Math.floor(size_to_el.offsetLeft),
                  y: Math.floor(size_to_el.offsetTop),
                  width: Math.floor(size_to_el.clientWidth),
                  height: Math.floor(size_to_el.clientHeight),
                })
              }
            }
          }
          /*
          let box = entry.contentRect
          send_to_id(entry.target.dataset.active_id, "size_changed", {
            x: Math.floor(entry.target.offsetLeft),
            y: Math.floor(entry.target.offsetTop),
            width: Math.floor(box.width),
            height: Math.floor(box.height),
          })*/
        }
      }
    })

    resizeObserver.observe(size_to_el)
  }

  return view
}

function window_events() {
  let current_wc = remote.getCurrentWebContents()
  current_wc.on("new-window", (event, url) => {
    event.preventDefault()
    console.log("caught new-window", url, event)
    event.newGuest = null
    open_in_tab(url)
    return false
  })

  current_wc.on("will-navigate", (event, url) => {
    event.preventDefault()
    console.log("caught will-navigate", url, event)
    open_in_tab(url)
    return false
  })
}

function webtab_comms() {
  let addtab_button = document.querySelector("#addtab")
  addtab_button.addEventListener("click", (x) => {
    let tab_content = document.querySelector("#tab_content")
    new_webtab(tab_content)
  })

  ipcRenderer.on("mark_selected", mark_selected)
  ipcRenderer.on("update_story", update_story)
  ipcRenderer.on("show_filter", show_filter)
  ipcRenderer.on("add_filter", add_filter)
  ipcRenderer.on("subscribe_to_change", subscribe_to_change)
  ipcRenderer.on("page-title-updated", update_title)
  ipcRenderer.on("detaching", detaching)
  ipcRenderer.on("open_in_new_tab", open_in_new_tab_event)
  ipcRenderer.on("update-target-url", show_target_url)

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

  window.addEventListener("beforeunload", (x) => {
    ipcRenderer.removeListener("mark_selected", mark_selected)
    ipcRenderer.removeListener("update_story", update_story)
    ipcRenderer.removeListener("show_filter", show_filter)
    ipcRenderer.removeListener("add_filter", add_filter)
    ipcRenderer.removeListener("subscribe_to_change", subscribe_to_change)
    ipcRenderer.removeListener("fullscreen", fullscreen.set)
    ipcRenderer.removeListener("page-title-updated", update_title)
    ipcRenderer.removeListener("open_in_new_tab", open_in_new_tab_event)

    //TODO: remove presenter listeners
  })

  function open_in_new_tab_event(event, url) {
    open_in_new_tab(url)
  }

  function detaching(event) {
    console.log("detaching", event)
    remove_tab_el(event.senderId)
  }

  function show_filter(event, data) {
    filters.show_filter(data)
  }

  function add_filter(event, data) {
    filters.add_filter(data)
  }

  function update_story(event, data) {
    story_loader.story_map.update_story(data.href, data.path, data.value)
  }

  let subscribers = []

  function subscribe_to_change(event, data) {
    if (data.wc_id && !subscribers.includes(data.wc_id)) {
      console.debug("subscribe_to_change", data)
      subscribers.push(data.wc_id)
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

    let tab_el = tab_el_from_id(event.senderId)
    if (tab_el) {
      tab_el.dataset.href = href
    }

    const { mark_selected } = require("./view/StoryList")
    let story = mark_selected(null, href)

    if (href == "about:gone") {
      return
    }
    //ipcRenderer.sendTo
    send_to_id(event.senderId, "update_selected", story, colors)
  }

  function update_title(event, title) {
    let sender_tab = tab_el_from_id(event.senderId)
    console.log(event.senderId, title, sender_tab)
    if (sender_tab) {
      sender_tab.innerText = title.substring(0, 22)
      sender_tab.title = title
    }
  }

  document.ondragover = (x) => {
    x.preventDefault()
    console.debug("ondragover", x)
    document.body.style.background = "red"
  }

  document.ondragleave = (x) => {
    console.debug("ondragleave", x)
    document.body.style.background = ""
  }

  document.addEventListener("drop", (x) => {
    document.body.style.background = ""
    x.preventDefault()
    console.debug("ondrop", x)

    console.log(
      "ondrop",
      "text/html",
      x.dataTransfer.getData("text/html"),
      "tab_drop",
      x.dataTransfer.getData("tab_drop"),
      "text",
      x.dataTransfer.getData("text")
    )

    let tap_drop = x.dataTransfer.getData("tab_drop")
    if (tap_drop && tap_drop.startsWith("{")) {
      try {
        let tab_info = JSON.parse(tap_drop)
        add_tab(tab_info)
        return
      } catch (e) {
        console.error("ondrop", "thought it was an tap_drop, but it wasn't", e)
      }
    }

    let text = x.dataTransfer.getData("text")
    if (text && (text.startsWith("https://") || text.startsWith("https://"))) {
      try {
        let url = new URL(text)
        open_in_new_tab(url.toString())
      } catch (e) {
        console.error("ondrop", "thought it was an URL, but it wasn't", e)
      }
    }

    let view_id = parseInt(x.dataTransfer.getData("text"))
    let tab_cnt = document.querySelector("#tab_content")
    if (!view_id || isNaN(view_id)) {
      return
    }

    attach_webtab(tab_cnt, view_id)
  })
}

function send_to_id(id, channel, ...args) {
  if (typeof id != "number") {
    id = parseInt(id)
    if (isNaN(id) || id < 0) {
      console.error("unusable id", id)
      return
    }
  }

  args = [...args].map((x) => {
    if (typeof x == "object") {
      x = JSON.parse(JSON.stringify(x))
    }
    return x
  })

  ipcRenderer.sendTo(id, channel, ...args)
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

function send_to_new_tab(name, value) {
  let tab_cnt = document.querySelector("#tab_content")
  if (tab_cnt) {
    //creating new webtab
    let view = new_webtab(tab_cnt)
    view.webContents.once("did-finish-load", (x) => {
      view.webContents.send(name, value)
    })
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
  send_to_new_tab(name, value)
}

function open_in_tab(href) {
  //do we need to start looking at target dingens?
  let is_in_tab =
    document.querySelector("#webtab") && document.querySelector("#webview")
  if (is_in_tab) {
    webtab.open_in_webview(href)
  } else {
    send_or_create_tab("open_in_webview", href)
  }
}

function open_in_new_tab(href) {
  send_to_new_tab("open_in_webview", href)
}
