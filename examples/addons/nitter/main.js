// Nitter: X / Twitter timelines through whichever public Nitter instance is
// healthy right now, and links to x.com sent there too. status.d420.de checks
// every instance each 900 s and asks to be polled rarely, so the list is kept
// for an hour and never fetched twice inside one of its own check windows.
// A single module: Once imports it into an opaque-origin sandbox.

export const STATUS_URL = "https://status.d420.de/api/v1/instances"
const REDIRECT = "x-to-nitter"
/** status.d420.de's own check interval: the list cannot change faster. */
export const STATUS_INTERVAL_MS = 900_000
/** How long a list is used before asking again, failures or not. */
export const LIST_MAX_AGE_MS = 60 * 60_000
/** An instance that failed us is skipped this long, whatever the list says. */
export const BAD_FOR_MS = 30 * 60_000
// The copy in once.storage syncs to every device, so it is written rarely.
const STORED_EVERY_MS = 60 * 60_000
// Paths on x.com that are not someone's timeline.
const NOT_USERS = new Set(["i", "home", "explore", "notifications", "messages", "settings", "search", "intent", "share", "hashtag"])

export default function activate(once) {
  createNitter(once)
}

/** Everything the add-on registers; `now` is injectable so the throttles can be tested. */
export function createNitter(once, now = () => Date.now()) {
  const instances = new Instances(once, now)
  once.collectors.register("timeline", {
    resolveUrl: async ({ url, config }) => {
      const instance = await instances.pick()
      return instance ? instanceUrl(url, instance, config) : null
    },
    failed: async ({ fetchedUrl, error }) => {
      // A missing account is missing everywhere; only the instance's own trouble moves us.
      if (/HTTP 404/.test(error)) return false
      const next = await instances.markBad(fetchedUrl)
      if (next) await once.redirects.set(REDIRECT, `${next.url}/$1`).catch(() => undefined)
      return Boolean(next)
    },
    parse: (body) => parseTimeline(String(body), once.settings)
  })
  once.redirects.register(REDIRECT, {
    target: async () => {
      const instance = await instances.pick()
      return instance ? `${instance.url}/$1` : null
    },
    failed: async ({ url }) => {
      const next = await instances.markBad(url)
      return next ? `${next.url}/$1` : null
    }
  })
  return instances
}

/** The healthy instances, best first, and which ones failed us lately. */
export class Instances {
  constructor(once, now) {
    this.once = once
    this.now = now
    this.hosts = []
    this.fetchedAt = 0
    this.storedAt = 0
    this.bad = new Map()
    this.loading = null
    this.triedStorage = false
  }

  /** The instance to use now, or null when none is known to work. */
  async pick() {
    await this.load(false)
    return this.best()
  }

  /** `url` came from an instance that failed; the one to try next, or null. */
  async markBad(url) {
    const origin = originOf(url)
    if (origin) this.bad.set(origin, this.now() + BAD_FOR_MS)
    if (!this.best()) await this.load(true)
    return this.best()
  }

  best() {
    const pinned = originOf(String(this.once.settings?.preferredInstance ?? "").trim())
    if (pinned && !this.isBad(pinned)) return this.hosts.find(host => host.url === pinned) ?? { url: pinned, rss: true }
    return this.hosts.find(host => !this.isBad(host.url)) ?? null
  }

  isBad(url) {
    const until = this.bad.get(url)
    if (until === undefined) return false
    if (until > this.now()) return true
    this.bad.delete(url)
    return false
  }

  /** Fetches the list when it is old, or when every known instance failed; never within one check window. */
  async load(afterFailure) {
    if (!this.triedStorage) {
      this.triedStorage = true
      await this.restore()
    }
    const age = this.now() - this.fetchedAt
    const stale = this.hosts.length === 0 || age >= LIST_MAX_AGE_MS || afterFailure
    if (!stale || (this.fetchedAt && age < STATUS_INTERVAL_MS)) return
    this.loading ??= this.fetchList().finally(() => { this.loading = null })
    await this.loading
  }

  async fetchList() {
    let hosts
    try {
      const { text } = await this.once.fetch(STATUS_URL)
      hosts = rankInstances(JSON.parse(text))
    } catch (error) {
      // A missing list keeps the last one; the window still applies, so a
      // down status page is not asked again on every load.
      this.fetchedAt = this.now()
      console.warn("Nitter instance list unavailable", error)
      return
    }
    this.hosts = hosts
    this.fetchedAt = this.now()
    if (this.fetchedAt - this.storedAt >= STORED_EVERY_MS) {
      this.storedAt = this.fetchedAt
      await this.once.storage.set("instances", { at: this.fetchedAt, hosts }).catch(() => undefined)
    }
  }

  /** A cold sandbox starts from the synced copy when it is recent enough. */
  async restore() {
    const stored = await Promise.resolve(this.once.storage.get("instances")).catch(() => undefined)
    if (!stored || typeof stored.at !== "number" || !Array.isArray(stored.hosts)) return
    if (this.now() - stored.at >= LIST_MAX_AGE_MS) return
    this.hosts = stored.hosts.filter(host => typeof host?.url === "string" && originOf(host.url) === host.url)
      .map(host => ({ url: host.url, rss: host.rss === true }))
    this.fetchedAt = stored.at
    this.storedAt = stored.at
  }
}

/** status.d420.de's answer as usable instances: healthy, not flagged, RSS first, then points and speed. */
export function rankInstances(data) {
  const hosts = Array.isArray(data?.hosts) ? data.hosts : []
  return hosts
    .filter(host => host && host.healthy === true && host.is_bad_host !== true && originOf(host.url) === String(host.url).replace(/\/+$/, ""))
    .sort((a, b) => Number(b.rss === true) - Number(a.rss === true) ||
      (Number(b.points) || 0) - (Number(a.points) || 0) ||
      (Number(a.ping_avg) || Infinity) - (Number(b.ping_avg) || Infinity))
    .map(host => ({ url: originOf(host.url), rss: host.rss === true }))
}

/** The page to fetch for a source on x.com, twitter.com, or any Nitter instance. */
export function instanceUrl(sourceUrl, instance, config) {
  const source = new URL(sourceUrl)
  const parts = source.pathname.split("/").filter(Boolean)
  const feed = instance.rss ? "/rss" : ""
  if (parts[0] === "search") {
    const query = new URLSearchParams({ f: "tweets", q: source.searchParams.get("q") ?? "" })
    return `${instance.url}/search${feed}?${query}`
  }
  const user = parts[0]
  if (!user || NOT_USERS.has(user.toLowerCase())) throw new Error(`${sourceUrl} is not a timeline Nitter can show`)
  const replies = parts[1] === "with_replies" || config?.replies === true
  return `${instance.url}/${encodeURIComponent(user)}${replies ? "/with_replies" : ""}${feed}`
}

/** An instance's RSS feed or HTML timeline as Once stories, linked on x.com. */
export function parseTimeline(body, settings = {}) {
  const trimmed = body.trimStart()
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<rss")) return parseRss(body, settings)
  const doc = new DOMParser().parseFromString(body, "text/html")
  if (!doc.querySelector(".timeline")) {
    // A bot check or an error page answers 200 too; saying so lets Once try another instance.
    throw new Error("The instance did not return a timeline")
  }
  return parseHtml(doc, settings)
}

function parseRss(body, settings) {
  const doc = new DOMParser().parseFromString(body, "text/xml")
  if (doc.getElementsByTagName("parsererror").length || !doc.getElementsByTagName("channel").length) {
    throw new Error("The instance did not return an RSS feed")
  }
  return Array.from(doc.getElementsByTagName("item")).flatMap((item) => {
    const text = (tag) => item.getElementsByTagName(tag)[0]?.textContent?.trim() ?? ""
    const href = canonical(text("link") || text("guid"))
    const title = text("title")
    const timestamp = Date.parse(text("pubDate"))
    if (!href || !title || !Number.isFinite(timestamp)) return []
    const author = text("dc:creator").replace(/^@/, "") || authorOf(href)
    return [story(href, title, timestamp, author, /^RT by @/i.test(title), settings)]
  })
}

function parseHtml(doc, settings) {
  return Array.from(doc.querySelectorAll(".timeline-item")).flatMap((item) => {
    const link = item.querySelector(".tweet-link") ?? item.querySelector(".tweet-date a")
    const href = canonical(link?.getAttribute("href") ?? "")
    const date = item.querySelector(".tweet-date a")?.getAttribute("title") ?? ""
    const timestamp = Date.parse(date.replace("·", ""))
    const title = item.querySelector(".tweet-content")?.textContent?.trim() ?? ""
    if (!href || !title || !Number.isFinite(timestamp)) return []
    const author = (item.querySelector(".username")?.textContent ?? "").trim().replace(/^@/, "") || authorOf(href)
    return [story(href, title, timestamp, author, Boolean(item.querySelector(".retweet-header")), settings)]
  })
}

function story(href, title, timestamp, author, retweet, settings) {
  const result = { href, title, timestamp }
  if (author) result.tags = [{ class: "user", text: author, href: `https://x.com/${encodeURIComponent(author)}` }]
  if (retweet && settings?.filterRetweets === true) result.filter = ":: Retweet ::"
  return result
}

/**
 * A post's address on x.com, whatever instance served it: read state and
 * bookmarks survive a move to another instance, and the redirect sends the
 * link to whichever instance is healthy when it is opened.
 */
export function canonical(link) {
  const match = /^(?:https?:\/\/[^/]+)?\/([^/?#]+)\/status\/(\d+)/.exec(link.trim())
  return match ? `https://x.com/${match[1]}/status/${match[2]}` : ""
}

function authorOf(href) {
  return /^https:\/\/x\.com\/([^/]+)\//.exec(href)?.[1] ?? ""
}

function originOf(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" ? parsed.origin : null
  } catch {
    return null
  }
}
