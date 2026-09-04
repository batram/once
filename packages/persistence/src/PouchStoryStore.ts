import { mergeStorySyncState, Story } from "@once/core"

export interface PouchStoryDatabase {
  allDocs(options: Record<string, unknown>): Promise<{ rows: { doc?: unknown }[] }>
  createIndex(
    options: PouchDB.Find.CreateIndexOptions,
    callback: PouchDB.Core.Callback<PouchDB.Find.CreateIndexResponse<object>>
  ): void
  createIndex(
    options?: PouchDB.Find.CreateIndexOptions
  ): Promise<PouchDB.Find.CreateIndexResponse<object>>
  find(
    options: PouchDB.Find.FindRequest<object>,
    callback: PouchDB.Core.Callback<PouchDB.Find.FindResponse<object>>
  ): void
  find(
    options?: PouchDB.Find.FindRequest<object>
  ): Promise<PouchDB.Find.FindResponse<object>>
  get(id: string): Promise<Record<string, unknown>>
  put(doc: Record<string, unknown>): Promise<{ rev?: string }>
  remove(
    doc: { _id: string; _rev: string },
    options?: Record<string, unknown>
  ): Promise<unknown>
  getAttachment?(id: string, name: string): Promise<unknown>
  putAttachment?(
    id: string,
    name: string,
    rev: string,
    attachment: unknown,
    type: string
  ): Promise<{ rev?: string }>
}

/** The `content` attachment as the platform's binary type: a Blob in the browsers, a Buffer in Node. */
function contentAttachment(html: string): unknown {
  if (typeof Blob !== "undefined") return new Blob([html], { type: "text/html" })
  return Buffer.from(html, "utf8")
}

async function attachmentText(attachment: unknown): Promise<string> {
  if (typeof attachment === "string") return attachment
  if (attachment && typeof (attachment as Blob).text === "function") {
    return (attachment as Blob).text()
  }
  return new TextDecoder("utf-8").decode(attachment as Uint8Array)
}

export class PouchStoryStore<TStory extends Story> {
  private staredIndex?: Promise<unknown>
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

  async getStaredStories(): Promise<TStory[]> {
    const indexOptions = {
      index: {
        fields: ["stared"],
        partial_filter_selector: { stared: { $eq: true } }
      },
      ddoc: "once-stared",
      name: "stared-only"
    } as PouchDB.Find.CreateIndexOptions & { ddoc: string; name: string }
    this.staredIndex ??= this.db.createIndex(indexOptions)
    try {
      await this.staredIndex
    } catch (error) {
      this.staredIndex = undefined
      throw error
    }
    const response = await this.db.find({
      selector: { stared: { $eq: true } },
      use_index: ["once-stared", "stared-only"]
    })
    return response.docs.map((doc) =>
      this.storyFromDocument(doc as unknown as Record<string, unknown>)
    )
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

  /**
   * Writes the story document, then its `content` attachment when the story
   * carries html that is not stored yet. The document itself always goes out
   * with the attachment stubs PouchDB already holds: a document put without
   * them would delete the attachment, and one put with inline data would
   * re-upload it on every save.
   */
  async saveStory(story: TStory): Promise<TStory> {
    const pendingContent = story.pendingContent()
    const trySave = async (retryCount = 0): Promise<{ rev?: string }> => {
      try {
        const doc = await this.db.get(this.storyId(story.href))
        const reconciled = mergeStorySyncState(
          this.storyFromDocument(doc),
          story
        )
        story.read_state = reconciled.read_state
        story.stared = reconciled.stared
        story.filter = reconciled.filter
        story.sync_updated_at = reconciled.sync_updated_at
        story._id = doc._id as string
        story._rev = doc._rev as string
        if (story["ingested_at"] === undefined && doc.ingested_at !== undefined) {
          ;(story as Record<string, unknown>)["ingested_at"] = doc.ingested_at
        }
        const nextDocument = storedAttachments(story.to_obj(), doc)
        const contentChanged = pendingContent !== undefined &&
          !sameStoredContent(doc, nextDocument)
        if (!contentChanged) {
          // Whatever html rode along is already stored; keep the stubs only.
          story._attachments = nextDocument._attachments as TStory["_attachments"]
          if (sameStoredStory(doc, nextDocument)) return { rev: story._rev }
          return await this.db.put(nextDocument)
        }
        const response = await this.db.put(nextDocument)
        return await this.writeContent(story, response.rev, pendingContent)
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 404) {
          story._id = this.storyId(story.href)
          ;(story as Record<string, unknown>)["ingested_at"] = Date.now()
          const response = await this.db.put(storedAttachments(story.to_obj()))
          return pendingContent === undefined
            ? response
            : await this.writeContent(story, response.rev, pendingContent)
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

  private async writeContent(
    story: TStory,
    rev: string | undefined,
    html: string
  ): Promise<{ rev?: string }> {
    const id = this.storyId(story.href)
    if (!this.db.putAttachment || !rev) {
      // A database without attachments keeps the html on the story, so a
      // later save against a capable one still writes it.
      return { rev }
    }
    const response = await this.db.putAttachment(
      id,
      "content",
      rev,
      contentAttachment(html),
      "text/html"
    )
    // The stubs PouchDB minted (digest, length) replace the html in memory.
    const stored = await this.db.get(id)
    story._attachments = stored._attachments as TStory["_attachments"]
    return response
  }

  /** The stored article html, or null when the story has none. */
  async getStoryContent(url: string): Promise<string | null> {
    if (!this.db.getAttachment) return null
    try {
      const attachment = await this.db.getAttachment(this.storyId(url), "content")
      return attachment == null ? null : await attachmentText(attachment)
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null
      throw error
    }
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

/**
 * The document to put: the story's fields with the attachment stubs the
 * database holds. Pending html never goes inline; `writeContent` sends it.
 */
function storedAttachments(
  document: Record<string, unknown>,
  stored?: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...document }
  if (stored?._attachments) next._attachments = stored._attachments
  else delete next._attachments
  return next
}

/** Whether the incoming story describes the content the document already has. */
function sameStoredContent(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>
): boolean {
  const attachments = stored._attachments as Record<string, unknown> | undefined
  if (!attachments?.content) return false
  return JSON.stringify(canonicalValue(stored.stored_content)) ===
    JSON.stringify(canonicalValue(incoming.stored_content))
}

function sameStoredStory(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>
): boolean {
  const withoutRevisionMetadata = (value: Record<string, unknown>) => {
    const copy = { ...value }
    delete copy._rev
    delete copy._conflicts
    delete copy._deleted_conflicts
    delete copy._attachments
    return copy
  }
  return JSON.stringify(canonicalValue(withoutRevisionMetadata(stored))) ===
    JSON.stringify(canonicalValue(withoutRevisionMetadata(incoming)))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)])
  )
}
