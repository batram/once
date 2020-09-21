import * as PouchDB from "pouchdb-browser"
import * as story_list from "./view/StoryList"
import { ipcRenderer } from "electron"
import { StoryMap } from "./data/StoryMap"

export class OnceSettings {
  default_sources = [
    "https://news.ycombinator.com/",
    "https://news.ycombinator.com/news?p=2",
    "https://news.ycombinator.com/news?p=3",
    "https://lobste.rs/",
    "https://old.reddit.com/r/netsec/.rss",
  ]

  syncHandler: PouchDB.Replication.Sync<any>
  once_db: PouchDB.Database<{}>
  static instance: OnceSettings

  constructor() {
    OnceSettings.instance = this
    this.once_db = new PouchDB(".once_db")

    let couchdb_url = this.get_couch_settings()
    if (couchdb_url != "") {
      this.couchdb_sync(couchdb_url)
    }
    this.restore_theme_settings()

    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", (e) => {
        console.log("system theme change", e)
      })

    let theme_select = document.querySelector<HTMLSelectElement>(
      "#theme_select"
    )
    theme_select.addEventListener("change", (x) => {
      this.save_theme(theme_select.value)
    })

    let anim_checkbox = document.querySelector<HTMLInputElement>(
      "#anim_checkbox"
    )
    this.restore_animation_settings()
    anim_checkbox.addEventListener("change", (x) => {
      this.save_animation(anim_checkbox.checked)
    })

    let couch_input = document.querySelector<HTMLInputElement>("#couch_input")
    this.reset_couch_settings()
    couch_input.parentElement
      .querySelector('input[value="save"]')
      .addEventListener("click", this.save_couch_settings)
    couch_input.parentElement
      .querySelector('input[value="cancel"]')
      .addEventListener("click", this.reset_couch_settings)

    this.set_sources_area()

    let sources_area = document.querySelector<HTMLInputElement>("#sources_area")
    sources_area.parentElement
      .querySelector('input[value="save"]')
      .addEventListener("click", this.save_sources_settings)
    sources_area.parentElement
      .querySelector('input[value="cancel"]')
      .addEventListener("click", this.set_sources_area)

    sources_area.addEventListener("keydown", (e) => {
      if (e.keyCode === 27) {
        //ESC
        this.set_sources_area()
      } else if (e.key == "s" && e.ctrlKey) {
        //CTRL + s
        this.save_sources_settings()
      }
    })

    this.set_filter_area()

    let filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    filter_area.parentElement
      .querySelector('input[value="save"]')
      .addEventListener("click", this.save_filter_settings)
    filter_area.parentElement
      .querySelector('input[value="cancel"]')
      .addEventListener("click", this.set_filter_area)

    filter_area.addEventListener("keydown", (e) => {
      console.log("filter_area", e)
      if (e.keyCode === 27) {
        //ESC
        this.set_filter_area()
      } else if (e.key == "s" && e.ctrlKey) {
        //CTRL + s
        this.save_filter_settings()
      }
    })
  }

  restore_theme_settings() {
    this.pouch_get("theme", "light").then((x) => {
      let theme_select = document.querySelector<HTMLSelectElement>(
        "#theme_select"
      )
      theme_select.value = x
      this.set_theme(x)
    })
  }

  save_theme(name: string) {
    this.pouch_set("theme", name, console.log)
    this.set_theme(name)
  }

  restore_animation_settings() {
    this.pouch_get("animation", true).then((checked) => {
      let anim_checkbox = document.querySelector<HTMLInputElement>(
        "#anim_checkbox"
      )
      anim_checkbox.checked = checked
      this.set_animation(checked)
    })
  }

  save_animation(checked: boolean) {
    this.pouch_set("animation", checked, console.log)
    let anim_checkbox = document.querySelector<HTMLInputElement>(
      "#anim_checkbox"
    )
    anim_checkbox.checked = checked
    this.set_animation(checked)
  }

  set_animation(checked: boolean) {
    document.body.setAttribute("animated", checked.toString())
  }

  set_theme(name: string) {
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

  update_on_change(event: PouchDB.Replication.SyncResult<any>) {
    console.log("pouch change", event)
    if (event.direction) {
      event.change.docs.forEach((doc) => {
        console.log("update", doc._id)
        switch (doc._id) {
          case "read_list":
            StoryMap.instance.reread(doc.list)
            break
          case "story_sources":
            this.set_sources_area()
            story_list.reload()
            break
          case "filter_list":
            this.set_filter_area()
            story_list.refilter()
            break
          case "star_list":
            StoryMap.instance.restar(doc.list)
            break
          case "theme":
            this.restore_theme_settings()
            break
          case "animation":
            this.restore_animation_settings()
        }
      })
    }
  }

  couchdb_sync(couchdb_url: string) {
    var remoteDB = new PouchDB(couchdb_url)
    if (this.syncHandler) {
      this.syncHandler.cancel()
    }
    this.syncHandler = this.once_db.sync(remoteDB, {
      live: true,
      retry: true,
    })

    this.syncHandler
      .on("change", this.update_on_change)
      .on("complete", (info) => {
        console.log("pouch sync stopped", info)
      })

      .on("error", (err: Error) => {
        console.log("pouch err", err)
      })
  }

  save_couch_settings() {
    let couch_input = document.querySelector<HTMLInputElement>("#couch_input")
    let couchdb_url = couch_input.value
    if (this.get_couch_settings() != couchdb_url) {
      this.couchdb_sync(couchdb_url)
      localStorage.setItem("couch_url", couchdb_url)
    }
  }

  get_couch_settings() {
    let couch_url = localStorage.getItem("couch_url")
    if (couch_url == null) {
      couch_url = ""
    }
    return couch_url
  }

  reset_couch_settings() {
    let couch_input = document.querySelector<HTMLInputElement>("#couch_input")
    couch_input.value = this.get_couch_settings()
  }

  async pouch_get(id: string, fallback_value: Exclude<any, Function>) {
    return this.once_db
      .get(id)
      .then((doc: any) => {
        return doc.list
      })
      .catch((err) => {
        console.log("pouch_get err", err)
        if (err.status == 404) {
          this.once_db.put({
            _id: id,
            list: fallback_value,
          })
        }
        return fallback_value
      })
  }

  async story_sources() {
    return this.pouch_get("story_sources", this.default_sources)
  }

  async set_sources_area() {
    let sources_area = document.querySelector<HTMLInputElement>("#sources_area")
    sources_area.value = (await this.story_sources()).join("\n")
  }

  async save_sources_settings() {
    let sources_area = document.querySelector<HTMLInputElement>("#sources_area")
    let story_sources = sources_area.value.split("\n").filter((x) => {
      return x.trim() != ""
    })

    this.pouch_set("story_sources", story_sources, story_list.reload)
  }

  async set_filter_area() {
    let filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    filter_area.value = (await this.get_filterlist()).join("\n")
  }

  save_filter_settings() {
    let filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    let filter_list = filter_area.value.split("\n").filter((x) => {
      return x.trim() != ""
    })
    this.save_filterlist(filter_list)
    story_list.refilter()
  }

  get_readlist() {
    return this.pouch_get("read_list", [])
  }

  get_filterlist(): Promise<string[]> {
    return this.pouch_get("filter_list", this.default_filterlist)
  }

  async pouch_set(id: string, value: any, callback: Function) {
    this.once_db
      .get(id)
      .then((doc: any) => {
        doc.list = value
        return this.once_db.put(doc)
      })
      .then((x) => {
        callback()
      })
      .catch((err) => {
        if (err.status == 404) {
          //create if id don't exist
          this.once_db
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

  async save_filterlist(filter_list: string[]) {
    this.pouch_set("filter_list", filter_list, () => {
      story_list.refilter()
      this.set_filter_area()
    })
  }

  async save_readlist(readlist: string[], callback: Function) {
    this.pouch_set("read_list", readlist, callback)
  }

  async get_starlist() {
    return this.pouch_get("star_list", {})
  }

  async save_starlist(starlist: string[], callback: Function) {
    this.pouch_set("star_list", starlist, callback)
  }

  default_filterlist = `bbc.co.uk
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
}
