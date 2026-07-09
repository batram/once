import PouchDB from "pouchdb-browser"
import { StoryMap } from "./data/StoryMap"
import { Story } from "./data/Story"
import { Redirect, URLRedirect } from "./data/URLRedirect"
import * as StoryList from "./view/StoryList"
import { SettingsPanel } from "./view/SettingsPanel"

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

  subscribers: Number[] = []
  animated = true

  constructor() {
    OnceSettings.instance = this
    this.once_db = new PouchDB("once_db")
    /*
    this.get_stories().then((stories) => {
      console.log("init stories", stories.length)
      StoryMap.instance.set_initial_stories(stories)
    })*/

    this.get_sync_url().then((x) => {
      if (x) {
        console.log("sync_url", x)
        this.couchdb_sync(x)
      }
    })

    this.pouch_get("animation", true).then((animated) => {
      this.animated = animated
    })

    //URLRedirect.init()

    this.once_db
      .changes({
        since: "now",
        live: true,
        include_docs: true,
      })
      .on("change", (change) => {
        console.log("pouch change", change.id, change)

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
              console.debug("change sto source", change)
              SettingsPanel.instance.set_sources_area()
              StoryList.reload()
              break
            case "filter_list":
              SettingsPanel.instance.set_filter_area()
              StoryList.refilter()
              break
            case "redirect_list":
              SettingsPanel.instance.set_redirect_area()
              break
            case "theme":
              SettingsPanel.instance.restore_theme_settings()
              break
            case "animation":
              this.animated = change.doc.list as boolean
              SettingsPanel.instance.restore_animation_settings()
          }
        }
      })
  }

  async set_sync_url(sync_url: string): Promise<void> {
    const old_url = await this.get_sync_url()
    console.log("set_sync_url", sync_url, old_url)
    if (sync_url != old_url) {
      chrome.storage.sync.set({ sync_url: sync_url })
      //fs.mkdirSync(global.paths.nosync_path, { recursive: true })
      //fs.writeFileSync(global.paths.sync_url_file, sync_url)
      this.couchdb_sync(sync_url)
    }
  }

  async get_sync_url(): Promise<string> {
    let data = await chrome.storage.sync.get("sync_url")
    return data ? data.sync_url : ""
  }

  async set_cache_time(cache_time: string): Promise<void> {
    let ct = parseInt(cache_time)
    const old_time = await this.get_cache_time()
    console.log("set_cache_time", ct, old_time)
    if (!Number.isNaN(ct) && ct != old_time) {
      chrome.storage.sync.set({ cache_time: cache_time })
    }
  }

  async get_cache_time(): Promise<number> {
    let data = await chrome.storage.sync.get("cache_time")
    let time = parseInt(data.cache_time)
    return data && !Number.isNaN(time) ? time : 120
  }

  update_on_change(
    event: PouchDB.Replication.SyncResult<Record<string, unknown>>
  ): void {
    console.log("chagne db", event)
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
        if (!this.syncHandler) {
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
              console.info("pouch paused")
            })
        }
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

  async grouped_story_sources(): Promise<Record<string, string[]>> {
    const story_sources = await this.story_sources()
    const grouped_sources: Record<string, string[]> = {
      default: [],
    }
    let current_group = "default"
    story_sources.forEach((source_entry) => {
      if (/^\*(.*)$/.test(source_entry)) {
        current_group = source_entry.replace(/^\*/, "")
        grouped_sources[current_group] = []
      } else {
        grouped_sources[current_group].push(source_entry)
      }
    })

    return grouped_sources
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
        return Story.from_obj(doc as Story)
      })
      .catch((err: any) => {
        console.error("get_story err", err)
        return null
      })
  }

  async save_story(story: Story): Promise<Story> {
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

  get_filterlist(): Promise<string[]> {
    return this.pouch_get("filter_list", this.default_filterlist)
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

  get_redirectlist(): Promise<Redirect[]> {
    return this.pouch_get("redirect_list", this.default_redirectlist)
  }

  async save_redirectlist(redirect_list: Redirect[]): Promise<void> {
    this.pouch_set("redirect_list", redirect_list, console.log)
  }

  static parse_redirectlist(lines: string): Redirect[] {
    return lines.split("\n").map((line) => {
      const split = line.trim().split(" => ")
      return { match_url: split[0], replace_url: split[1] }
    })
  }

  static present_redirectlist(redirect_list: Redirect[]): string {
    return redirect_list
      .map((entry) => entry.match_url + " => " + entry.replace_url)
      .join("\n")
  }

  default_redirectlist =
    OnceSettings.parse_redirectlist(`https:\\/\\/www.reddit.com\\/(.*) => https://old.reddit.com/$1
         https:\\/\\/(mobile.)?twitter.com\\/(.*) => https://nitter.cc/$1`)
}
