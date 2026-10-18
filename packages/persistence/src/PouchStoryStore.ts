import { mergeStoryAssociations, mergeStorySyncState, Story } from "@once/core"
import { sha256 } from "./EpochContent"
import { starredStoryDocuments } from "./StarredStoryIndex"

export interface PouchStoryDatabase {
  changes?(options: Record<string, unknown>): Promise<{
    results: Array<{ id: string; deleted?: boolean; doc?: Record<string, unknown> }>
    last_seq: unknown
  }>
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

/** The same UTF-8/base64 bytes on every platform, including in the revision hash. */
function contentAttachment(html: string): string {
  return btoa(Array.from(new TextEncoder().encode(html), byte => String.fromCharCode(byte)).join(""))
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
  private starredReads: Promise<void> = Promise.resolve()
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
    if (this.db.changes) {
      // PouchDB 9's Mango index builds a persisted row for every false value
      // too. A tiny changes-fed ID projection avoids that cold-start write storm.
      const read = this.starredReads.then(() => starredStoryDocuments(this.db))
      this.starredReads = read.then(() => undefined, () => undefined)
      return (await read).map(doc => this.storyFromDocument(doc))
    }
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
      keys: Array.from(new Set(urls), (url) => this.storyId(url))
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
   * Writes new content and its metadata in one revision. Ordinary story
   * edits preserve attachment stubs; identical feed content is not rewritten.
   */
  async saveStory(story: TStory, options: { derivedFilter?: boolean } = {}): Promise<TStory> {
    const pendingContent = story.pendingContent()
    // Every write below can lose a race with replication. The create path is
    // the common one: both devices ingest the same feed item, and the other
    // device's copy arrives between the 404 and the put. It used to throw from
    // inside the catch, so it never reached the retry and surfaced as
    // "Document update conflict"; a retry now reads that copy and merges.
    const trySave = async (retryCount = 0): Promise<{ rev?: string }> => {
      try {
        return await this.writeStory(story, pendingContent, options)
      } catch (err) {
        if ((err as { status?: number }).status === 409 && retryCount < 3) {
          console.log(
            `Conflict on story ${story.href}, retrying... (${retryCount + 1}/3)`
          )
          return await trySave(retryCount + 1)
        }
        throw err
      }
    }

    const resp = await trySave()
    if (resp.rev) {
      story._rev = resp.rev
    }
    return story
  }

  private async writeStory(
    story: TStory,
    pendingContent: string | undefined,
    options: { derivedFilter?: boolean }
  ): Promise<{ rev?: string }> {
    const id = this.storyId(story.href)
    let doc: Record<string, unknown>
    try {
      doc = await this.db.get(id)
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err
      // Revisions are a hash of the document, so devices that ingest the same
      // feed item write the same first revision and replication sees one
      // story, not a conflict. Nothing device-specific may go in: no clock,
      // no key order. Documents created before this keep their ingested_at.
      await fingerprintContent(story, pendingContent)
      story._id = id
      return this.writeDocument(story, canonicalDocument(storedAttachments({ ...story.to_obj(), _id: id })), pendingContent)
    }

    const stored = this.storyFromDocument(doc)
    const associations = mergeStoryAssociations(stored, story)
    const reconciled = mergeStorySyncState(stored, story)
    if (options.derivedFilter) {
      reconciled.filter = story.filter
      reconciled.sync_updated_at = { ...reconciled.sync_updated_at, filter: 0 }
    }
    // Parsed metadata belongs to the established record, never a stale save snapshot.
    story.type = stored.type
    story.title = stored.title
    story.timestamp = stored.timestamp
    story.comment_url = stored.comment_url
    story.tags = associations.tags
    story.substories = associations.substories
    story.read_state = reconciled.read_state
    story.stared = reconciled.stared
    story.filter = reconciled.filter
    story.sync_updated_at = reconciled.sync_updated_at
    story._id = doc._id as string
    story._rev = doc._rev as string
    // An unrelated edit from an older snapshot must not put old content
    // metadata over the newer attachment whose stubs we preserve below.
    if (pendingContent === undefined) story.stored_content = doc.stored_content as Story["stored_content"]
    if (story["ingested_at"] === undefined && doc.ingested_at !== undefined) {
      ;(story as Record<string, unknown>)["ingested_at"] = doc.ingested_at
    }
    await fingerprintContent(story, pendingContent)
    const nextDocument = canonicalDocument(storedAttachments({ ...story.to_obj(), timestamp: doc.timestamp,
      substories: associations.substories }, doc))
    const mutable = new Set(["read_state", "stared", "filter", "sync_updated_at", "tags", "substories", "bucket", "stored_content"])
    for (const [key, value] of Object.entries(doc)) {
      if (!key.startsWith("_") && !mutable.has(key)) nextDocument[key] = value
    }
    const contentChanged = pendingContent !== undefined &&
      (!sameStoredContent(doc, nextDocument) || await this.getStoryContent(story.href) !== pendingContent)
    if (!contentChanged) {
      // A repeated observation/save time does not change the article.
      story.stored_content = doc.stored_content as Story["stored_content"]
      if (doc.stored_content === undefined) delete nextDocument.stored_content
      else nextDocument.stored_content = doc.stored_content
      // Whatever html rode along is already stored; keep the stubs only.
      story._attachments = nextDocument._attachments as TStory["_attachments"]
      if (sameStoredStory(doc, nextDocument)) return { rev: story._rev }
      return await this.db.put(nextDocument)
    }
    return this.writeDocument(story, nextDocument, pendingContent)
  }

  private async writeDocument(
    story: TStory,
    document: Record<string, unknown>,
    html: string | undefined
  ): Promise<{ rev?: string }> {
    const id = this.storyId(story.href)
    if (html === undefined || !this.db.putAttachment) return this.db.put(document)
    // One revision owns both the fingerprint and bytes. A failed write cannot
    // leave new metadata labelling an old attachment and fool the next retry.
    const response = await this.db.put(canonicalDocument({ ...document, _attachments: {
      ...(document._attachments as Record<string, unknown>),
      content: { content_type: "text/html", data: contentAttachment(html) }
    } }))
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

/**
 * JSON-shaped with sorted keys, the form PouchDB hashes into the revision id.
 * Two devices building the same story must produce the same bytes.
 */
function canonicalDocument(document: Record<string, unknown>): Record<string, unknown> {
  return canonicalValue(JSON.parse(JSON.stringify(document))) as Record<string, unknown>
}

/**
 * Records a portable hash of the exact UTF-8 bytes. Migration can validate
 * the attachment against it without relying on the revision id alone.
 */
async function fingerprintContent(story: Story, html: string | undefined): Promise<void> {
  if (html === undefined || !story.stored_content) return
  story.stored_content = {
    ...story.stored_content,
    fingerprint: `sha256:${await sha256(new TextEncoder().encode(html))}`
  }
}

/** Whether the incoming story describes the content the document already has. */
function sameStoredContent(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>
): boolean {
  const attachments = stored._attachments as Record<string, unknown> | undefined
  if (!attachments?.content) return false
  const meaningful = (value: unknown) => Object.fromEntries(Object.entries(
    value && typeof value === "object" ? value : {}).filter(([key]) => key !== "saved_at"))
  return JSON.stringify(canonicalValue(meaningful(stored.stored_content))) ===
    JSON.stringify(canonicalValue(meaningful(incoming.stored_content)))
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
