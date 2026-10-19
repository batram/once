// The `GeckoViolentmonkey` plugin contract, answered by the broker. Java's
// `LiteViolentmonkeyPlugin` relays `send {cmd, data}` as `violentmonkey.send`,
// `handingOff`/`settled` as `violentmonkey.handingOff`/`violentmonkey.settled`,
// and raises the plugin's `connected` and `dashboardChanged` events from the
// broker's `violentmonkey.connected`/`violentmonkey.dashboardChanged`.
//
// On GeckoView the relay ran inside an adapted Violentmonkey bundle. Lite
// loads the plain bundle and does what the relay did from the privileged
// side, the Electron way: dashboard commands go through a `VirtualContext`
// (a page of the extension as far as Violentmonkey can tell), and the two
// commands the relay added itself, `OnceReadRecords`/`OnceWriteRecords`, are
// kept in the Violentmonkey host's own JSON store beside its storage.

import { ApiHost, VIOLENTMONKEY_ID, VirtualContext } from "@once/webext-runtime"
import { JavaChannel, RequestError } from "./javaChannel"
import { ViolentmonkeySendParams } from "./protocol"

const RECORDS = "once-relay-records.json"
const STARTUP_TIMEOUT_MS = 60_000
/** Commands the relay never offered the app: they would run code in a page. */
const REFUSED = new Set(["InjectionFeedback", "InjectScript", "GetInjected", "Run"])

export class LiteViolentmonkey {
  private host: ApiHost | null = null
  private releaseDocuments: (() => void) | null = null
  private held: Promise<void> = Promise.resolve()
  private releaseTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly channel: JavaChannel) {
    channel.onRequest("violentmonkey.send", (params) => this.send(params as ViolentmonkeySendParams))
    channel.onRequest("violentmonkey.handingOff", () => this.handingOff())
    channel.onRequest("violentmonkey.settled", () => this.settled())
  }

  /** Resolves when tab documents may load; the hand-off holds them while scripts change. */
  documentsReleased(): Promise<void> {
    return this.held
  }

  /** A host loaded or unloaded; the Violentmonkey one is watched. */
  hostChanged(hosts: Iterable<ApiHost>): void {
    const host = [...hosts].find((candidate) => candidate.extension.id === VIOLENTMONKEY_ID) ?? null
    if (host === this.host) return
    this.host = host
    if (!host) return
    host.storage.onChanged(() => {
      if (!this.applying) this.channel.event("violentmonkey.dashboardChanged")
    })
    void host.contexts.whenListening("runtime", "onMessage", STARTUP_TIMEOUT_MS).then(
      async () => {
        if (this.host !== host) return
        // Synchronous page mode, as the Gecko relay turned on: the background
        // prepares each document's injection at its response stage and the
        // content script fetches it with a synchronous request, so
        // `@run-at document-start` scripts run before the page's own.
        const context = new VirtualContext(host)
        try {
          await context.sendMessage({ cmd: "SetOptions", data: { xhrInject: true } })
        } catch (error) {
          this.channel.log("warn", `Violentmonkey did not take xhrInject: ${String(error)}`)
        } finally {
          context.close()
        }
        this.channel.event("violentmonkey.connected")
      },
      () => undefined
    )
  }

  private applying = false

  private async send(params: ViolentmonkeySendParams): Promise<{ value: unknown }> {
    const host = this.host
    if (!host) throw new RequestError("Violentmonkey is not running", "NOT_RUNNING")
    if (typeof params?.cmd !== "string") throw new Error("cmd is required")
    if (params.cmd === "OnceReadRecords") {
      const value = await host.store.read(RECORDS).catch(() => undefined)
      return { value: value ?? {} }
    }
    if (params.cmd === "OnceWriteRecords") {
      await host.store.write(RECORDS, params.data ?? {})
      return { value: null }
    }
    if (REFUSED.has(params.cmd)) throw new Error(`${params.cmd} is not available to the app`)
    await host.contexts.whenListening("runtime", "onMessage", STARTUP_TIMEOUT_MS)
    const context = new VirtualContext(host)
    this.applying = true
    try {
      return { value: (await context.sendMessage({ cmd: params.cmd, data: params.data })) ?? null }
    } finally {
      this.applying = false
      context.close()
    }
  }

  private handingOff(): void {
    if (this.releaseDocuments) return
    this.held = new Promise((resolve) => {
      this.releaseDocuments = resolve
    })
    // A hand-off that never settles must not hold the surface forever.
    this.releaseTimer = setTimeout(() => this.settled(), 60_000)
  }

  private settled(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer)
    this.releaseTimer = null
    const release = this.releaseDocuments
    this.releaseDocuments = null
    release?.()
  }
}
