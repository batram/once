export interface PouchListDatabase {
  get(id: string): Promise<{ list?: unknown }>
  put(doc: Record<string, unknown>): Promise<unknown>
}

export class PouchListStore {
  constructor(private db: PouchListDatabase) {}

  async get<T>(id: string, fallbackValue: T): Promise<T> {
    return this.db
      .get(id)
      .then((doc) => {
        return doc.list as T
      })
      .catch((err) => {
        console.error("pouch_get err", err)
        if (err.status == 404) {
          this.db.put({
            _id: id,
            list: fallbackValue
          })
        }
        return fallbackValue
      })
  }

  async set<T>(id: string, value: T): Promise<void> {
    const tryUpdate = async (retryCount = 0): Promise<void> => {
      try {
        const doc = await this.db.get(id)
        doc.list = value
        await this.db.put(doc as Record<string, unknown>)
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 404) {
          await this.db.put({
            _id: id,
            list: value
          })
        } else if (status === 409 && retryCount < 3) {
          console.log(`Conflict on ${id}, retrying... (${retryCount + 1}/3)`)
          await tryUpdate(retryCount + 1)
        } else {
          console.error("pouch_set error:", err)
        }
      }
    }

    await tryUpdate()
  }
}
