import type { OnceClient } from "@once/app"
import type { InAppBrowserSurface } from "@once/platform-mobile"

/** Applies shared documents after startup and remote or local changes. */
export async function bindMobileExtensionSettings(client: OnceClient, surface: InAppBrowserSurface): Promise<void> {
  let settingsRevision = 0
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
}
