export interface ChromeBackgroundApi {
  sidePanel?: {
    setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>
  }
}

export function initChromeBackground(
  chromeApi: ChromeBackgroundApi | undefined,
  reportError: (message: string, error?: unknown) => void = console.error
): void {
  if (!chromeApi?.sidePanel) {
    reportError("Once requires the Chrome Side Panel API")
    return
  }
  chromeApi.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => reportError("Unable to configure the side panel", error))
}
