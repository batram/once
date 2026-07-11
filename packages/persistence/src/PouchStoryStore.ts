import { Story } from "@once/core"

export interface PouchStoryDatabase {
  allDocs(options: Record<string, unknown>): Promise<{ rows: { doc?: unknown }[] }>
  get(id: string): Promise<Record<string, unknown>>
  put(doc: Record<string, unknown>): Promise<{ rev?: string }>
}

export class PouchStoryStore<TStory extends Story> {
  constructor(
    private db: PouchStoryDatabase,
    private fromObj: (story: Record<string, unknown>) => TStory
  ) {}

  storyId(url: string): string {
    return "sto_" + url
  }

  async getStories(): Promise<TStory[]> {
    const response = await this.db.allDocs({
      include_docs: true,
      startkey: this.storyId("h"),
      endkey: this.storyId("i")
    })

    return response.rows
      .filter((entry) => entry.doc)
      .map((entry) => {
        return this.fromObj(entry.doc as Record<string, unknown>)
      })
  }

  async getStory(url: string): Promise<TStory> {
    return this.db
      .get(this.storyId(url))
      .then((doc: unknown) => {
        return this.fromObj(doc as Record<string, unknown>)
      })
      .catch((err) => {
        console.error("get_story err", err)
        return null as unknown as TStory
      })
  }

  async saveStory(story: TStory): Promise<TStory> {
    const trySave = async (
      retryCount = 0
    ): Promise<{ rev?: string } | undefined> => {
      try {
        const doc = await this.db.get(this.storyId(story.href))
        story._id = doc._id as string
        story._rev = doc._rev as string
        return await this.db.put(story.to_obj())
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 404) {
          story._id = this.storyId(story.href)
          ;(story as Record<string, unknown>)["ingested_at"] = Date.now()
          return await this.db.put(story.to_obj())
        } else if (status === 409 && retryCount < 3) {
          console.log(
            `Conflict on story ${story.href}, retrying... (${retryCount + 1}/3)`
          )
          return await trySave(retryCount + 1)
        } else {
          console.error("save_story error:", err)
          return undefined
        }
      }
    }

    const resp = await trySave()
    if (resp && resp.rev) {
      story._rev = resp.rev
    }
    return story
  }
}
