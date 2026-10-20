// The content-world registration of each loaded extension: one
// `Page.addScriptToEvaluateOnNewDocument` source per extension, installed by
// Java on every tab target in world `once-ext:<host>`. The source is the
// built world bootstrap followed by a boot call with the extension's
// identity and every one of its content scripts, static and registered;
// the bootstrap matches them against the frame it finds itself in (about:blank
// frames by their top URL when `matchAboutBlank` asks) and schedules them.
// Whenever a registration changes (`contentScripts.register`, `scripting`),
// the whole set is sent again and Java replaces what it installed.

import { ContentScript, LoadedExtension, manifestContentScripts } from "@once/webext-runtime"
import { JavaChannel } from "./javaChannel"
import { LiteExtensionHost } from "./liteHosts"
import { TabPageRegistration, WorldConfig, WorldDynamicConfig, WorldRegistration, WorldScript, WorldsSetParams, WORLD_BINDING, pageOrigin, worldNameFor } from "./protocol"

/** The function the world bootstrap bundle defines for the boot call. */
export const WORLD_BOOT = "__onceLiteWorldBoot"

function scriptEntry(host: LiteExtensionHost, script: ContentScript): WorldScript {
  const { spec, inlineJs, inlineCss } = script
  const js = spec.js.map((file) => ({ url: `moz-extension://${host.extension.host}/${file.replace(/^\/+/, "")}`, code: host.files.read(file) }))
  for (const code of inlineJs) js.push({ url: `moz-extension://${host.extension.host}/_registered_content_script.js`, code })
  const css = [...spec.css.map((file) => host.files.read(file)), ...inlineCss]
  return {
    matches: [...spec.matches],
    excludeMatches: [...spec.excludeMatches],
    allFrames: spec.allFrames,
    matchAboutBlank: spec.matchAboutBlank,
    runAt: spec.runAt,
    world: spec.world ?? "ISOLATED",
    js,
    css
  }
}

function entries(host: LiteExtensionHost, scripts: Iterable<ContentScript>): WorldScript[] {
  const out: WorldScript[] = []
  for (const script of scripts) {
    try {
      out.push(scriptEntry(host, script))
    } catch (error) {
      console.error(`[${host.extension.name}] content script skipped: ${String(error)}`)
    }
  }
  return out
}

export function worldConfig(host: LiteExtensionHost, locale: string, token: string, channel = ""): WorldConfig {
  const extension: LoadedExtension = host.extension
  const scripts = entries(host, manifestContentScripts(extension.manifest.contentScripts))
  return {
    init: {
      id: extension.id,
      host: extension.host,
      kind: "content",
      manifest: extension.rawManifest,
      messages: extension.messages,
      uiLanguage: locale
    },
    token,
    channel,
    scripts
  }
}

/** The registration source: the bootstrap bundle, then the boot call with the config. */
export function worldSource(bundle: string, config: WorldConfig): string {
  // `</script` cannot appear here (DevTools evaluates the text directly) but
  // U+2028/2029 would break a JS string literal, so they are escaped.
  const json = JSON.stringify(config).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
  return `${bundle}\n;${WORLD_BOOT}(${json});`
}

export function worldRegistration(bundle: string, host: LiteExtensionHost, locale: string, token: string, channel = ""): WorldRegistration {
  return {
    id: worldNameFor(host.extension.host),
    worldName: worldNameFor(host.extension.host),
    source: worldSource(bundle, worldConfig(host, locale, token, channel)),
    binding: WORLD_BINDING
  }
}

/** The registered scripts of a host, as the world's synchronous `_once/dynamic` request is answered. */
export function dynamicScripts(host: LiteExtensionHost): WorldDynamicConfig {
  return { host: host.extension.host, scripts: entries(host, host.registeredScripts.values()) }
}

/** Sends the current registrations to Java; coalesces bursts of changes. */
export class LiteWorlds {
  private timer: ReturnType<typeof setTimeout> | null = null
  private current: WorldRegistration[] = []
  private dirty = false
  private restoreDepth = 0
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly channel: JavaChannel,
    private readonly bundle: () => string,
    private readonly hosts: () => Iterable<LiteExtensionHost>,
    private readonly locale: () => string,
    private readonly token: () => string,
    /** The page bootstrap source for one of a host's pages shown inside a tab. */
    private readonly pageSource: (host: LiteExtensionHost) => string = () => "",
    private readonly channelToken: () => string = () => ""
  ) {}

  registrations(): WorldRegistration[] {
    return this.current
  }

  /** Initial restoration holds navigation; intermediate updates are sent once at its end. */
  async batchRestore(work: () => Promise<void>): Promise<void> {
    this.restoreDepth++
    try { await work() } finally {
      this.restoreDepth--
      if (this.restoreDepth === 0) await this.update()
    }
  }

  /** Rebuilds and sends; resolves once Java has installed the set. */
  update(): Promise<void> {
    if (this.restoreDepth) {
      this.dirty = true
      return Promise.resolve()
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.dirty = false
    const bundle = this.bundle()
    const hosts = [...this.hosts()]
    const sources = this.static(bundle, hosts)
    this.current = hosts.map((host) => sources.get(host) as WorldRegistration)
    const pages: TabPageRegistration[] = hosts.map((host) => ({
      host: host.extension.host, origin: pageOrigin(host.extension.host), documentStartSource: this.pageSource(host)
    })).filter((page) => page.documentStartSource !== "")
    const sending = this.channel.request("worlds.set", { registrations: this.current, pages } satisfies WorldsSetParams).then(() => undefined)
    this.inFlight = sending
    return sending.finally(() => { if (this.inFlight === sending) this.inFlight = null })
  }

  /** The bootstrap registrations are rebuilt only when a host's manifest scripts could have changed (a load). */
  private readonly statics = new WeakMap<LiteExtensionHost, WorldRegistration>()

  private static(bundle: string, hosts: LiteExtensionHost[]): Map<LiteExtensionHost, WorldRegistration> {
    const map = new Map<LiteExtensionHost, WorldRegistration>()
    for (const host of hosts) {
      let registration = this.statics.get(host)
      if (!registration) {
        registration = worldRegistration(bundle, host, this.locale(), this.token(), this.channelToken())
        this.statics.set(host, registration)
      }
      map.set(host, registration)
    }
    return map
  }

  /** A registration changed; sent after the current burst of changes settles. */
  schedule(): void {
    this.dirty = true
    if (this.restoreDepth) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, 50)
  }

  /** Sends pending changes now and resolves once Java has them. */
  async flush(): Promise<void> {
    if (this.inFlight) await this.inFlight.catch(() => undefined)
    if (!this.dirty) return
    await this.update().catch((error) => this.channel.log("error", `World registration failed: ${String(error)}`))
  }
}
