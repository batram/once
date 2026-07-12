export function installPickerBackground(
  browserApi: typeof browser = browser
): () => void {
  const messageListener = (message: { onceCommand?: string }) => {
    if (message?.onceCommand !== "startSourcePicker") return undefined
    return startPickerOnActiveTab(browserApi)
  }
  browserApi.runtime.onMessage.addListener(messageListener)
  return () => {
    browserApi.runtime.onMessage.removeListener(messageListener)
  }
}

// Injects the source picker content script into the active browser tab. The
// picked selector configuration comes back as a "sourcePicked" runtime
// message that the sidepanel handles (see ui-web SourcePickerView).
async function startPickerOnActiveTab(browserApi: typeof browser): Promise<void> {
  const [tab] = await browserApi.tabs.query({
    active: true,
    lastFocusedWindow: true
  })
  if (tab?.id == null) throw new Error("There is no active tab to pick from")
  const url = new URL(tab.url || "")
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Source picking needs an HTTP or HTTPS page")
  }
  await browserApi.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["/picker-content.js"]
  })
}
