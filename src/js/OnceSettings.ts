import PouchDB from "pouchdb-browser"
import { StoryMap } from "./data/StoryMap"
import { Story } from "./data/Story"
import { Redirect, URLRedirect } from "./data/URLRedirect"
//import * as fs from "fs"
import { BackComms } from "./data/BackComms"
import { SettingsPanel } from "./view/SettingsPanel"
import {
  defaultFilterList,
  defaultRedirectList,
  defaultSources,
  groupStorySources,
  parseRedirectList,
  presentRedirectList
} from "@once/core"
import {
  setDocumentTheme,
  ThemeName,
  WebExtSyncStorage
} from "@once/platform-webext"
import { PouchListStore, PouchStoryStore } from "@once/persistence"

export class OnceSettings {
  default_sources = defaultSources

  syncHandler: PouchDB.Replication.Sync<Record<string, unknown>>
  once_db: PouchDB.Database<Record<string, unknown>>
  listStore: PouchListStore
  storyStore: PouchStoryStore<Story>
  syncStorage = new WebExtSyncStorage()
  static instance: OnceSettings

  static remote = {
    grouped_story_sources(): Promise<Record<string, string[]>> {
      return BackComms.invoke("inv_settings", "grouped_story_sources")
    },
    story_sources(): Promise<string[]> {
      return BackComms.invoke("inv_settings", "story_sources")
    },
    get_sync_url(): Promise<string> {
      return BackComms.invoke("inv_settings", "get_sync_url")
    },
    set_sync_url(url: string): Promise<string> {
      return BackComms.invoke("inv_settings", "set_sync_url", url)
    },
    get_cache_time(): Promise<number> {
      return BackComms.invoke("inv_settings", "get_cache_time")
    },
    set_cache_time(cache_time: string): Promise<void> {
      return BackComms.invoke("inv_settings", "set_cache_time", cache_time)
    },
    get_filterlist(): Promise<string[]> {
      return BackComms.invoke("inv_settings", "get_filterlist")
    },
    get_redirectlist(): Promise<Redirect[]> {
      return BackComms.invoke("inv_settings", "get_redirectlist")
    },
    pouch_get<T>(id: string, fallback_value: T): Promise<T> {
      return BackComms.invoke("inv_settings", "pouch_get", id, fallback_value)
    },
    getAttachment(id: string, key: string): Promise<string> {
      return BackComms.invoke("inv_settings", "getAttachment", id, key)
    }
  }

  subscribers: number[] = []
  animated = true

  constructor() {
    OnceSettings.instance = this
    this.once_db = new PouchDB("once_db")
    this.listStore = new PouchListStore(this.once_db)
    this.storyStore = new PouchStoryStore(this.once_db, (story) =>
      Story.from_obj(story)
    )
    this.get_stories().then((stories) => {
      //console.log("init stories", stories.length, stories)
      StoryMap.instance.set_initial_stories(stories)
    })

    this.get_sync_url().then((x) => {
      if (x) {
        console.log("sync_url", x)
        this.couchdb_sync(x)
      }
    })

    this.pouch_get("animation", true).then((animated) => {
      this.animated = animated
    })

    // Initialize theme
    this.pouch_get("theme", "dark").then((theme) => {
      this.set_theme(theme as ThemeName)
    })

    URLRedirect.init()

    BackComms.handlex("inv_settings", this.handle)

    BackComms.on("settings", async (event, cmd, ...args: any[]) => {
      switch (cmd) {
        case "set_theme":
          this.set_theme(args[0] as ThemeName)
          break
        case "pouch_set":
          console.log("pouch_set", args[0], args[1])
          if (event)
            event.returnValue = await this.pouch_set(
              args[0] as string,
              args[1],
              console.log
            )
          break
        case "sync_url": {
          this.set_sync_url(args[0][0] as string)
          break
        }
        case "save_filterlist":
          if (event)
            event.returnValue = await this.save_filterlist(args[0] as string[])
          break
        case "save_redirectlist":
          if (event)
            event.returnValue = await this.save_redirectlist(
              args[0] as Redirect[]
            )
          break
        case "add_filter":
          this.add_filter(args[0] as string)
          break
        case "save_cache_time":
          if (event)
            event.returnValue = await this.set_cache_time(args[0] as string)
          break
        default:
          console.log("unhandled settings", cmd)
          if (event) event.returnValue = null
      }
    })

    this.once_db
      .changes({
        since: "now",
        live: true,
        include_docs: true
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
              BackComms.send("settings", "set_sources_area")
              BackComms.send("story_list", "reload")
              break
            case "filter_list":
              BackComms.send("settings", "set_filter_area")
              BackComms.send("story_list", "refilter")
              break
            case "redirect_list":
              BackComms.send("settings", "set_redirect_area")
              URLRedirect.init()
              break
            case "theme":
              BackComms.send("settings", "restore_theme_settings")
              break
            case "animation":
              this.animated = change.doc.list as boolean
              BackComms.send("settings", "restore_animation_settings")
          }
        }
      })
  }

  set_theme(theme: ThemeName): void {
    setDocumentTheme(theme)
  }

  async handle(_: any, cmd: string, ...args: any[]): Promise<any> {
    const argl = args[0]
    switch (cmd) {
      case "story_sources":
        return this.story_sources()
      case "grouped_story_sources":
        return this.grouped_story_sources()
      case "get_sync_url":
        return await this.get_sync_url()
      case "set_sync_url":
        return this.set_sync_url(argl[0] as string)
      case "get_cache_time":
        return await this.get_cache_time()
      case "set_cache_time":
        return this.set_cache_time(argl[0] as string)
      case "get_filterlist":
        return this.get_filterlist()
      case "get_redirectlist":
        return this.get_redirectlist()
      case "pouch_get":
        return this.pouch_get(argl[0] as string, argl[1])
      case "getAttachment": {
        const tat = this.once_db.getAttachment(
          argl[0] as string,
          argl[1] as string
        )
        console.log("getAttachment", argl[0], argl[1], tat)
        return tat
      }
      default:
        console.log("unhandled inv_settings", cmd)
    }
  }

  async set_sync_url(sync_url: string): Promise<void> {
    const old_url = await this.get_sync_url()
    console.log("set_sync_url", sync_url, old_url)
    if (sync_url != old_url) {
      await this.syncStorage.setSyncUrl(sync_url)
      this.couchdb_sync(sync_url)
    }
  }

  async get_sync_url(): Promise<string> {
    return this.syncStorage.getSyncUrl()
  }

  async set_cache_time(cache_time: string): Promise<void> {
    const ct = parseInt(cache_time)
    const old_time = await this.get_cache_time()
    console.log("set_cache_time", ct, old_time)
    if (!Number.isNaN(ct) && ct != old_time) {
      await this.syncStorage.setCacheTime(cache_time)
    }
  }

  async get_cache_time(): Promise<number> {
    return this.syncStorage.getCacheTime()
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
      batch_size: 100
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
    return this.listStore.get(id, fallback_value)
  }

  async story_sources(): Promise<string[]> {
    return this.pouch_get("story_sources", this.default_sources)
  }

  async grouped_story_sources(): Promise<Record<string, string[]>> {
    const story_sources = await this.story_sources()
    return groupStorySources(story_sources)
  }

  story_id(url: string): string {
    return this.storyStore.storyId(url)
  }

  async get_stories(): Promise<Story[]> {
    return this.storyStore.getStories()
  }

  async get_story(url: string): Promise<Story> {
    return this.storyStore.getStory(url)
  }

  async save_story(story: Story): Promise<Story> {
    return this.storyStore.saveStory(story)
  }

  async pouch_set<T>(
    id: string,
    value: T,
    callback: () => unknown
  ): Promise<void> {
    return this.listStore.set(id, value, callback)
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
    await this.pouch_set("filter_list", filter_list, console.log)
    BackComms.send("story_list", "refilter")
  }

  default_filterlist = defaultFilterList

  get_redirectlist(): Promise<Redirect[]> {
    return this.pouch_get("redirect_list", this.default_redirectlist)
  }

  async save_redirectlist(redirect_list: Redirect[]): Promise<void> {
    await this.pouch_set("redirect_list", redirect_list, console.log)
  }

  static parse_redirectlist(lines: string): Redirect[] {
    return parseRedirectList(lines)
  }

  static present_redirectlist(redirect_list: Redirect[]): string {
    return presentRedirectList(redirect_list)
  }

  default_redirectlist = defaultRedirectList

  async highlightSources(
    failedSources: Record<string, string>,
    shouldOpenPanel = true
  ): Promise<void> {
    console.log(
      "OnceSettings: highlightSources",
      failedSources,
      shouldOpenPanel
    )
    if (SettingsPanel.instance) {
      SettingsPanel.instance.highlight_sources(failedSources, shouldOpenPanel)
    } else {
      console.warn(
        "OnceSettings: SettingsPanel.instance not found, using BackComms"
      )
      BackComms.send(
        "settings",
        "highlight_sources",
        failedSources,
        shouldOpenPanel
      )
    }
  }
}
