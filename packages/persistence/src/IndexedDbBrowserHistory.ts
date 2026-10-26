import { historyQuery, historyUrl, type BrowserHistoryPort, type BrowserVisit, type HistoryPage, type HistoryQuery } from "@once/core"

/** Web preview adapter. Installed mobile apps use their native SQLite database. */
export class IndexedDbBrowserHistory implements BrowserHistoryPort {
  private readonly db: Promise<IDBDatabase>
  constructor() {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open("once-browser-history", 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("visits", { keyPath: "id" })
        store.createIndex("time", ["visitedAt", "id"])
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
  private async write(run: (store: IDBObjectStore) => void): Promise<void> {
    const db = await this.db
    return new Promise((resolve, reject) => {
      const tx = db.transaction("visits", "readwrite")
      run(tx.objectStore("visits"))
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
  }
  record(visit: BrowserVisit): Promise<void> {
    const url = historyUrl(visit.url)
    return url ? this.write(store => store.put({ ...visit, url, title: visit.title.slice(0, 2048) })) : Promise.resolve()
  }
  updateTitle(id: string, title: string): Promise<void> {
    return this.write(store => {
      const request = store.get(id)
      request.onsuccess = () => { if (request.result) store.put({ ...request.result, title }) }
    })
  }
  remove(id: string): Promise<void> { return this.write(store => store.delete(id)) }
  clear(): Promise<void> { return this.write(store => store.clear()) }
  async query(input: HistoryQuery): Promise<HistoryPage> {
    const { search, before, limit } = historyQuery(input)
    const db = await this.db
    return new Promise((resolve, reject) => {
      const tx = db.transaction("visits")
      const request = tx.objectStore("visits").index("time").openCursor(before ? IDBKeyRange.upperBound([before.visitedAt, before.id], true) : null, "prev")
      const entries: BrowserVisit[] = []
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor || entries.length > limit) {
          const last = entries[Math.min(entries.length, limit) - 1]
          resolve({ entries: entries.slice(0, limit), ...(entries.length > limit ? { next: { visitedAt: last.visitedAt, id: last.id } } : {}) })
          return
        }
        const visit = cursor.value as BrowserVisit
        if (`${visit.title} ${visit.url}`.toLowerCase().includes(search.toLowerCase())) entries.push(visit)
        cursor.continue()
      }
    })
  }
}
