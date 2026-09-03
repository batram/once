/* global browser */
// GeckoView has no evaluateJavascript, so the app's browsing surface runs
// scripts through this content script instead: the native side posts
// `{ id, code }` over a native-messaging port and gets `{ id, value }` back,
// with `value` JSON-encoded the way Android's WebView answers. The code runs
// in this content script's own world, which sees the page's DOM but not its
// scripts, which is exactly what the source picker needs.
if (window === window.top) {
  // The native application name may hold only word characters and dots.
  const port = browser.runtime.connectNative("once_surface")
  port.onMessage.addListener((message) => {
    if (!message || typeof message.id !== "number" || typeof message.code !== "string") return
    let value
    try {
      value = (0, eval)(message.code)
    } catch (error) {
      port.postMessage({ id: message.id, error: String(error) })
      return
    }
    let text = "null"
    try {
      const encoded = JSON.stringify(value === undefined ? null : value)
      if (typeof encoded === "string") text = encoded
    } catch {
      // Not serializable; the caller gets null, as it would from a WebView.
    }
    port.postMessage({ id: message.id, value: text })
  })
}
