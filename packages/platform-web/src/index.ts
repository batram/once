import { Story } from "@once/core"
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
    window.localStorage.setItem(
      `once:story:${story._id}`,
      JSON.stringify(story.to_obj())
    )
    return story
  }

  async deleteStory(url: string): Promise<void> {
    window.localStorage.removeItem(`once:story:${this.storyId(url)}`)
  }
}

class WebCacheStore {
  async get(url: string): Promise<unknown> {
    const stored = window.localStorage.getItem(`once:cache:${url}`)
    return stored ? JSON.parse(stored) : null
  }

  async set(url: string, content: unknown): Promise<void> {
    window.localStorage.setItem(`once:cache:${url}`, JSON.stringify(content))
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
    return Number.isNaN(time) ? 120 : time
  }

  async setCacheTime(cacheTime: string): Promise<void> {
    window.localStorage.setItem("once:cache_time", cacheTime)
  }
}

export function createWebPlatform(): OncePlatformPorts {
  return {
    listStore: new WebListStore(),
    storyStore: new WebStoryStore(),
    cacheStore: new WebCacheStore(),
    syncSettingsStore: new WebSyncSettingsStore(),
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
