import type { OnceClient } from "@once/app"
import type { UserscriptsDocument } from "@once/core"
import { createViolentmonkeyHandOff, type InAppBrowserSurface, type ViolentmonkeyHandOff } from "@once/platform-mobile"

/**
 * Applies shared documents after startup and remote or local changes.
 * Resolves with a function that applies the current documents and settles
 * once both the native surface and Violentmonkey have them.
 */
export async function bindMobileExtensionSettings(
  client: OnceClient,
  surface: InAppBrowserSurface,
  violentmonkey: ViolentmonkeyHandOff | null = createViolentmonkeyHandOff()
): Promise<() => Promise<void>> {
  let settingsRevision = 0
  let pending: Promise<void> = Promise.resolve()
  const handToViolentmonkey = async (userscripts: UserscriptsDocument, revision: number): Promise<void> => {
    if (!violentmonkey) return
    const adopted = await violentmonkey.apply(userscripts)
    // What the dashboard changed joins the document and syncs; saving it
    // comes back here as a change, which then finds nothing left to write.
    if (adopted && revision === settingsRevision) await client.saveUserscripts(adopted)
  }
  const apply = async (settings?: {
    filterLists: Awaited<ReturnType<typeof client.getFilterLists>>
    userscripts: Awaited<ReturnType<typeof client.getUserscripts>>
  }): Promise<void> => {
    const revision = ++settingsRevision
    try {
      const [filterLists, userscripts] = await Promise.all([
        settings?.filterLists ?? client.getFilterLists(),
        settings?.userscripts ?? client.getUserscripts()
      ])
      if (revision !== settingsRevision) return
      await surface.applyExtensionSettings(filterLists, userscripts)
      if (revision === settingsRevision) await handToViolentmonkey(userscripts, revision)
    } catch (error) {
      console.error("Failed to apply mobile extension settings", error)
    }
  }
  const applyExtensionSettings = (settings?: Parameters<typeof apply>[0]): Promise<void> =>
    (pending = apply(settings))
  // Subscribe before the first hand-off: changes and extension restarts
  // during startup must not be lost while it is awaiting native replies.
  client.subscribe("extensionSettingsChanged", (settings) => {
    void applyExtensionSettings(settings)
  })
  client.subscribe("settingsChanged", ({ section }) => {
    if (section === "extensions") void applyExtensionSettings()
  })
  // Violentmonkey starts with the browsing engine, after the shell, and
  // restarts when it is turned back on; each start gets the current scripts.
  violentmonkey?.onConnected(() => { void applyExtensionSettings() })
  // Only Violentmonkey has anything new; the filter lists stay as they are.
  violentmonkey?.onDashboardChanged(() => {
    const revision = settingsRevision
    void client.getUserscripts()
      .then(userscripts => handToViolentmonkey(userscripts, revision))
      .catch(error => console.error("Failed to adopt Violentmonkey changes", error))
  })
  // AppRuntime's startup publication precedes these subscriptions.
  applyExtensionSettings()
  // A connected event or a settings edit may supersede the first hand-off.
  // The startup navigation gate must wait for that replacement as well.
  for (;;) {
    const latest = pending
    await latest
    if (latest === pending) break
  }
  return () => applyExtensionSettings()
}
