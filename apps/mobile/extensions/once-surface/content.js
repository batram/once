/* global browser, installOnceMediaBridge, installOncePictureInPicture */
// GeckoView has no evaluateJavascript, so the app's browsing surface runs
// scripts through this content script instead: the native side posts
// `{ id, code }` over a native-messaging port and gets `{ id, value }` back,
// with `value` JSON-encoded the way Android's WebView answers. The code runs
// in this content script's own world, which sees the page's DOM but not its
// scripts, which is exactly what the source picker needs.
if (window === window.top) {
  const documentContext = browser.runtime.sendMessage({ type: "once-document-context" }).catch(() => null)
  let port = null
  let cleanupMedia = null
  let cleanupPip = null
  let suspended = false
  let restored = false
  let retry = null
  let attempts = 0
  // Image text selection (evaluated here, see imageTextInjection.ts) reports
  // to the app through this: what its native bar shows, and where the image
  // is. It posts on whichever port is current, so a reconnect keeps it working.
  globalThis.__onceImageTextPush = payload => {
    port?.postMessage({ type: "image-text", payload: String(payload) })
  }
  const disconnect = () => {
    if (retry !== null) clearTimeout(retry)
    retry = null
    cleanupMedia?.()
    cleanupMedia = null
    cleanupPip?.()
    cleanupPip = null
    const previous = port
    port = null
    previous?.disconnect()
  }
  const connect = () => {
    if (suspended || port) return
    const connected = browser.runtime.connectNative("once_surface")
    port = connected
    cleanupMedia = installOnceMediaBridge(connected)
    cleanupPip = installOncePictureInPicture(connected)
    connected.onDisconnect.addListener(() => {
      if (port !== connected) return
      cleanupMedia?.()
      cleanupMedia = null
      cleanupPip?.()
      cleanupPip = null
      port = null
      if (!suspended && attempts++ < 5) retry = setTimeout(() => { retry = null; connect() }, 500)
    })
    connected.onMessage.addListener((message) => {
      if (port !== connected) return
      attempts = 0
      if (message?.type === "health") {
        void documentContext.then(context => {
          if (port === connected) connected.postMessage({ type: "health", id: message.id, url: location.href, readyState: document.readyState, restored, context })
        })
        return
      }
      if (!message || typeof message.id !== "number" || typeof message.code !== "string") return
      let value
      try {
        value = (0, eval)(message.code)
      } catch (error) {
        connected.postMessage({ id: message.id, error: String(error) })
        return
      }
      let text = "null"
      try {
        const encoded = JSON.stringify(value === undefined ? null : value)
        if (typeof encoded === "string") text = encoded
      } catch {
      // Not serializable; the caller gets null, as it would from a WebView.
      }
      connected.postMessage({ id: message.id, value: text })
    })
  }
  window.addEventListener("pagehide", () => {
    // A selection never outlives its page's bar: a page restored from the
    // back-forward cache must not come back with one the app has dropped.
    window.__onceImageText?.close()
    suspended = true
    disconnect()
  })
  window.addEventListener("pageshow", event => {
    suspended = false
    restored = event.persisted === true
    attempts = 0
    connect()
  })
  connect()
}
