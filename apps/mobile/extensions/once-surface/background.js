/* global browser, onceFilterRules */
// Applies Once's synced filter lists inside GeckoView. Userscripts are not
// handled here: the app hands them to the bundled Violentmonkey, which runs
// them in its own sandbox, so third-party code never shares this bridge's
// native-messaging access.
let filterRegistration
let blocks = () => false
let allows = () => false
let listening = false
let settingsRevision = 0
let settingsQueue = Promise.resolve()

async function loadLists(document, current) {
  const rules = []
  const exceptions = []
  const selectors = []
  let skipped = 0
  await Promise.all((document?.lists || []).filter(entry => entry.enabled !== false).map(async entry => {
    const response = await fetch(entry.url)
    if (!response.ok) throw new Error(`Filter list returned ${response.status}: ${entry.url}`)
    const parsed = onceFilterRules.parse(await response.text())
    rules.push(...parsed.blocked)
    exceptions.push(...parsed.allowed)
    selectors.push(...parsed.selectors)
    skipped += parsed.skipped
  }))
  if (!current()) return
  const next = selectors.length ? await browser.contentScripts.register({
    matches: ["<all_urls>"], css: [{ code: `${selectors.join(",\n")} { display: none !important; }` }],
    runAt: "document_start", allFrames: true
  }) : undefined
  if (!current()) { await next?.unregister(); return }
  blocks = onceFilterRules.matcher(rules)
  allows = onceFilterRules.matcher(exceptions)
  if (rules.length && !listening) {
    browser.webRequest.onBeforeRequest.addListener(onRequest, { urls: ["<all_urls>"] }, ["blocking"])
    listening = true
  } else if (!rules.length && listening) {
    browser.webRequest.onBeforeRequest.removeListener(onRequest)
    listening = false
  }
  if (filterRegistration) await filterRegistration.unregister()
  filterRegistration = next
  console.info(`Once filter lists: ${rules.length} network rules; ${skipped} unsupported rules skipped`)
}

function onRequest(details) {
  return blocks(details.url) && !allows(details.url) ? { cancel: true } : {}
}

// The host holds its first page until the acknowledgement: lists fetched
// after a page started loading cannot block its requests or hide its
// elements. A failed list is reported and acknowledged, not retried.
function receiveSettings(port, message) {
  if (message?.type !== "extension-settings") return
  const revision = ++settingsRevision
  const current = () => revision === settingsRevision
  settingsQueue = settingsQueue.then(async () => {
    if (!current()) return
    await loadLists(message.value.filterLists, current)
      .catch(error => console.error("Unable to apply Once extension settings", error))
    if (current()) port.postMessage({ type: "extension-settings-applied", revision: message.revision })
  }).catch(error => console.error("Unable to apply Once extension settings", error))
}

// The runtime outlives the Android activity. Reconnect when that activity's
// delegate goes away so the new host can send its current settings again.
function connectHost() {
  const port = browser.runtime.connectNative("once_surface")
  port.onMessage.addListener(message => receiveSettings(port, message))
  port.onDisconnect.addListener(() => setTimeout(connectHost, 1000))
}
connectHost()
