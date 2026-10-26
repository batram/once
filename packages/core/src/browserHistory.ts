/** Local browsing visits; independent of tab back/forward and story read state. */
export interface BrowserVisit { id: string; url: string; title: string; visitedAt: number }
export interface HistoryQuery { search?: string; before?: { visitedAt: number; id: string }; limit?: number }
export interface HistoryPage { entries: BrowserVisit[]; next?: { visitedAt: number; id: string } }
export interface BrowserHistoryPort {
  record(visit: BrowserVisit): Promise<void>
  updateTitle(id: string, title: string): Promise<void>
  query(query: HistoryQuery): Promise<HistoryPage>
  remove(id: string): Promise<void>
  clear(): Promise<void>
}

export function historyUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.username = ""
    url.password = ""
    url.hash = ""
    return url.href.length <= 16384 ? url.href : null
  } catch { return null }
}

export function historyQuery(value: HistoryQuery = {}): Required<Pick<HistoryQuery, "search" | "limit">> & Pick<HistoryQuery, "before"> {
  const before = value.before
  return {
    search: typeof value.search === "string" ? value.search.trim().slice(0, 256) : "",
    limit: typeof value.limit === "number" && Number.isSafeInteger(value.limit) ? Math.max(1, Math.min(100, value.limit)) : 50,
    ...(before && Number.isSafeInteger(before.visitedAt) && typeof before.id === "string" && before.id.length <= 100 ? { before } : {})
  }
}
