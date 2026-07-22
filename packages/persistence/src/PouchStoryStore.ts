import { Story } from "@once/core"

export interface PouchStoryDatabase {
  allDocs(options: Record<string, unknown>): Promise<{ rows: { doc?: unknown }[] }>
  get(id: string): Promise<Record<string, unknown>>
  put(doc: Record<string, unknown>): Promise<{ rev?: string }>
  remove(
    doc: { _id: string; _rev: string },
    options?: Record<string, unknown>
  ): Promise<unknown>
}

export class PouchStoryStore<TStory extends Story> {
  private diagnosticHandlers = new Set<(error: {
    severity: "warning" | "error"
    operation: string
    message: string
    details?: string
    storyUrl?: string
    sourceUrl?: string
    documentId?: string
  }) => void>()

  constructor(
    private db: PouchStoryDatabase,
    private fromObj: (story: Record<string, unknown>) => TStory
  ) {}

  onDiagnostic(handler: (error: {
    severity: "warning" | "error"
    operation: string
    message: string
    details?: string
    storyUrl?: string
    sourceUrl?: string
    documentId?: string
  }) => void): () => void {
    this.diagnosticHandlers.add(handler)
    return () => this.diagnosticHandlers.delete(handler)
  }

  storyId(url: string): string {
    return "sto_" + url
  }

  async getStories(limit?: number): Promise<TStory[]> {
    const response = await this.db.allDocs({
      include_docs: true,
      startkey: this.storyId("h"),
      endkey: this.storyId("i"),
      ...(limit === undefined ? {} : { limit })
    })

    return response.rows
      .filter((entry) => entry.doc)
      .map((entry) => {
        const doc = entry.doc as Record<string, unknown>
        return this.storyFromDocument(doc)
      })
  }

  async getStoriesByUrls(urls: string[]): Promise<Map<string, TStory>> {
    if (urls.length === 0) return new Map()
    const response = await this.db.allDocs({
      include_docs: true,
      keys: urls.map((url) => this.storyId(url))
    })
    const stories = new Map<string, TStory>()
    response.rows.forEach((entry) => {
      if (!entry.doc) return
      const story = this.storyFromDocument(entry.doc as Record<string, unknown>)
      stories.set(story.href, story)
    })
    return stories
  }

  async getStory(url: string): Promise<TStory | null> {
    return this.db
      .get(this.storyId(url))
      .then((doc: unknown) => {
        return this.storyFromDocument(doc as Record<string, unknown>, url)
      })
      .catch((err) => {
        if ((err as { status?: number }).status === 404) {
          return null
        }
        throw err
      })
  }

  async saveStory(story: TStory): Promise<TStory> {
    const trySave = async (retryCount = 0): Promise<{ rev?: string }> => {
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
          throw err
        }
      }
    }

    const resp = await trySave()
    if (resp.rev) {
      story._rev = resp.rev
    }
    return story
  }

  async deleteStory(url: string): Promise<void> {
    try {
      const doc = await this.db.get(this.storyId(url))
      await this.db.remove(doc as { _id: string; _rev: string })
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error
    }
  }

  private storyFromDocument(
    doc: Record<string, unknown>,
    fallbackUrl = String(doc._id ?? "").replace(/^sto_/, "")
  ): TStory {
    try {
      return this.fromObj(doc)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const timestamp =
        doc.timestamp instanceof Date
          ? doc.timestamp.getTime()
          : typeof doc.timestamp === "number"
            ? doc.timestamp
            : Date.parse(String(doc.timestamp ?? ""))
      console.error(`Corrupted story ${doc._id ?? fallbackUrl}: ${message}`)
      const diagnosticDoc = { ...doc }
      delete diagnosticDoc._attachments
      const serializedDoc = JSON.stringify(diagnosticDoc, null, 2)
      const documentDetails =
        serializedDoc.length > 20_000
          ? `${serializedDoc.slice(0, 20_000)}\n… truncated`
          : serializedDoc
      this.diagnosticHandlers.forEach((handler) =>
        handler({
          severity: "error",
          operation: "story.load",
          message: `Corrupted story: ${message}`,
          details: `Validation error: ${message}\n\nStored document:\n${documentDetails}`,
          storyUrl: fallbackUrl,
          documentId: String(doc._id ?? "")
        })
      )
      return this.fromObj({
        ...doc,
        type: typeof doc.type === "string" && doc.type.trim() ? doc.type : "Corrupted",
        href: typeof doc.href === "string" && doc.href.trim() ? doc.href : fallbackUrl,
        title:
          typeof doc.title === "string" && doc.title.trim()
            ? doc.title
            : "[Corrupted story — purge this entry]",
        timestamp: Number.isFinite(timestamp) ? doc.timestamp : Date.now()
      })
    }
  }
}
