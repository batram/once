/* global browser, onceFilterRules */
// Applies Once's synced additions inside GeckoView. Third-party built-ins have
// isolated storage/background pages, so the trusted bridge owns this narrow
// hand-off rather than attempting to mutate uBlock or Violentmonkey internals.
const native = browser.runtime.connectNative("once_surface")
let registrations = []
let filterRegistration
let blocked = []
let allowed = []
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
  blocked = rules
  allowed = exceptions
  if (filterRegistration) await filterRegistration.unregister()
  filterRegistration = next
  console.info(`Once filter lists: ${rules.length} network rules; ${skipped} unsupported rules skipped`)
}

browser.webRequest.onBeforeRequest.addListener(
  details => !allowed.some(pattern => pattern.test(details.url)) && blocked.some(pattern => pattern.test(details.url)) ? { cancel: true } : {},
  { urls: ["<all_urls>"] },
  ["blocking"]
)

async function installUserscripts(document, current) {
  const next = []
  try {
    for (const script of document?.scripts || []) {
      if (script.enabled === false) continue
      const matches = script.matches?.length ? script.matches : ["<all_urls>"]
      const prefix = `once.userscript.${script.id}.`
      const code = `(() => {
      const GM_addStyle = css => { const node = document.createElement('style'); node.textContent = String(css); (document.head || document.documentElement).append(node); return node; };
      const GM_getValue = (key, fallback) => { const value = localStorage.getItem(${JSON.stringify(prefix)} + key); if (value === null) return fallback; try { return JSON.parse(value); } catch { return fallback; } };
      const GM_setValue = (key, value) => localStorage.setItem(${JSON.stringify(prefix)} + key, JSON.stringify(value));
      try { ${script.body} } catch (error) { console.error(${JSON.stringify(`Once userscript ${script.id} failed`)}, error); }
    })();`
      const registration = {
        matches,
        js: [{ code }],
        runAt: script.runAt === "document-start" ? "document_start" : "document_end",
        allFrames: !script.noFrames
      }
      if (script.includes?.length) registration.includeGlobs = script.includes
      if (script.excludes?.length) registration.excludeGlobs = script.excludes
      next.push(await browser.contentScripts.register(registration))
    }
    if (!current()) { for (const registration of next) await registration.unregister(); return }
    for (const registration of registrations) await registration.unregister()
    registrations = next
  } catch (error) {
    for (const registration of next) await registration.unregister()
    throw error
  }
}

native.onMessage.addListener(message => {
  if (message?.type !== "extension-settings") return
  const revision = ++settingsRevision
  const current = () => revision === settingsRevision
  settingsQueue = settingsQueue.then(async () => {
    if (!current()) return
    await Promise.allSettled([
      loadLists(message.value.filterLists, current),
      installUserscripts(message.value.userscripts, current)
    ]).then(results => {
      for (const result of results) if (result.status === "rejected") console.error("Unable to apply Once extension settings", result.reason)
    })
  }).catch(error => console.error("Unable to apply Once extension settings", error))
})
