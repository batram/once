// Answers to content worlds' synchronous requests, kept by Java. A world
// asks for what the broker prepared for its document (`dynamicAnswerPath`:
// registered scripts, queued injections, Violentmonkey's cookie) and
// Violentmonkey's content script for the blob the background prepared
// (`blobAnswerPath`) with synchronous XMLHttpRequests at document start,
// which block the renderer main thread every WebView shares; the broker, in
// that same renderer, could never answer. So the broker hands Java the
// answers for each document before it continues (`sync.set`), and Java
// fulfils those requests from memory at the Fetch request stage, each once.
//
// The paths carry `syncKey(token, documentUrl)`: the worlds hold the token
// and compute the key of their own document, pages do not. A page that
// watches its own resource timing learns the key of its own document only,
// whose answer its world has taken by then.

import {
  HttpHeader,
  VIOLENTMONKEY_ID,
  WebRequestDetailsInput,
  buildWebRequestDetails,
  canInjectFrame,
  mergeBlockingResponses,
  sha256Hex
} from "@once/webext-runtime"
import { MatchPatternSet } from "@once/core"
import { JavaChannel } from "./javaChannel"
import { LiteExtensionHost } from "./liteHosts"
import { dynamicScripts } from "./liteWorlds"
import { SyncAnswerParams, WorldDynamicConfig, WorldScript, blobAnswerPath, dynamicAnswerPath, pageOrigin, syncDocumentUrl } from "./protocol"

/** The key of a document's synchronous answers; `worldSyncKey` in the world bootstrap derives the same. */
export function syncKey(token: string, documentUrl: string): string {
  return sha256Hex(`${token}|sync|${syncDocumentUrl(documentUrl)}`).slice(0, 32)
}

interface QueuedInjection {
  host: LiteExtensionHost
  tabId: number
  frameId: number
  script: WorldScript
  document: WebRequestDetailsInput
}

interface RegisteredScripts {
  scripts: { script: WorldScript; matches: MatchPatternSet; excludes: MatchPatternSet }[]
}

export class LiteSyncAnswers {
  /** `tabs.executeScript` calls aimed at a document still held at its response stage. */
  private queued: QueuedInjection[] = []
  /** Each host's registered scripts as worlds take them, rebuilt after a change. */
  private readonly registered = new WeakMap<LiteExtensionHost, RegisteredScripts>()

  constructor(
    private readonly channel: JavaChannel,
    private readonly readBlob: (host: LiteExtensionHost, blobUrl: string) => Promise<string | null>,
    private readonly token: () => string
  ) {}

  private set(host: string, path: string, body: string | null, document: { targetId: string; frameId: string }): Promise<void> {
    return this.channel.request("sync.set", { host, path, body, ...document } satisfies SyncAnswerParams).then(() => undefined)
  }

  /** The host's registered scripts changed; the next document takes the new set. */
  scriptsChanged(host: LiteExtensionHost): void {
    this.registered.delete(host)
  }

  forget(host: LiteExtensionHost): void {
    this.registered.delete(host)
    this.queued = this.queued.filter((entry) => entry.host !== host)
  }

  /**
   * A `tabs.executeScript {runAt: "document_start"}` for a frame whose
   * document is still held: Firefox runs it once that document starts, and
   * Violentmonkey's synchronous injection relies on that for the content
   * realm. It joins the document's own answer and runs from the world.
   */
  queueInjection(host: LiteExtensionHost, tabId: number, frameId: number, code: string, url: string, document: WebRequestDetailsInput): void {
    if (this.queued.length >= 256) this.queued.shift()
    this.queued.push({ host, tabId, frameId, document, script: {
      matches: ["<all_urls>"], excludeMatches: [], allFrames: true, matchAboutBlank: true,
      runAt: "document_start", world: "ISOLATED", js: [{ url, code }], css: []
    } })
  }

  private takeQueued(host: LiteExtensionHost, input: WebRequestDetailsInput): WorldScript[] {
    const mine = this.queued.filter((entry) => entry.host === host && entry.document.id === input.id)
    if (mine.length === 0) return []
    this.queued = this.queued.filter((entry) => !mine.includes(entry))
    return canInjectFrame(host, input.tabId, input.url) ? mine.map((entry) => entry.script) : []
  }

  /** The host's registered scripts whose patterns match the document; the world still checks frames. */
  private matching(host: LiteExtensionHost, url: string, isTop: boolean): WorldScript[] {
    if (host.registeredScripts.size === 0) return []
    let registered = this.registered.get(host)
    if (!registered) {
      registered = { scripts: dynamicScripts(host).scripts.map((script) => ({
        script, matches: new MatchPatternSet(script.matches), excludes: new MatchPatternSet(script.excludeMatches)
      })) }
      this.registered.set(host, registered)
    }
    return registered.scripts
      .filter(({ script, matches, excludes }) => (isTop || script.allFrames) && matches.matches(url) && !excludes.matches(url))
      .map(({ script }) => script)
  }

  /**
   * Before a document continues: each extension's answer for it, when it has
   * one. Violentmonkey's synchronous injection is part of it: its
   * `onHeadersReceived` listener adds `Set-Cookie: <host>=<blob id>` to a
   * document whose scripts it prepared in a blob of its own origin. The blob
   * is read through its background page now and handed to Java under the
   * document's key, so the content script's request for it at document start
   * is answered without the broker. Answers the headers, possibly with the
   * cookie added late.
   */
  async prepareDocument(hosts: Iterable<LiteExtensionHost>, headers: HttpHeader[], input: WebRequestDetailsInput, document: { targetId: string; frameId: string }): Promise<HttpHeader[]> {
    const all = [...hosts]
    const violentmonkey = all.find((host) => host.extension.id === VIOLENTMONKEY_ID)
    if (violentmonkey && !namesBlob(headers, violentmonkey.extension.host)) {
      headers = await this.retryHeaders(violentmonkey, input, headers)
    }
    const cookies = headers.filter((header) => header.name.toLowerCase() === "set-cookie").map((header) => header.value)
    const isTop = input.frame.frameId === 0
    const key = syncKey(this.token(), input.url)
    const work: Promise<void>[] = []
    for (const host of all) {
      const name = host.extension.host
      const scripts = [...this.matching(host, input.url, isTop), ...this.takeQueued(host, input)]
      let cookie: string | undefined
      for (const value of cookies) {
        const match = new RegExp(`^\\s*${name}=([^;\\s]+)`).exec(value)
        if (match && match[1] !== "0") cookie = match[1]
      }
      if (!cookie && scripts.length === 0) continue
      work.push((async () => {
        if (cookie) {
          const text = /^[\w-]+$/.test(cookie) ? await this.readBlob(host, `blob:${pageOrigin(name)}/${cookie}`) : null
          if (text === null) {
            this.channel.log("warn", `${host.extension.name} named a blob the broker could not read`)
            cookie = undefined
          } else {
            await this.set(name, blobAnswerPath(key, cookie, input.url), text, document)
          }
        }
        if (!cookie && scripts.length === 0) return
        const config: WorldDynamicConfig = { host: name, scripts }
        if (cookie) config.cookie = `${name}=${cookie}`
        await this.set(name, dynamicAnswerPath(key, input.url), JSON.stringify(config), document)
      })().catch((error) => this.channel.log("warn", `Document answer for ${host.extension.name} not prepared: ${String(error)}`)))
    }
    await Promise.all(work)
    return headers
  }

  /**
   * Violentmonkey prepares a document's injection from `onSendHeaders` and
   * names it from `onHeadersReceived` only once that preparation is done;
   * with a fast server the headers can beat it. Its listener is asked again,
   * briefly, before the document goes on without the cookie: when it has
   * scripts at all, since every document would otherwise wait ~100 ms.
   */
  private async retryHeaders(host: LiteExtensionHost, input: WebRequestDetailsInput, headers: HttpHeader[]): Promise<HttpHeader[]> {
    const targets = host.contexts.targets("webRequest", "onHeadersReceived")
    if (targets.length === 0) return headers
    // Without a single script (Violentmonkey keeps each under `scr:<id>`) there is nothing it could prepare.
    if (host.storage.someKey((key) => key.startsWith("scr:")) === false) return headers
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
