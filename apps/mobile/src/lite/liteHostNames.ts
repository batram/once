// Each extension's host (`moz-extension://<host>`, `https://<host>.moz-extension.localhost`)
// is random per install, as Firefox gives every extension a UUID of its own
// in each profile: a page that probes an extension's web-accessible files,
// or reads the origins in its own policy, cannot tell which extension it is
// from a host every Once install shares. The hosts are kept in the manager's
// `hosts.json`. An extension that already has data under the host derived
// from its id (an install from before) keeps that host, since its stores and
// its pages' WebView storage live under it.

import { hostForExtensionId } from "@once/webext-runtime"
import { JavaChannel } from "./javaChannel"
import { LiteJsonStore } from "./liteStorage"

const DOCUMENT = "hosts.json"

function randomHost(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export class LiteHostNames {
  private readonly store: LiteJsonStore
  private hosts: Promise<Record<string, string>> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly channel: JavaChannel, private readonly storageRoot: string) {
    this.store = new LiteJsonStore(channel, `${storageRoot}/manager`)
  }

  private load(): Promise<Record<string, string>> {
    this.hosts ??= this.store.read(DOCUMENT).then(
      (value) => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, string> : {}),
      () => ({})
    )
    return this.hosts
  }

  /** The extension's host on this install, chosen (and kept) the first time it is asked for. */
  async hostFor(id: string): Promise<string> {
    const hosts = await this.load()
    const known = hosts[id]
    if (typeof known === "string" && /^[0-9a-f]{32}$/.test(known)) return known
    const legacy = hostForExtensionId(id)
    const existing = await this.channel.request<{ entries?: string[] }>("files.list", { directory: this.storageRoot })
      .then((result) => result.entries ?? [], () => [] as string[])
    const host = existing.includes(legacy) ? legacy : randomHost()
    hosts[id] = host
    this.writing = this.writing.then(() => this.store.write(DOCUMENT, hosts)).catch((error) => {
      this.channel.log("error", `Extension hosts were not saved: ${String(error)}`)
    })
    await this.writing
    return host
  }
}
