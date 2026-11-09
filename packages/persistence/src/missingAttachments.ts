type AttachmentCallback = (error: unknown, data?: unknown) => void
type ReadAttachment = (
  docId: string,
  attachId: string,
  attachment: { digest?: string },
  options: { ctx?: IDBTransaction } & Record<string, unknown>,
  callback: AttachmentCallback
) => void

interface IdbPouch {
  adapter?: string
  name?: string
  _getAttachment?: ReadAttachment
}

const ATTACH_STORE = "attach-store"
const MISSING_BYTES = "missing_attachment_bytes"

/** True for the error a guarded database gives for a stub whose bytes are gone. */
export function isMissingAttachmentBytes(error: unknown): boolean {
  return (error as { reason?: unknown } | null)?.reason === MISSING_BYTES
}

/**
 * PouchDB's IndexedDB adapter reads attachment bytes by digest and
 * dereferences the row inside its request callback. When attach-store has no
 * row for a stub's digest (found on an iPhone: two stories whose bytes were
 * gone), that callback throws: the read never calls back, so whatever awaited
 * it hangs, and where the engine aborts the transaction for it (Chromium,
 * Gecko) PouchDB closes the whole database as a "global failure". Counting
 * the digest in the same transaction first turns that into a 404 the callers
 * already handle — and a save that then writes the bytes again repairs it.
 *
 * Every attachment read (getAttachment, get/bulkGet with attachments,
 * replication) goes through `_getAttachment`, which the adapter only assigns
 * once its async setup runs, so the guard wraps whatever gets assigned.
 */
export function guardMissingAttachments<T>(db: T): T {
  const pouch = db as unknown as IdbPouch
  if (pouch.adapter !== "idb" || typeof indexedDB === "undefined" || !pouch.name) return db
  let connection: Promise<IDBDatabase> | undefined
  const open = (): Promise<IDBDatabase> => connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("_pouch_" + pouch.name)
    request.onsuccess = () => {
      const opened = request.result
      // Never hold up PouchDB's own upgrade or destroy.
      opened.onversionchange = () => { opened.close(); connection = undefined }
      resolve(opened)
    }
    request.onerror = () => { connection = undefined; reject(request.error) }
  })
  const guard = (read: ReadAttachment): ReadAttachment => (docId, attachId, attachment, options, callback) => {
    const check = (txn: IDBTransaction) => {
      const count = txn.objectStore(ATTACH_STORE).count(attachment.digest ?? "")
      count.onsuccess = () => {
        if (count.result) return read(docId, attachId, attachment, { ...options, ctx: txn }, callback)
        callback(Object.assign(new Error(`Attachment ${attachId} of ${docId} has no stored bytes`), {
          status: 404, name: "not_found", reason: MISSING_BYTES
        }))
      }
      count.onerror = () => callback(count.error)
    }
    if (options.ctx) return check(options.ctx)
    open().then(opened => check(opened.transaction(ATTACH_STORE, "readonly")), callback)
  }
  let current = pouch._getAttachment && guard(pouch._getAttachment.bind(pouch))
  Object.defineProperty(pouch, "_getAttachment", {
    configurable: true,
    get: () => current,
    set: (read: ReadAttachment) => { current = guard(read) }
  })
  return db
}
