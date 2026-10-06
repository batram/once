import type { OnceClient } from "@once/app"

/** Saving a URL starts replication; only the transport can confirm pairing. */
export function waitForPairingSync(client: OnceClient, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const lifecycle: { release?: () => void; timer?: ReturnType<typeof setTimeout> } = {}
    let done = false
    const finish = (error?: Error) => {
      if (done) return
      done = true
      clearTimeout(lifecycle.timer)
      lifecycle.release?.()
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      const status = client.getSyncStatus()
      if (status.state === "up-to-date") finish()
      else if (status.state === "error" || status.state === "disabled") {
        finish(new Error(status.message || "Could not connect. Check the pairing link and try again."))
      }
    }
    lifecycle.release = client.subscribe("syncStatusChanged", check)
    lifecycle.timer = setTimeout(() => finish(new Error("Still unable to confirm the connection. Check Sync status and try again.")), timeoutMs)
    check()
    if (done) { clearTimeout(lifecycle.timer); lifecycle.release() }
  })
}
