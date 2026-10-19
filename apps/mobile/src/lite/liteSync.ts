// Answers to content worlds' synchronous requests, kept by Java. A world
// asks for its extension's registered scripts (`/_once/dynamic`) and
// Violentmonkey's content script for the blob the background prepared for
// the document (`/_once/blob/<id>`) with synchronous XMLHttpRequests at
// document start, which block the renderer main thread every WebView
// shares; the broker, in that same renderer, could never answer. So the
// broker hands Java the answers ahead of time (`sync.set`), and Java fulfils
// those requests from memory at the Fetch request stage.

import {
  HttpHeader,
  VIOLENTMONKEY_ID,
  WebRequestDetailsInput,
  buildWebRequestDetails,
  mergeBlockingResponses
} from "@once/webext-runtime"
import { JavaChannel } from "./javaChannel"
import { LiteExtensionHost } from "./liteHosts"
import { dynamicScripts } from "./liteWorlds"
import { BLOB_PATH, DYNAMIC_PATH, SyncAnswerParams, WorldDynamicConfig, WorldScript, dynamicAnswerPath, pageOrigin } from "./protocol"

interface QueuedInjection {
  host: LiteExtensionHost
  tabId: number
  frameId: number
  script: WorldScript
}

export class LiteSyncAnswers {
  private readonly dirty = new Set<LiteExtensionHost>()
  private flushing: Promise<void> | null = null
  /** `tabs.executeScript` calls aimed at a document still held at its response stage. */
  private queued: QueuedInjection[] = []

  constructor(
    private readonly channel: JavaChannel,
    private readonly readBlob: (host: LiteExtensionHost, blobUrl: string) => Promise<string | null>
  ) {}

  private set(host: string, path: string, body: string | null): Promise<void> {
    return this.channel.request("sync.set", { host, path, body } satisfies SyncAnswerParams).then(() => undefined)
  }

  /** The host's registered scripts changed; Java gets the new answer at the next flush. */
  scriptsChanged(host: LiteExtensionHost): void {
    this.dirty.add(host)
  }

  /** Sends every changed answer; a document waits for this before it continues. */
  async flush(): Promise<void> {
    if (this.flushing) await this.flushing
    if (this.dirty.size === 0) return
    const hosts = [...this.dirty]
    this.dirty.clear()
    this.flushing = Promise.all(hosts.map((host) =>
      this.set(host.extension.host, DYNAMIC_PATH, JSON.stringify(dynamicScripts(host)))
    )).then(() => undefined).catch((error) => this.channel.log("error", `Registered scripts were not handed to Java: ${String(error)}`))
    await this.flushing
    this.flushing = null
  }

  forget(host: LiteExtensionHost): void {
    this.dirty.delete(host)
    this.queued = this.queued.filter((entry) => entry.host !== host)
    void this.set(host.extension.host, DYNAMIC_PATH, null).catch(() => undefined)
  }

  /**
   * A `tabs.executeScript {runAt: "document_start"}` for a frame whose
   * document is still held: Firefox runs it once that document starts, and
   * Violentmonkey's synchronous injection relies on that for the content
   * realm. It joins the document's own answer and runs from the world.
   */
  queueInjection(host: LiteExtensionHost, tabId: number, frameId: number, code: string, url: string): void {
    if (this.queued.length >= 256) this.queued.shift()
    this.queued.push({ host, tabId, frameId, script: {
      matches: ["<all_urls>"], excludeMatches: [], allFrames: true, matchAboutBlank: true,
      runAt: "document_start", world: "ISOLATED", js: [{ url, code }], css: []
    } })
  }

  private takeQueued(host: LiteExtensionHost, tabId: number, frameId: number): WorldScript[] {
    const mine = this.queued.filter((entry) => entry.host === host && entry.tabId === tabId && entry.frameId === frameId)
    if (mine.length === 0) return []
    this.queued = this.queued.filter((entry) => !mine.includes(entry))
    return mine.map((entry) => entry.script)
  }

  /**
   * Violentmonkey's synchronous injection: its `onHeadersReceived` listener
   * adds `Set-Cookie: <host>=<blob id>` to a document whose scripts it
   * prepared in a blob of its own origin. The blob is read through its
   * background page now and handed to Java under the id, so the content
   * script's request for it at document start is answered without the
   * broker. Answers the headers, possibly with the cookie added late.
   */
  async prepareBlobs(hosts: Iterable<LiteExtensionHost>, headers: HttpHeader[], input?: WebRequestDetailsInput): Promise<HttpHeader[]> {
    const all = [...hosts]
    const violentmonkey = all.find((host) => host.extension.id === VIOLENTMONKEY_ID)
    if (violentmonkey && input && !namesBlob(headers, violentmonkey.extension.host)) {
      headers = await this.retryHeaders(violentmonkey, input, headers)
    }
    const cookies = headers.filter((header) => header.name.toLowerCase() === "set-cookie").map((header) => header.value)
    const work: Promise<void>[] = []
    for (const host of all) {
      const name = host.extension.host
      const queued = input ? this.takeQueued(host, input.tabId, input.frame.frameId) : []
      let cookie: string | undefined
      for (const value of cookies) {
        const match = new RegExp(`^\\s*${name}=([^;\\s]+)`).exec(value)
        if (match && match[1] !== "0") cookie = match[1]
      }
      if (!cookie && queued.length === 0) continue
      work.push((async () => {
        if (cookie) {
          const text = await this.readBlob(host, `blob:${pageOrigin(name)}/${cookie}`)
          if (text === null) {
            this.channel.log("warn", `${host.extension.name} named a blob the broker could not read`)
            cookie = undefined
          } else {
            await this.set(name, `${BLOB_PATH}${cookie}`, text)
          }
        }
        // The document's own answer: its queued injections, and the cookie naming the blob.
        if (input) {
          const base = dynamicScripts(host)
          const config: WorldDynamicConfig = { host: name, scripts: [...base.scripts, ...queued] }
          if (cookie) config.cookie = `${name}=${cookie}`
          await this.set(name, dynamicAnswerPath(input.url), JSON.stringify(config))
        }
      })().catch((error) => this.channel.log("warn", `Document answer for ${host.extension.name} not prepared: ${String(error)}`)))
    }
    await Promise.all(work)
    return headers
  }

  /**
   * Violentmonkey prepares a document's injection from `onSendHeaders` and
   * names it from `onHeadersReceived` only once that preparation is done;
   * with a fast server the headers can beat it. Its listener is asked again,
   * briefly, before the document goes on without the cookie.
   */
  private async retryHeaders(host: LiteExtensionHost, input: WebRequestDetailsInput, headers: HttpHeader[]): Promise<HttpHeader[]> {
    const targets = host.contexts.targets("webRequest", "onHeadersReceived")
    if (targets.length === 0) return headers
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
      const details = buildWebRequestDetails({ ...input, responseHeaders: headersRecord(headers) })
      const responses: unknown[] = []
      for (const target of targets) {
        responses.push(...await host.contexts.request(target, "webRequest", "onHeadersReceived", [details], RETRY_REPLY_MS))
      }
      const merged = mergeBlockingResponses(responses)
      if (merged.responseHeaders && namesBlob(merged.responseHeaders, host.extension.host)) return merged.responseHeaders
    }
    return headers
  }
}

const RETRY_ATTEMPTS = 4
const RETRY_DELAY_MS = 25
const RETRY_REPLY_MS = 1_000

function namesBlob(headers: readonly HttpHeader[], host: string): boolean {
  return headers.some((header) => header.name.toLowerCase() === "set-cookie" && new RegExp(`^\\s*${host}=(?!0;)`).test(header.value))
}

function headersRecord(headers: readonly HttpHeader[]): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {}
  for (const { name, value } of headers) {
    const existing = record[name]
    if (existing === undefined) record[name] = value
    else if (Array.isArray(existing)) existing.push(value)
    else record[name] = [existing, value]
  }
  return record
}
