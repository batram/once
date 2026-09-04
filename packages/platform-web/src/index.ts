import { DEFAULT_CACHE_MINUTES, Story } from "@once/core"
import { OncePlatformPorts, ThemeName } from "@once/app"

class WebListStore {
  async get<T>(id: string, fallbackValue: T): Promise<T> {
    const stored = window.localStorage.getItem(`once:list:${id}`)
    if (!stored) {
      await this.set(id, fallbackValue)
      return fallbackValue
    }
    return JSON.parse(stored) as T
  }

  async set<T>(id: string, value: T): Promise<void> {
    window.localStorage.setItem(`once:list:${id}`, JSON.stringify(value))
  }
}

class WebStoryStore {
  storyId(url: string): string {
    return "sto_" + url
  }

  async getStories(limit?: number): Promise<Story[]> {
    const stories = Object.keys(window.localStorage)
      .filter((key) => key.startsWith("once:story:"))
      .map((key) => window.localStorage.getItem(key))
      .filter((stored): stored is string => stored !== null)
      .map((stored) => Story.from_obj(JSON.parse(stored)))
    return limit === undefined ? stories : stories.slice(0, limit)
  }

  async getStaredStories(): Promise<Story[]> {
    return (await this.getStories()).filter((story) => story.stared)
  }

  async getStoriesByUrls(urls: string[]): Promise<Map<string, Story>> {
    const entries = await Promise.all(
      urls.map(async (url) => [url, await this.getStory(url)] as const)
    )
    return new Map(
      entries.filter((entry): entry is readonly [string, Story] => entry[1] !== null)
    )
  }

  async getStory(url: string): Promise<Story | null> {
    const stored = window.localStorage.getItem(`once:story:${this.storyId(url)}`)
    return stored ? Story.from_obj(JSON.parse(stored)) : null
  }

  async saveStory(story: Story): Promise<Story> {
    story._id = story._id || this.storyId(story.href)
    const html = story.pendingContent()
    if (html !== undefined) {
      window.localStorage.setItem(`once:content:${story._id}`, html)
      story._attachments = {
        content: { content_type: "text/html", length: html.length, stub: true }
      }
    }
    window.localStorage.setItem(
      `once:story:${story._id}`,
      JSON.stringify(story.to_obj())
    )
    return story
  }

  async deleteStory(url: string): Promise<void> {
    window.localStorage.removeItem(`once:story:${this.storyId(url)}`)
    window.localStorage.removeItem(`once:content:${this.storyId(url)}`)
  }

  async getStoryContent(url: string): Promise<string | null> {
    return window.localStorage.getItem(`once:content:${this.storyId(url)}`)
  }
}

const CACHE_PREFIX = "once:cache:"

class WebCacheStore {
  async get(url: string): Promise<unknown> {
    const stored = window.localStorage.getItem(`${CACHE_PREFIX}${url}`)
    return stored ? JSON.parse(stored) : null
  }

  async set(url: string, content: unknown): Promise<void> {
    window.localStorage.setItem(`${CACHE_PREFIX}${url}`, JSON.stringify(content))
  }

  async delete(url: string): Promise<void> {
    window.localStorage.removeItem(`${CACHE_PREFIX}${url}`)
  }

  async clear(): Promise<void> {
    // localStorage also holds settings for this shell, so the prefix decides
    // what a cache clear is allowed to touch.
    const keys: string[] = []
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index)
      if (key?.startsWith(CACHE_PREFIX)) keys.push(key)
    }
    keys.forEach((key) => window.localStorage.removeItem(key))
  }
}

class WebSyncSettingsStore {
  async getSyncUrl(): Promise<string> {
    return window.localStorage.getItem("once:sync_url") || ""
  }

  async setSyncUrl(syncUrl: string): Promise<void> {
    window.localStorage.setItem("once:sync_url", syncUrl)
  }

  async getCacheTime(): Promise<number> {
    const time = parseInt(window.localStorage.getItem("once:cache_time") ?? "")
    return Number.isNaN(time) ? DEFAULT_CACHE_MINUTES : time
  }

  async setCacheTime(cacheTime: string): Promise<void> {
    window.localStorage.setItem("once:cache_time", cacheTime)
  }
}

/** Device-local, like the sync URL beside it; the browser profile is the vault. */
class WebSecretStore {
  async get(key: string): Promise<string> {
    return window.localStorage.getItem(`once:secret:${key}`) || ""
  }

  async set(key: string, value: string): Promise<void> {
    if (value) window.localStorage.setItem(`once:secret:${key}`, value)
    else window.localStorage.removeItem(`once:secret:${key}`)
  }
}

export function createWebPlatform(): OncePlatformPorts {
  return {
    listStore: new WebListStore(),
    storyStore: new WebStoryStore(),
    cacheStore: new WebCacheStore(),
    syncSettingsStore: new WebSyncSettingsStore(),
    secretStore: new WebSecretStore(),
    theme: {
      setTheme(theme: ThemeName) {
        document.body.removeAttribute("data-theme")
        if (theme !== "system") {
          document.body.setAttribute("data-theme", theme)
        }
      }
    },
    activeTab: {
      openUrl(url, target) {
        if (target === "middle" || target === "_self") {
          window.open(url, "_blank")
        } else {
          window.open(url, target)
        }
      },
      onSelectedUrlChanged() {
        return () => undefined
      }
    },
    fetch: window.fetch.bind(window)
  }
}
