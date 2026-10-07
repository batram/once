import type { OnceClient } from "@once/app"
import type { UserscriptsDocument } from "@once/core"
import { createViolentmonkeyHandOff, type InAppBrowserSurface, type ViolentmonkeyHandOff } from "@once/platform-mobile"

/** Applies shared documents after startup and remote or local changes. */
export async function bindMobileExtensionSettings(
  client: OnceClient,
  surface: InAppBrowserSurface,
  violentmonkey: ViolentmonkeyHandOff | null = createViolentmonkeyHandOff()
): Promise<void> {
  let settingsRevision = 0
  const handToViolentmonkey = async (userscripts: UserscriptsDocument, revision: number): Promise<void> => {
    if (!violentmonkey) return
    const adopted = await violentmonkey.apply(userscripts)
    // What the dashboard changed joins the document and syncs; saving it
    // comes back here as a change, which then finds nothing left to write.
    if (adopted && revision === settingsRevision) await client.saveUserscripts(adopted)
  }
  const applyExtensionSettings = async (settings?: {
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
      await handToViolentmonkey(userscripts, revision)
    } catch (error) {
      console.error("Failed to apply mobile extension settings", error)
    }
  }
  // AppRuntime's startup publication precedes this subscription.
  await applyExtensionSettings()
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
}
