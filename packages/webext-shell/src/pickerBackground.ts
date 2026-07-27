export function installPickerBackground(
  browserApi: typeof browser = browser
): () => void {
  const messageListener = (message: { onceCommand?: string; url?: string }) => {
    if (message?.onceCommand !== "startSourcePicker") return undefined
    return startPickerOnActiveTab(browserApi, message.url)
  }
  browserApi.runtime.onMessage.addListener(messageListener)
  return () => {
    browserApi.runtime.onMessage.removeListener(messageListener)
  }
}

// Injects the source picker content script into the active browser tab. The
// picked selector configuration comes back as a "sourcePicked" runtime
// message that the sidepanel handles (see ui-web SourcePickerView).
async function startPickerOnActiveTab(
  browserApi: typeof browser,
  requestedUrl?: string
): Promise<{ needsUrl?: boolean }> {
  let [tab] = await browserApi.tabs.query({
    active: true,
    lastFocusedWindow: true
  })
  let url: URL
  try {
    url = new URL(tab?.url || "")
  } catch {
    url = new URL("about:blank")
  }
  if (requestedUrl) {
    url = new URL(requestedUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Source picking needs an HTTP or HTTPS URL")
    }
    if (tab?.id == null) {
      tab = await browserApi.tabs.create({ url: url.href, active: true })
    } else {
      tab = await browserApi.tabs.update(tab.id, { url: url.href, active: true })
    }
    if (tab.id == null) throw new Error("The page could not be opened")
    if (tab.status !== "complete") await waitForTab(browserApi, tab.id)
  } else if (tab?.id == null ||
      (url.protocol !== "http:" && url.protocol !== "https:")) {
    return { needsUrl: true }
  }
  await browserApi.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["/picker-content.js"]
  })
  return {}
}

function waitForTab(browserApi: typeof browser, tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browserApi.tabs.onUpdated.removeListener(listener)
      reject(new Error("The page took too long to load"))
    }, 30_000)
    const listener = (
      id: number,
      change: { status?: string }
    ) => {
      if (id !== tabId || change.status !== "complete") return
      clearTimeout(timeout)
      browserApi.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    browserApi.tabs.onUpdated.addListener(listener)
  })
}
