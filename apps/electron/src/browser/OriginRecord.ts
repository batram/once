import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { hostBelongsToSite } from "@once/app/browsingSite"

/** The scheme, host and port of a web page, or null for anything off the web. */
export function webOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null
  } catch {
    return null
  }
}

/**
 * Every web origin a frame of the browsing partition has shown, kept on disk.
 * Chromium clears storage only per exact origin and cannot list the origins it
 * holds data for, so clearing a site completely needs this list: a subdomain
 * or an odd port seen in a tab closed long ago is otherwise out of reach. It
 * is a history of visited origins, so clearing a site forgets that site's
 * entries and clearing everything empties it.
 */
export class OriginRecord {
  // Insertion order is recency: a revisit moves an origin to the end, and the
  // oldest go first once the limit is reached.
  private readonly origins = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly file: string,
    private readonly limit = 20_000,
    private readonly delayMs = 2_000
  ) {
    try {
      if (!existsSync(file)) return
      const stored: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (!Array.isArray(stored)) throw new Error("not a list")
      for (const item of stored.slice(-limit)) {
        if (typeof item === "string" && webOrigin(item) === item) this.origins.add(item)
      }
    } catch (error) {
      // A cache of what was visited; starting over only narrows a later clear.
      console.warn(`Ignoring unreadable origin record ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  record(url: string): void {
    const origin = webOrigin(url)
    if (!origin) return
    const known = this.origins.delete(origin)
    this.origins.add(origin)
    if (this.origins.size > this.limit) this.origins.delete(this.origins.values().next().value as string)
    if (!known) this.schedule()
  }

  /** The recorded origins on `site` or one of its subdomains. */
  originsFor(site: string): string[] {
    return [...this.origins].filter((origin) => hostBelongsToSite(new URL(origin).hostname, site))
  }

  forget(site: string): void {
    for (const origin of this.originsFor(site)) this.origins.delete(origin)
    this.flush()
  }

  clear(): void {
    this.origins.clear()
    this.flush()
  }

  /** Writes now; also what quitting calls, so it stays synchronous. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.origins]), "utf8")
    renameSync(`${this.file}.tmp`, this.file)
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      try {
        this.flush()
      } catch (error) {
        console.warn(`Could not save the origin record: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, this.delayMs)
  }
}
