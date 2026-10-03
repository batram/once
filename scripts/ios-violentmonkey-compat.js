// Loaded only in the bundled Violentmonkey background page, before upstream code.
// Keep script execution, matching, storage and export formats in upstream code.
(() => {
  const api = globalThis.browser
  const event = () => {
    const listeners = new Set()
    return {
      addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
      hasListener: fn => listeners.has(fn), hasListeners: () => listeners.size > 0
    }
  }
  if (!api.notifications) api.notifications = {
    onClicked: event(), onClosed: event(),
    create: async () => { throw new Error("Notifications are not supported in Once on iOS") },
    clear: async () => false
  }
  // WebKit throws for unknown permission names instead of returning false.
  for (const method of ["contains", "request", "remove"]) {
    const original = api.permissions[method].bind(api.permissions)
    api.permissions[method] = query => query.permissions?.some(permission =>
      ["downloads", "notifications", "webRequestBlocking"].includes(permission))
      ? Promise.resolve(false) : original(query)
  }
  // Missing EXTRA_HEADERS means unavailable; don't pretend header rewriting works.
  api.webRequest.OnBeforeSendHeadersOptions ||= {}
  api.webRequest.OnHeadersReceivedOptions ||= {}
  const action = api.browserAction
  const setIcon = action.setIcon.bind(action)
  action.setIcon = details => {
    details = { ...details }
    // Upstream supplies both for Firefox Android; WebKit requires exactly one.
    if (details.path != null || details.imageData == null) delete details.imageData
    if (details.path == null) delete details.path
    return setIcon(details)
  }

  const onMessage = api.runtime.onMessage
  const addListener = onMessage.addListener.bind(onMessage)
  onMessage.addListener = listener => {
    if (listener !== globalThis.handleCommandMessage) return addListener(listener)
    const frames = new Map()
    api.tabs.onRemoved.addListener(tabId => {
      for (const key of frames.keys()) if (key.startsWith(`${tabId}:`)) frames.delete(key)
    })
    return addListener((message, sender) => {
      if (!sender.tab) return listener(message, sender)
      const key = `${sender.tab.id}:${sender.frameId}`
      const document = `${sender.documentId || ""}:${sender.url}`
      if (message?.cmd === "GetInjected") {
        const ready = Promise.resolve(listener(message, sender))
        const frame = { document, ready }
        frames.set(key, frame)
        ready.catch(() => { if (frames.get(key) === frame) frames.delete(key) })
        return ready
      }
      if (message?.cmd !== "UpdateValue") return listener(message, sender)
      let frame = frames.get(key)
      if (frame?.document !== document) {
        // MV2 loses its per-frame value stores when iOS unloads the background.
        // Rebuild through upstream matching using the browser-supplied sender URL,
        // never by trusting the script IDs in a write or re-executing script code.
        const ready = (async () => {
          const matches = await listener({
            cmd: "GetMoreIds", data: { url: sender.url, top: sender.frameId === 0, ids: {} }
          })
          const ids = Object.keys(matches || {}).filter(id => matches[id]).map(Number)
          await globalThis.onceRestoreValueOpeners(ids, sender.tab.id,
            message.top === 2 ? sender.documentId : sender.frameId)
        })()
        frames.set(key, frame = { document, ready })
        ready.catch(() => { if (frames.get(key) === frame) frames.delete(key) })
      }
      return frame.ready.then(() => listener(message, sender))
    })
  }
})()
