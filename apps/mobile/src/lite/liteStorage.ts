// `JsonStore` over Java: one JSON document per name under
// `<files>/lite-extensions/<directory>/<name>`. Extension storage writes the
// keys that changed (`store.patch`, merged by Java on disk; `ExtensionStorage`
// tracks them, so nothing here serialises or keeps the whole document);
// everything else, and a document's first write, goes whole (`store.write`,
// replaced atomically). uBlock's `storage.json` runs to tens of megabytes
// and is written dozens of times during a list reload, so whole writes
// would flood the channel.

import { JsonStore } from "@once/webext-runtime"
import { JavaChannel } from "./javaChannel"
import { FilesInterface } from "./liteFiles"
import { StorePatchParams, StoreReadParams, StoreReadResult, StoreValue, StoreWriteParams } from "./protocol"

/** Values beyond this travel through the synchronous chunk interface, never as one message. */
export const CHUNK_THRESHOLD = 256 * 1024
const CHUNK_CHARS = 512 * 1024
const READ_CHUNK_BYTES = 1024 * 1024

export class LiteJsonStore implements JsonStore {
  constructor(
    private readonly channel: JavaChannel,
    private readonly directory: string,
    private readonly files: FilesInterface | null = null
  ) {}

  async read(name: string): Promise<unknown> {
    const result = await this.channel.request<StoreReadResult>("store.read", {
      directory: this.directory, name
    } satisfies StoreReadParams)
    let text = result.json
    if (result.chunked) text = this.readChunks(result.chunked)
    if (text === null) return undefined
    return JSON.parse(text)
  }

  async write(name: string, value: unknown): Promise<void> {
    await this.channel.request("store.write", {
      directory: this.directory, name, json: this.outgoing(JSON.stringify(value))
    } satisfies StoreWriteParams)
  }

  /** Only the changed keys (`ExtensionStorage` knows them), each value serialised once. */
  async patch(name: string, set: Record<string, unknown>, remove: string[]): Promise<void> {
    const values: Record<string, StoreValue> = {}
    for (const [key, value] of Object.entries(set)) {
      if (value !== undefined) values[key] = this.outgoing(JSON.stringify(value))
    }
    if (Object.keys(values).length === 0 && remove.length === 0) return
    await this.channel.request("store.patch", { directory: this.directory, name, set: values, remove } satisfies StorePatchParams)
  }

  /** A large value goes through `writeChunk` first; the message then names the token. */
  private outgoing(text: string): StoreValue {
    if (text.length <= CHUNK_THRESHOLD || typeof this.files?.writeChunk !== "function") return text
    const token = crypto.randomUUID()
    for (let offset = 0; offset < text.length; offset += CHUNK_CHARS) {
      // Never split a surrogate pair: Java re-encodes each piece as UTF-8 on its own.
      let end = Math.min(text.length, offset + CHUNK_CHARS)
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1
      const answer = this.files.writeChunk(token, text.slice(offset, end))
      if (answer !== "ok") throw new Error(`Store chunk refused: ${answer}`)
      if (end < offset + CHUNK_CHARS) offset = end - CHUNK_CHARS
    }
    return { chunked: token }
  }

  private readChunks(token: string): string {
    if (typeof this.files?.readChunk !== "function") throw new Error("Chunked store reads are not available")
    const parts: string[] = []
    for (;;) {
      const piece = JSON.parse(this.files.readChunk(token, READ_CHUNK_BYTES)) as { text?: string; done?: boolean; error?: string }
      if (piece.error) throw new Error(piece.error)
      if (piece.text) parts.push(piece.text)
      if (piece.done) break
    }
    return parts.join("")
  }
}
