import { Capacitor, PluginListenerHandle, registerPlugin } from "@capacitor/core"
import {
  AppliedUserscript,
  handUserscriptsToViolentmonkey,
  UserscriptsDocument
} from "@once/core"

interface NativeViolentmonkeyPlugin {
  send(options: { cmd: string; data?: unknown }): Promise<{ value?: unknown }>
  /** Holds pages that open from now on until `settled`: scripts are being written. */
  handingOff(): Promise<void>
  /** Lets pages held for the hand-off open. */
  settled(): Promise<void>
  addListener(event: "connected" | "dashboardChanged", listener: () => void): Promise<PluginListenerHandle>
}

/**
 * Hands synced userscripts to the bundled Violentmonkey, which runs them with
 * its own GM API and isolation, as on Electron. The two-way reconciliation
 * means scripts installed or edited in Violentmonkey's dashboard come back.
 */
export interface ViolentmonkeyHandOff {
  /**
   * Writes the document into Violentmonkey; resolves with the document as it
   * should now read when the dashboard changed it. Does nothing while
   * Violentmonkey is not running; `onConnected` says when to try again.
   */
  apply(document: UserscriptsDocument): Promise<UserscriptsDocument | undefined>
  /** Violentmonkey's background started, or started again. */
  onConnected(listener: () => void): void
  /** A script was edited, toggled, installed or removed in Violentmonkey's dashboard. */
  onDashboardChanged(listener: () => void): void
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function readRecords(value: unknown): Record<string, AppliedUserscript> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, record]) =>
    typeof record === "object" && record !== null && typeof (record as AppliedUserscript).id === "number"
  )) as Record<string, AppliedUserscript>
}

/** Null where userscripts run some other way (iOS installs them itself). */
export function createViolentmonkeyHandOff(): ViolentmonkeyHandOff | null {
  if (Capacitor.getPlatform() !== "android") return null
  const plugin = registerPlugin<NativeViolentmonkeyPlugin>("GeckoViolentmonkey")
  const send = async (cmd: string, data?: unknown): Promise<unknown> =>
    (await plugin.send({ cmd, data })).value ?? null
  // One hand-off at a time, and only the newest document waiting behind it:
  // two interleaved plans would each read the other's writes as dashboard edits.
  let queue: Promise<unknown> = Promise.resolve()
  let latest = 0
  let verified: { document: string; token: string } | undefined
  const run = async (document: UserscriptsDocument): Promise<UserscriptsDocument | undefined> => {
    // The records live in Violentmonkey's own storage, so they are lost with
    // its scripts or not at all: a missing script is always a deletion.
    const signature = JSON.stringify(document)
    let snapshot: { records?: unknown; scripts?: unknown; unchanged?: boolean; token?: string }
    const previous = verified
    verified = undefined
    try {
      try {
        snapshot = await send("OnceReadSnapshot", { token: previous?.document === signature ? previous.token : undefined }) as typeof snapshot
      } catch (error) {
        // An already-running background may still carry the previous relay
        // while the shell updates. Only an explicit unsupported command falls
        // back; transport/storage failures must not become empty snapshots.
        if (!String(error).includes("Not a command Once hands to Violentmonkey: OnceReadSnapshot")) throw error
        const [records, scripts] = await Promise.all([send("OnceReadRecords"), send("ExportZip", { values: false })])
        snapshot = { records, scripts }
      }
      if (snapshot?.unchanged === true && previous?.document === signature && snapshot.token === previous.token) {
        verified = previous
        await plugin.settled()
        return undefined
      }
      if (!snapshot || typeof snapshot !== "object" || !("scripts" in snapshot)) {
        throw new Error("Violentmonkey did not provide its reconciliation snapshot")
      }
    } catch (error) {
      if ((error as { code?: string }).code === "NOT_RUNNING") return undefined
      throw error
    }
    try {
      // A page opening while scripts change would load before Violentmonkey
      // has them and run `@run-at document-start` scripts late, or not at all.
      await plugin.handingOff()
      const applied = readRecords(snapshot.records)
      // ExportZip and the records travelled together. Reuse that exact script
      // snapshot for planning, rather than exporting all source text again.
      let mutated = false
      const snapshotSend = (cmd: string, data?: unknown): Promise<unknown> => {
        if (cmd === "ExportZip") return Promise.resolve(snapshot.scripts)
        if (cmd !== "GetScriptCode") mutated = true
        return send(cmd, data)
      }
      const result = await handUserscriptsToViolentmonkey(snapshotSend, document, applied, sha256, true)
      const unchanged = Object.keys(applied).length === Object.keys(result.applied).length &&
        Object.entries(result.applied).every(([key, value]) => {
          const before = applied[key]
          return before && before.id === value.id && before.source === value.source &&
            before.code === value.code && before.enabled === value.enabled
        })
      if (!unchanged) await send("OnceWriteRecords", result.applied)
      if (unchanged && !mutated && !result.adopted && typeof snapshot.token === "string") {
        verified = { document: signature, token: snapshot.token }
      }
      return result.adopted
    } finally {
      // A failed hand-off is reported, not retried; pages open regardless.
      await plugin.settled()
    }
  }
  return {
    apply(document) {
      const turn = ++latest
      const next = queue.catch(() => undefined).then(() => turn === latest ? run(document) : undefined)
      queue = next
      return next
    },
    onConnected(listener) {
      void plugin.addListener("connected", listener)
    },
    onDashboardChanged(listener) {
      void plugin.addListener("dashboardChanged", listener)
    }
  }
}
