import { Capacitor, PluginListenerHandle, registerPlugin } from "@capacitor/core"
import {
  AppliedUserscript,
  handUserscriptsToViolentmonkey,
  UserscriptsDocument
} from "@once/core"

interface NativeViolentmonkeyPlugin {
  send(options: { cmd: string; data?: unknown }): Promise<{ value?: unknown }>
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
  const run = async (document: UserscriptsDocument): Promise<UserscriptsDocument | undefined> => {
    // The records live in Violentmonkey's own storage, so they are lost with
    // its scripts or not at all: a missing script is always a deletion.
    let records: unknown
    try {
      records = await send("OnceReadRecords")
    } catch (error) {
      if ((error as { code?: string }).code === "NOT_RUNNING") return undefined
      throw error
    }
    try {
      const applied = readRecords(records)
      const result = await handUserscriptsToViolentmonkey(send, document, applied, sha256, true)
      await send("OnceWriteRecords", result.applied)
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
