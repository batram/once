import { installReaderBackground } from "@once/webext-shell/dist/readerBackground"

installReaderBackground()

interface ChromeSidePanelApi {
  setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>
}

interface ChromeExtensionApi {
  sidePanel?: ChromeSidePanelApi
}

const chromeApi = (globalThis as typeof globalThis & { chrome?: ChromeExtensionApi }).chrome

if (!chromeApi?.sidePanel) {
  console.error("Once requires the Chrome Side Panel API")
} else {
  chromeApi.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => console.error("Unable to configure the side panel", error))
}
