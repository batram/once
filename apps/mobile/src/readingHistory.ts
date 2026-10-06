/**
 * A tab's back/forward list as the reader sees it. The native page keeps its
 * own history, but Reader mode is not a page: the shell draws it over a URL in
 * a frame of its own. This list mirrors the native history, remembers which of
 * its entries were being read in Reader mode, and holds entries for articles
 * opened straight into Reader mode, which the native page never loaded.
 */
export interface HistoryEntry {
  url: string
  reader: boolean
  /** Position in the native page's history; null for a Reader-only entry. */
  native: number | null
}

export type HistoryDirection = "back" | "forward"

export interface HistoryStep {
  entry: Readonly<HistoryEntry>
  /** Where the native page has to move to, or null when it already is there. */
  nativeIndex: number | null
}

export class ReadingHistory {
  private entries: HistoryEntry[] = []
  private cursor = -1
  private nativeIndex = -1
  private nativeLength = 0
  /** A move this list asked the native page for, until the page reports it. */
  private expectedNative: number | null = null
  /** The current Reader-only entry left Reader mode; the page it loads next is this entry. */
  private bindPending = false
  private observed = { mode: "", url: "" }

  get current(): Readonly<HistoryEntry> | null {
    return this.entries[this.cursor] ?? null
  }

  canStep(direction: HistoryDirection): boolean {
    return Boolean(this.entries[this.cursor + offset(direction)])
  }

  /** Follows the session: Reader mode switched on or off, or an article opened in it. */
  observe(mode: string, url: string): void {
    const previous = this.observed
    this.observed = { mode, url }
    if (!url) return
    if (mode === "reader") {
      if (previous.mode === "reader" && sameDocument(previous.url, url)) return
      const entry = this.entries[this.cursor]
      if (entry && sameDocument(entry.url, url)) entry.reader = true
      else this.push({ url, reader: true, native: null })
      return
    }
    if (previous.mode !== "reader" || !sameDocument(previous.url, url)) return
    const entry = this.entries[this.cursor]
    if (!entry?.reader || !sameDocument(entry.url, url)) return
    entry.reader = false
    if (entry.native === null) this.bindPending = true
  }

  /**
   * The native page's history changed. Returns the entry to show when the
   * page itself moved through history, such as a page script going back.
   */
  nativeReported(urls: readonly string[], index: number): Readonly<HistoryEntry> | null {
    const previousIndex = this.nativeIndex
    this.nativeIndex = index
    this.nativeLength = urls.length
    let agree = 0
    while (agree < urls.length) {
      const entry = this.entries.find(candidate => candidate.native === agree)
      if (!entry) break
      // A redirect or replaceState rewrites the page the native history is on.
      const rewritten = agree === index && agree === previousIndex
      if (!rewritten && !sameDocument(entry.url, urls[agree])) break
      entry.url = urls[agree]
      agree += 1
    }
    const replaced = agree < urls.length ||
      this.entries.some(entry => entry.native !== null && entry.native >= agree)
    if (replaced) {
      this.replaceFrom(agree, urls)
      this.expectedNative = null
    }
    if (this.expectedNative !== null) {
      if (index === this.expectedNative) this.expectedNative = null
      return null
    }
    // A page hidden behind Reader mode does not take the reader away with it.
    if (this.observed.mode === "reader") return null
    const current = this.entries[this.cursor]
    if (current && current.native === null && this.homeOf(this.cursor) === index && !replaced) return null
    const target = this.entries.findIndex(entry => entry.native === index)
    if (target < 0 || target === this.cursor) return null
    this.cursor = target
    return this.entries[target]
  }

  /** Moves one entry; the caller shows it and moves the native page if asked. */
  step(direction: HistoryDirection): HistoryStep | null {
    const target = this.cursor + offset(direction)
    const entry = this.entries[target]
    if (!entry) return null
    this.cursor = target
    this.bindPending = false
    // The hidden page follows a Reader-only entry to the page before it, so a
    // link opened from that reader continues the history from there.
    const home = this.homeOf(target)
    const nativeIndex = home !== null && home !== this.nativeIndex ? home : null
    this.expectedNative = nativeIndex
    return { entry, nativeIndex }
  }

  /**
   * Whether the native page may take this direction with its own gesture: its
   * neighbour is the next entry here too, and that entry is not a reader.
   */
  nativeMayStep(direction: HistoryDirection): boolean {
    const current = this.entries[this.cursor]
    const next = this.entries[this.cursor + offset(direction)]
    if (!next) {
      const nativeHasMore = direction === "back"
        ? this.nativeIndex > 0
        : this.nativeIndex >= 0 && this.nativeIndex < this.nativeLength - 1
      return !nativeHasMore
    }
    if (!current || current.native === null || current.reader || next.reader) return false
    return next.native === current.native + offset(direction)
  }

  snapshot(): { entries: HistoryEntry[]; cursor: number } {
    return { entries: this.entries.map(entry => ({ ...entry })), cursor: this.cursor }
  }

  private push(entry: HistoryEntry): void {
    this.entries.splice(this.cursor + 1)
    this.entries.push(entry)
    this.cursor = this.entries.length - 1
    this.bindPending = false
  }

  /** Native positions from `from` on are new pages; they continue from the current entry. */
  private replaceFrom(from: number, urls: readonly string[]): void {
    const cursorEntry = this.entries[this.cursor]
    const cursorReplaced = cursorEntry?.native != null && cursorEntry.native >= from
    const kept = this.entries.slice(0, this.cursor + (cursorReplaced ? 0 : 1))
      .filter(entry => entry.native === null || entry.native < from)
    let added: HistoryEntry[] = urls.slice(from).map((url, offset) => ({ url, reader: false, native: from + offset }))
    const last = kept[kept.length - 1]
    if (this.bindPending && last === cursorEntry && last?.native === null && added.length) {
      last.native = from
      last.url = added[0].url
      added = added.slice(1)
    }
    this.bindPending = false
    this.entries = [...kept, ...added]
    this.cursor = Math.min(Math.max(kept.length - 1, 0), this.entries.length - 1)
  }

  /** The native position an entry sits on: its own, or the nearest page before it. */
  private homeOf(position: number): number | null {
    for (let index = position; index >= 0; index -= 1) {
      const native = this.entries[index]?.native
      if (native != null) return native
    }
    return null
  }
}

function offset(direction: HistoryDirection): -1 | 1 {
  return direction === "back" ? -1 : 1
}

/** Same document: fragments are in-page positions, not different pages. */
export function sameDocument(left: string, right: string): boolean {
  return withoutFragment(left) === withoutFragment(right)
}

function withoutFragment(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ""
    return url.href
  } catch {
    return value.split("#")[0]
  }
}
