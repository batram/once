import * as PouchDB from "pouchdb"
import { ipcMain, ipcRenderer, webContents, nativeTheme } from "electron"
import { StoryMap } from "./data/StoryMap"
import { Story } from "./data/Story"
import * as fs from "fs"

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

  static remote = {
    story_sources(): Promise<string[]> {
      return ipcRenderer.invoke("inv_settings", "story_sources")
    },
    get_sync_url(): Promise<string> {
      return ipcRenderer.invoke("inv_settings", "get_sync_url")
    },
    set_sync_url(url: string): Promise<string> {
      return ipcRenderer.invoke("inv_settings", "set_sync_url", url)
    },
    get_filterlist(): Promise<string[]> {
      return ipcRenderer.invoke("inv_settings", "get_filterlist")
    },
    pouch_get<T>(id: string, fallback_value: T): Promise<T> {
      return ipcRenderer.invoke("inv_settings", "pouch_get", id, fallback_value)
    },
    getAttachment(id: string, key: string): Promise<string> {
      return ipcRenderer.invoke("inv_settings", "getAttachment", id, key)
    },
  }

  subscribers: webContents[] = []
  animated = true

  constructor() {
    OnceSettings.instance = this
    this.once_db = new PouchDB(global.paths.pouchdb_path)
    const sync_url = this.get_sync_url()
    console.log("sync_url", sync_url)

    if (sync_url) {
      this.couchdb_sync(sync_url)
    }

    this.get_stories().then((stories) => {
      StoryMap.instance.set_initial_stories(stories)
    })

    this.pouch_get("animation", true).then((animated) => {
      this.animated = animated
    })

    ipcMain.handle("inv_settings", async (event, cmd, ...args: unknown[]) => {
      switch (cmd) {
        case "story_sources":
          return this.story_sources()
        case "get_sync_url":
          return this.get_sync_url()
        case "set_sync_url":
          return this.set_sync_url(args[0] as string)
        case "get_filterlist":
          return this.get_filterlist()
        case "pouch_get":
          return this.pouch_get(args[0] as string, args[1])
        case "getAttachment": {
          const tat = this.once_db.getAttachment(
            args[0] as string,
            args[1] as string
          )
          console.log("getAttachment", args[0], args[1], tat)
          return tat
        }
        default:
          console.log("unhandled inv_settings", cmd)
      }
    })

    ipcMain.on("settings", async (event, cmd, ...args: unknown[]) => {
      switch (cmd) {
        case "subscribe_to_changes":
          if (!this.subscribers.includes(event.sender)) {
            this.subscribers.push(event.sender)
          }
          break
        case "set_theme":
          nativeTheme.themeSource = args[0] as "system" | "light" | "dark"
          break
        case "pouch_set":
          console.log("pouch_set", args[0], args[1])
          event.returnValue = await this.pouch_set(
            args[0] as string,
            args[1],
            console.log
          )
          break
        case "sync_url": {
          this.set_sync_url(args[0] as string)
          break
        }
        case "save_filterlist":
          event.returnValue = await this.save_filterlist(args[0] as string[])
          break
        case "add_filter":
          this.add_filter(args[0] as string)
          break
        default:
          console.log("unhandled settings", cmd)
          event.returnValue = null
      }
    })

    this.once_db
      .changes({
        since: "now",
        live: true,
        include_docs: true,
      })
      .on("change", (change) => {
        this.subscribers.forEach((subscriber) => {
          if (subscriber.isDestroyed()) {
            return
          }
          if (change.id.startsWith("sto_") && change.doc) {
            const changed_story = Story.from_obj(change.doc)
            const stored = StoryMap.instance.get(changed_story.href)
            if (!stored || !stored._rev || stored._rev != change.doc._rev) {
              StoryMap.instance.set(
                changed_story.href,
                Story.from_obj(change.doc)
              )
            }
          } else {
            switch (change.id) {
              case "story_sources":
                subscriber.send("settings", "set_sources_area")
                subscriber.send("story_list", "reload")
                break
              case "filter_list":
                subscriber.send("settings", "set_filter_area")
                subscriber.send("story_list", "refilter")
                break
              case "theme":
                subscriber.send("settings", "restore_theme_settings")
                break
              case "animation":
                this.animated = change.doc.list as boolean
                subscriber.send("settings", "restore_animation_settings")
            }
          }
        })

        console.log("changes", change.id)
      })
  }

  set_sync_url(sync_url: string): void {
    const old_url = this.get_sync_url()
    if (sync_url != old_url) {
      fs.mkdirSync(global.paths.nosync_path, { recursive: true })
      fs.writeFileSync(global.paths.sync_url_file, sync_url)
      this.couchdb_sync(sync_url)
    }
  }

  get_sync_url(): string {
    if (fs.existsSync(global.paths.sync_url_file)) {
      return fs.readFileSync(global.paths.sync_url_file, "utf8")
    } else {
      return ""
    }
  }

  update_on_change(
    event: PouchDB.Replication.SyncResult<Record<string, unknown>>
  ): void {
    if (event.direction == "pull") {
      event.change.docs.forEach((doc) => {
        console.debug("update", doc._id)
      })
    }
  }

  couchdb_sync(couchdb_url: string): void {
    const sync_ops = {
      live: true,
      retry: true,
      batch_size: 100,
    }
    if (this.syncHandler) {
      this.syncHandler.cancel()
    }

    this.once_db.replicate
      .from(couchdb_url)
      .on("complete", (info) => {
        console.log("complete info replicate", info)
        this.syncHandler = this.once_db.sync(couchdb_url, sync_ops)
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
          .on("denied", (err: Error) => {
            console.error("pouch denied", err)
          })
          .on("paused", () => {
            console.error("pouch paused")
          })
      })
      .on("error", (e: Error) => {
        console.error("pouch sync error", e)
      })
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

  get_filterlist(): Promise<string[]> {
    return this.pouch_get("filter_list", this.default_filterlist)
  }

  story_id(url: string): string {
    return "sto_" + url
  }

  async get_stories(): Promise<Story[]> {
    const response = await this.once_db.allDocs({
      include_docs: true,
      startkey: this.story_id("h"),
      endkey: this.story_id("i"),
    })

    return response.rows.map((entry) => {
      return Story.from_obj(entry.doc)
    })
  }

  async get_story(url: string): Promise<Story> {
    return this.once_db
      .get(this.story_id(url))
      .then((doc: unknown) => {
        return doc as Story
      })
      .catch((err) => {
        console.error("get_story err", err)
        return null
      })
  }

  async save_story(story: Story): Promise<Story> {
    if (story._attachments) {
      for (const i in story._attachments) {
        if (story._attachments[i].raw_content) {
          story._attachments[i].data = Buffer.from(
            story._attachments[i].raw_content
          ).toString("base64")
        }
      }
    }
    const resp = await this.once_db
      .get(this.story_id(story.href))
      .then((doc) => {
        story._id = doc._id
        story._rev = doc._rev
        return this.once_db.put(story.to_obj())
      })
      .catch((err) => {
        if (err.status == 404) {
          story._id = this.story_id(story.href)
          story.ingested_at = Date.now()
          return this.once_db.put(story.to_obj())
        } else {
          console.error("pouch_set error:", err)
        }
      })

    if (resp && (resp as PouchDB.Core.Response).rev) {
      story._rev = resp.rev
    }
    return story
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

  async add_filter(filter: string): Promise<void> {
    const filter_list = await this.get_filterlist()
    filter_list.push(filter)
    this.save_filterlist(filter_list)
  }

  async save_filterlist(filter_list: string[]): Promise<void> {
    this.pouch_set("filter_list", filter_list, console.log)
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
