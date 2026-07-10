export class IndexedDbCacheStore {
  private static DB_NAME = "NetworkCache"
  private static STORE_NAME = "requests"
  private static DB_VERSION = 1
  private static db: IDBDatabase | null = null

  private static async getDB(): Promise<IDBDatabase> {
    if (this.db) return this.db

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        this.db = request.result
        resolve(this.db)
      }

      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME)
        }
      }
    })
  }

  static async get(url: string): Promise<unknown> {
    try {
      const db = await this.getDB()
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(this.STORE_NAME, "readonly")
        const store = transaction.objectStore(this.STORE_NAME)
        const request = store.get(url)

        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve(request.result)
      })
    } catch (error) {
      console.error("IndexedDbCacheStore.get error", error)
      return null
    }
  }

  static async set(url: string, value: unknown): Promise<void> {
    try {
      const db = await this.getDB()
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(this.STORE_NAME, "readwrite")
        const store = transaction.objectStore(this.STORE_NAME)
        const request = store.put(value, url)

        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve()
      })
    } catch (error) {
      console.error("IndexedDbCacheStore.set error", error)
    }
  }

  static async clear(): Promise<void> {
    try {
      const db = await this.getDB()
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(this.STORE_NAME, "readwrite")
        const store = transaction.objectStore(this.STORE_NAME)
        const request = store.clear()

        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve()
      })
    } catch (error) {
      console.error("IndexedDbCacheStore.clear error", error)
    }
  }
}
