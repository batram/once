import * as PouchDB from "pouchdb-browser"
import * as story_list from "./view/StoryList"
import { ipcRenderer } from "electron"
import { StoryMap } from "./data/StoryMap"
import { Story } from "./data/Story"

export interface StarList {
  [index: string]: Story | { stared: boolean; stored_star: boolean }
}

export class OnceSettings {
  default_sources = [
    "https://news.ycombinator.com/",
    "https://news.ycombinator.com/news?p=2",
    "https://news.ycombinator.com/news?p=3",
    "https://lobste.rs/",
    "https://old.reddit.com/r/netsec/.rss",
  ]

  syncHandler: PouchDB.Replication.Sync<Record<string, unknown>>
  once_db: PouchDB.Database<Record<string, unknown>>
  static instance: OnceSettings

  constructor() {
    OnceSettings.instance = this
    this.once_db = new PouchDB(".once_db")

    const couchdb_url = this.get_couch_settings()
    if (couchdb_url != "") {
      this.couchdb_sync(couchdb_url)
    }
    this.restore_theme_settings()

    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", (e) => {
        console.debug("system theme change", e)
      })

    const theme_select = document.querySelector<HTMLSelectElement>(
      "#theme_select"
    )
    theme_select.addEventListener("change", () => {
      this.save_theme(theme_select.value)
    })

    const anim_checkbox = document.querySelector<HTMLInputElement>(
      "#anim_checkbox"
    )
    this.restore_animation_settings()
    anim_checkbox.addEventListener("change", () => {
      this.save_animation(anim_checkbox.checked)
    })

    const couch_input = document.querySelector<HTMLInputElement>("#couch_input")
    this.reset_couch_settings()
    couch_input.parentElement
      .querySelector('input[value="save"]')
      .addEventListener("click", () => {
        this.save_couch_settings()
      })
    couch_input.parentElement
      .querySelector('input[value="cancel"]')
      .addEventListener("click", () => {
        this.reset_couch_settings()
      })

    this.set_sources_area()

    const sources_area = document.querySelector<HTMLInputElement>(
      "#sources_area"
    )
    sources_area.parentElement
      .querySelector('input[value="save"]')
      .addEventListener("click", () => {
        this.save_sources_settings()
      })
    sources_area.parentElement
      .querySelector('input[value="cancel"]')
      .addEventListener("click", () => {
        this.set_sources_area()
      })

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

    const filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    filter_area.parentElement
      .querySelector('input[value="save"]')
      .addEventListener("click", () => {
        this.save_filter_settings()
      })
    filter_area.parentElement
      .querySelector("input[value=cancel]")
      .addEventListener("click", () => {
        this.set_filter_area()
      })

    filter_area.addEventListener("keydown", (e) => {
      if (e.keyCode === 27) {
        //ESC
        this.set_filter_area()
      } else if (e.key == "s" && e.ctrlKey) {
        //CTRL + s
        this.save_filter_settings()
      }
    })
  }

  restore_theme_settings(): void {
    this.pouch_get("theme", "system").then((theme_value: string) => {
      const theme_select = document.querySelector<HTMLSelectElement>(
        "#theme_select"
      )
      theme_select.value = theme_value
      this.set_theme(theme_value)
    })
  }

  save_theme(name: string): void {
    this.pouch_set("theme", name, console.debug)
    this.set_theme(name)
  }

  restore_animation_settings(): void {
    this.pouch_get("animation", true).then((checked: boolean) => {
      const anim_checkbox = document.querySelector<HTMLInputElement>(
        "#anim_checkbox"
      )
      anim_checkbox.checked = checked
      this.set_animation(checked)
    })
  }

  save_animation(checked: boolean): void {
    this.pouch_set("animation", checked, console.debug)
    const anim_checkbox = document.querySelector<HTMLInputElement>(
      "#anim_checkbox"
    )
    anim_checkbox.checked = checked
    this.set_animation(checked)
  }

  set_animation(checked: boolean): void {
    document.body.setAttribute("animated", checked.toString())
  }

  set_theme(name: string): void {
    switch (name) {
      case "dark":
        ipcRenderer.send("theme", "dark")
        break
      case "light":
        ipcRenderer.send("theme", "light")
        break
      case "custom":
        console.debug("custom theme, not implement, just hanging out here :D")
        break
      case "system":
        ipcRenderer.send("theme", "system")
        break
    }
  }

  update_on_change(
    event: PouchDB.Replication.SyncResult<Record<string, unknown>>
  ): void {
    console.debug("pouch change", event)
    if (event.direction) {
      event.change.docs.forEach((doc) => {
        console.debug("update", doc._id)
        switch (doc._id) {
          case "read_list":
            StoryMap.instance.reread(doc.list as string[])
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
            StoryMap.instance.restar(doc.list as StarList)
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

  couchdb_sync(couchdb_url: string): void {
    const remoteDB = new PouchDB(couchdb_url)
    if (this.syncHandler) {
      this.syncHandler.cancel()
    }
    this.syncHandler = this.once_db.sync(remoteDB, {
      live: true,
      retry: true,
    })

    this.syncHandler
      .on("change", (event) => {
        this.update_on_change(event)
      })
      .on("complete", (info) => {
        console.debug("pouch sync stopped", info)
      })

      .on("error", (err: Error) => {
        console.error("pouch err", err)
      })
  }

  save_couch_settings(): void {
    const couch_input = document.querySelector<HTMLInputElement>("#couch_input")
    const couchdb_url = couch_input.value
    if (this.get_couch_settings() != couchdb_url) {
      this.couchdb_sync(couchdb_url)
      localStorage.setItem("couch_url", couchdb_url)
    }
  }

  get_couch_settings(): string {
    let couch_url = localStorage.getItem("couch_url")
    if (couch_url == null) {
      couch_url = ""
    }
    return couch_url
  }

  reset_couch_settings(): void {
    const couch_input = document.querySelector<HTMLInputElement>("#couch_input")
    couch_input.value = this.get_couch_settings()
  }

  async pouch_get<T>(id: string, fallback_value: T): Promise<T> {
    return this.once_db
      .get(id)
      .then((doc) => {
        return doc.list as T
      })
      .catch((err) => {
        console.error("pouch_get err", err)
        if (err.status == 404) {
          this.once_db.put({
            _id: id,
            list: fallback_value,
          })
        }
        return fallback_value
      })
  }

  async story_sources(): Promise<string[]> {
    return this.pouch_get("story_sources", this.default_sources)
  }

  async set_sources_area(): Promise<void> {
    const sources_area = document.querySelector<HTMLInputElement>(
      "#sources_area"
    )
    sources_area.value = (await this.story_sources()).join("\n")
  }

  async save_sources_settings(): Promise<void> {
    const sources_area = document.querySelector<HTMLInputElement>(
      "#sources_area"
    )
    const story_sources = sources_area.value.split("\n").filter((x) => {
      return x.trim() != ""
    })
    this.pouch_set("story_sources", story_sources, story_list.reload)
  }

  async set_filter_area(): Promise<void> {
    const filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    filter_area.value = (await this.get_filterlist()).join("\n")
  }

  save_filter_settings(): void {
    const filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    const filter_list = filter_area.value.split("\n").filter((x) => {
      return x.trim() != ""
    })
    this.save_filterlist(filter_list)
    story_list.refilter()
  }

  get_readlist(): Promise<string[]> {
    return this.pouch_get("read_list", [])
  }

  get_filterlist(): Promise<string[]> {
    return this.pouch_get("filter_list", this.default_filterlist)
  }

  async pouch_set<T>(
    id: string,
    value: T,
    callback: () => unknown
  ): Promise<void> {
    this.once_db
      .get(id)
      .then((doc) => {
        doc.list = value
        return this.once_db.put(doc)
      })
      .then(() => {
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
            .then(() => {
              callback()
            })
        } else {
          console.error("pouch_set error:", err)
        }
      })
  }

  async save_filterlist(filter_list: string[]): Promise<void> {
    this.pouch_set("filter_list", filter_list, () => {
      story_list.refilter()
      this.set_filter_area()
    })
  }

  async save_readlist(
    readlist: string[],
    callback: () => unknown
  ): Promise<void> {
    this.pouch_set("read_list", readlist, callback)
  }

  async get_starlist(): Promise<StarList> {
    return this.pouch_get("star_list", {})
  }

  async save_starlist(
    starlist: StarList,
    callback: () => unknown
  ): Promise<void> {
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
