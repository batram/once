// The content-world registration of each loaded extension: one
// `Page.addScriptToEvaluateOnNewDocument` source per extension, installed by
// Java on every tab target in world `once-ext:<host>`. The source is the
// built world bootstrap followed by a boot call with the extension's
// identity and every one of its content scripts, static and registered;
// the bootstrap matches them against the frame it finds itself in (about:blank
// frames by their top URL when `matchAboutBlank` asks) and schedules them.
// Whenever a registration changes (`contentScripts.register`, `scripting`),
// the whole set is sent again and Java replaces what it installed.

import { ContentScript, LoadedExtension } from "@once/webext-runtime"
import { JavaChannel } from "./javaChannel"
import { LiteExtensionHost } from "./liteHosts"
import { WorldConfig, WorldRegistration, WorldScript, WorldsSetParams, WORLD_BINDING, worldNameFor } from "./protocol"

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

export function worldConfig(host: LiteExtensionHost, locale: string, token: string): WorldConfig {
  const extension: LoadedExtension = host.extension
  const scripts: WorldScript[] = []
  for (const script of host.contentScripts()) {
    try {
      scripts.push(scriptEntry(host, script))
    } catch (error) {
      console.error(`[${extension.name}] content script skipped: ${String(error)}`)
    }
  }
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

export function worldRegistration(bundle: string, host: LiteExtensionHost, locale: string, token: string): WorldRegistration {
  return {
    worldName: worldNameFor(host.extension.host),
    source: worldSource(bundle, worldConfig(host, locale, token)),
    binding: WORLD_BINDING
  }
}

/** Sends the current registrations to Java; coalesces bursts of changes. */
export class LiteWorlds {
  private timer: ReturnType<typeof setTimeout> | null = null
  private current: WorldRegistration[] = []

  constructor(
    private readonly channel: JavaChannel,
    private readonly bundle: () => string,
    private readonly hosts: () => Iterable<LiteExtensionHost>,
    private readonly locale: () => string,
    private readonly token: () => string
  ) {}

  registrations(): WorldRegistration[] {
    return this.current
  }

  /** Rebuilds and sends; resolves once Java has installed the set. */
  async update(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const bundle = this.bundle()
    this.current = [...this.hosts()].map((host) => worldRegistration(bundle, host, this.locale(), this.token()))
    await this.channel.request("worlds.set", { registrations: this.current } satisfies WorldsSetParams)
  }

  /** A registration changed; sent after the current burst of changes settles. */
  schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.update().catch((error) => this.channel.log("error", `World registration failed: ${String(error)}`))
    }, 50)
  }
}
