module.exports = {
  story_sources,
  get_filterlist,
  save_filterlist,
  get_readlist,
  save_readlist,
  get_starlist,
  save_starlist,
  init,
}

const default_sources = [
  "https://news.ycombinator.com/",
  "https://news.ycombinator.com/news?p=2",
  "https://news.ycombinator.com/news?p=3",
  "https://lobste.rs/",
  "https://old.reddit.com/r/netsec/.rss",
]

let syncHandler
let once_db

const { remote } = require("electron")

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

  theme_select.addEventListener("change", (x) => {
    save_theme(theme_select.value)
  })

  restore_animation_settings()
  anim_checkbox.addEventListener("change", (x) => {
    save_animation(anim_checkbox.checked)
  })

  reset_couch_settings()
  couch_input.parentElement
    .querySelector('input[value="save"]')
    .addEventListener("click", save_couch_settings)
  couch_input.parentElement
    .querySelector('input[value="cancel"]')
    .addEventListener("click", reset_couch_settings)

  set_sources_area()

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

  filter_area.parentElement
    .querySelector('input[value="save"]')
    .addEventListener("click", save_filter_settings)
  filter_area.parentElement
    .querySelector('input[value="cancel"]')
    .addEventListener("click", set_filter_area)

  filter_area.addEventListener("keydown", (e) => {
    if (e.keyCode === 27) {
      //ESC
      set_filter_area()
    } else if ((e.key = "s" && e.ctrlKey)) {
      //CTRL + s
      save_filter_settings()
    }
  })
}

function restore_theme_settings() {
  pouch_get("theme", "light").then((x) => {
    theme_select.value = x
    set_theme(x)
  })
}

function save_theme(name) {
  pouch_set("theme", name, console.log)
  set_theme(name)
}

function restore_animation_settings() {
  pouch_get("animation", true).then((checked) => {
    anim_checkbox.checked = checked
    set_animation(checked)
  })
}

function save_animation(checked) {
  pouch_set("animation", checked, console.log)
  anim_checkbox.checked = checked
  set_animation(checked)
}

function set_animation(checked) {
  if (checked) {
    document.body.classList.add("animated")
  } else {
    document.body.classList.remove("animated")
  }
}

function set_theme(name) {
  switch (name) {
    case "dark":
      remote.nativeTheme.themeSource = "dark"
      break
    case "light":
      remote.nativeTheme.themeSource = "light"
      break
    case "custom":
      break
    case "system":
      remote.nativeTheme.themeSource = "system"
      break
  }
}

function update_on_change(event) {
  console.log("pouch change", event)
  if (event.direction == "pull") {
    event.change.docs.forEach((doc) => {
      console.log("update", doc._id)
      switch (doc._id) {
        case "read_list":
          stories.refilter()
          break
        case "story_sources":
          set_sources_area()
          stories.reload()
          break
        case "filter_list":
          set_filter_area()
          stories.refilter()
          break
        case "star_list":
          stories.restar()
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

function couchdb_sync(couchdb_url) {
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
    .on("error", (err) => {
      console.log("pouch err", err)
    })
    .on("complete", (info) => {
      console.log("pouch sync stopped", info)
    })
}

function save_couch_settings() {
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
  couch_input.value = get_couch_settings()
}

async function pouch_get(id, fallback) {
  return once_db
    .get(id)
    .then((doc) => {
      return doc.list
    })
    .catch((err) => {
      console.log("pouch_get err", err)
      if (err.status == 404) {
        once_db.put({
          _id: id,
          list: fallback,
        })
      }
      return fallback
    })
}

async function story_sources() {
  return pouch_get("story_sources", default_sources)
}

async function set_sources_area() {
  sources_area.value = (await story_sources()).join("\n")
}

async function save_sources_settings() {
  let story_sources = sources_area.value.split("\n").filter((x) => {
    return x.trim() != ""
  })

  pouch_set("story_sources", story_sources, stories.reload)
}

async function set_filter_area() {
  filter_area.value = (await get_filterlist()).join("\n")
}

function save_filter_settings() {
  let filter_list = filter_area.value.split("\n").filter((x) => {
    return x.trim() != ""
  })
  save_filterlist(filter_list)
  stories.refilter()
}

function get_readlist() {
  return pouch_get("read_list", [])
}

function get_filterlist() {
  return pouch_get("filter_list", default_filterlist)
}

async function pouch_set(id, value, callback) {
  once_db
    .get(id)
    .then((doc) => {
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

async function save_filterlist(filter_list) {
  pouch_set("filter_list", filter_list, (x) => {
    stories.refilter()
    set_filter_area()
  })
}

async function save_readlist(readlist, callback) {
  pouch_set("read_list", readlist, callback)
}

async function get_starlist() {
  return pouch_get("star_list", {})
}

async function save_starlist(readlist, callback) {
  pouch_set("star_list", readlist, callback)
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
