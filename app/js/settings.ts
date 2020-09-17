export {
  story_sources,
  get_filterlist,
  save_filterlist,
  get_readlist,
  save_readlist,
  get_starlist,
  save_starlist,
  init,
}

import * as PouchDB from "pouchdb"
const story_list = require("./view/StoryList")
import { ipcRenderer } from "electron"

const default_sources = [
  "https://news.ycombinator.com/",
  "https://news.ycombinator.com/news?p=2",
  "https://news.ycombinator.com/news?p=3",
  "https://lobste.rs/",
  "https://old.reddit.com/r/netsec/.rss",
]

let syncHandler: PouchDB.Replication.Sync<any>
let once_db: PouchDB.Database<{}>

function init() {
  once_db = new PouchDB(".once_db")

  let couchdb_url = get_couch_settings()
  if (couchdb_url != "") {
    couchdb_sync(couchdb_url)
  }
  restore_theme_settings()
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e) => {
      console.log("system theme change", e)
    })

  let theme_select = document.querySelector<HTMLSelectElement>("#theme_select")
  theme_select.addEventListener("change", (x) => {
    save_theme(theme_select.value)
  })

  let anim_checkbox = document.querySelector<HTMLInputElement>("#theme_select")
  restore_animation_settings()
  anim_checkbox.addEventListener("change", (x) => {
    save_animation(anim_checkbox.checked)
  })

  let couch_input = document.querySelector<HTMLInputElement>("#couch_input")
  reset_couch_settings()
  couch_input.parentElement
    .querySelector('input[value="save"]')
    .addEventListener("click", save_couch_settings)
  couch_input.parentElement
    .querySelector('input[value="cancel"]')
    .addEventListener("click", reset_couch_settings)

  set_sources_area()

  let sources_area = document.querySelector<HTMLInputElement>("#sources_area")
  sources_area.parentElement
    .querySelector('input[value="save"]')
    .addEventListener("click", save_sources_settings)
  sources_area.parentElement
    .querySelector('input[value="cancel"]')
    .addEventListener("click", set_sources_area)

  sources_area.addEventListener("keydown", (e) => {
    if (e.keyCode === 27) {
      //ESC
      set_sources_area()
    } else if (e.key == "s" && e.ctrlKey) {
      //CTRL + s
      save_sources_settings()
    }
  })

  set_filter_area()

  let filter_area = document.querySelector<HTMLInputElement>("#filter_area")
  filter_area.parentElement
    .querySelector('input[value="save"]')
    .addEventListener("click", save_filter_settings)
  filter_area.parentElement
    .querySelector('input[value="cancel"]')
    .addEventListener("click", set_filter_area)

  filter_area.addEventListener("keydown", (e) => {
    console.log("filter_area", e)
    if (e.keyCode === 27) {
      //ESC
      set_filter_area()
    } else if (e.key == "s" && e.ctrlKey) {
      //CTRL + s
      save_filter_settings()
    }
  })
}

function restore_theme_settings() {
  pouch_get("theme", "light").then((x) => {
    let theme_select = document.querySelector<HTMLSelectElement>(
      "#theme_select"
    )
    theme_select.value = x
    set_theme(x)
  })
}

function save_theme(name: string) {
  pouch_set("theme", name, console.log)
  set_theme(name)
}

function restore_animation_settings() {
  pouch_get("animation", true).then((checked) => {
    let anim_checkbox = document.querySelector<HTMLInputElement>(
      "#theme_select"
    )
    anim_checkbox.checked = checked
    set_animation(checked)
  })
}

function save_animation(checked: boolean) {
  pouch_set("animation", checked, console.log)
  let anim_checkbox = document.querySelector<HTMLInputElement>("#theme_select")
  anim_checkbox.checked = checked
  set_animation(checked)
}

function set_animation(checked: boolean) {
  if (checked) {
    document.body.classList.add("animated")
  } else {
    document.body.classList.remove("animated")
  }
}

function set_theme(name: string) {
  switch (name) {
    case "dark":
      ipcRenderer.send("theme", "dark")
      break
    case "light":
      ipcRenderer.send("theme", "dark")
      break
    case "custom":
      console.log("custom theme, not implement, just hanging out here :D")
      break
    case "system":
      ipcRenderer.send("theme", "system")
      break
  }
}

function update_on_change(event: PouchDB.Replication.SyncResult<any>) {
  console.log("pouch change", event)
  if (event.direction == "pull") {
    event.change.docs.forEach((doc) => {
      console.log("update", doc._id)
      switch (doc._id) {
        case "read_list":
          story_list.refilter()
          break
        case "story_sources":
          set_sources_area()
          story_list.reload()
          break
        case "filter_list":
          set_filter_area()
          story_list.refilter()
          break
        case "star_list":
          story_list.restar()
          break
        case "theme":
          restore_theme_settings()
          break
        case "animation":
          restore_animation_settings()
      }
    })
  }
}

function couchdb_sync(couchdb_url: string) {
  var remoteDB = new PouchDB(couchdb_url)
  if (syncHandler) {
    syncHandler.cancel()
  }
  syncHandler = once_db.sync(remoteDB, {
    live: true,
    retry: true,
  })

  syncHandler
    .on("change", update_on_change)
    .on("complete", (info) => {
      console.log("pouch sync stopped", info)
    })

    .on("error", (err: Error) => {
      console.log("pouch err", err)
    })
}

function save_couch_settings() {
  let couch_input = document.querySelector<HTMLInputElement>("#couch_input")
  let couchdb_url = couch_input.value
  if (get_couch_settings() != couchdb_url) {
    couchdb_sync(couchdb_url)
    localStorage.setItem("couch_url", couchdb_url)
  }
}

function get_couch_settings() {
  let couch_url = localStorage.getItem("couch_url")
  if (couch_url == null) {
    couch_url = ""
  }
  return couch_url
}

function reset_couch_settings() {
  let couch_input = document.querySelector<HTMLInputElement>("#couch_input")
  couch_input.value = get_couch_settings()
}

async function pouch_get(id: string, fallback_value: Exclude<any, Function>) {
  return once_db
    .get(id)
    .then((doc: any) => {
      return doc.list
    })
    .catch((err) => {
      console.log("pouch_get err", err)
      if (err.status == 404) {
        once_db.put({
          _id: id,
          list: fallback_value,
        })
      }
      return fallback_value
    })
}

async function story_sources() {
  return pouch_get("story_sources", default_sources)
}

async function set_sources_area() {
  let sources_area = document.querySelector<HTMLInputElement>("#sources_area")
  sources_area.value = (await story_sources()).join("\n")
}

async function save_sources_settings() {
  let sources_area = document.querySelector<HTMLInputElement>("#sources_area")
  let story_sources = sources_area.value.split("\n").filter((x) => {
    return x.trim() != ""
  })

  pouch_set("story_sources", story_sources, story_list.reload)
}

async function set_filter_area() {
  let filter_area = document.querySelector<HTMLInputElement>("#filter_area")
  filter_area.value = (await get_filterlist()).join("\n")
}

function save_filter_settings() {
  let filter_area = document.querySelector<HTMLInputElement>("#filter_area")
  let filter_list = filter_area.value.split("\n").filter((x) => {
    return x.trim() != ""
  })
  save_filterlist(filter_list)
  story_list.refilter()
}

function get_readlist() {
  return pouch_get("read_list", [])
}

function get_filterlist(): Promise<string[]> {
  return pouch_get("filter_list", default_filterlist)
}

async function pouch_set(id: string, value: any, callback: Function) {
  once_db
    .get(id)
    .then((doc: any) => {
      doc.list = value
      return once_db.put(doc)
    })
    .then((x) => {
      callback()
    })
    .catch((err) => {
      if (err.status == 404) {
        //create if id don't exist
        once_db
          .put({
            _id: id,
            list: value,
          })
          .then((x) => {
            callback()
          })
      } else {
        console.log("pouch_set error:", err)
      }
    })
}

async function save_filterlist(filter_list: string[]) {
  pouch_set("filter_list", filter_list, () => {
    story_list.refilter()
    set_filter_area()
  })
}

async function save_readlist(readlist: string[], callback: Function) {
  pouch_set("read_list", readlist, callback)
}

async function get_starlist() {
  return pouch_get("star_list", {})
}

async function save_starlist(starlist: string[], callback: Function) {
  pouch_set("star_list", starlist, callback)
}

let default_filterlist = `bbc.co.uk
bbc.com
bloomberg.com
brave.com
buzzfeed.com
cnbc.com
cnn.com
dw.com
forbes.com
fortune.com
foxnews.com
hbr.org
latimes.com
mercurynews.com
mozilla.org
newyorker.com
npr.org
nytimes.com
rarehistoricalphotos.com
reuters.com
sfchronicle.com
sfgate.com
slate.com
techcrunch.com
theatlantic.com
thedailybeast.com
thedrive.com
theguardian.com
thetimes.co.uk
theverge.com
vice.com
vox.com
washingtonpost.com
wired.com
wsj.com
yahoo.com`
  .split("\n")
  .map((x) => x.trim())
