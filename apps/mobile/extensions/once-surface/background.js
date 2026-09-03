/* global browser */
// Applies Once's synced additions inside GeckoView. Third-party built-ins have
// isolated storage/background pages, so the trusted bridge owns this narrow
// hand-off rather than attempting to mutate uBlock or Violentmonkey internals.
const native = browser.runtime.connectNative("once_surface")
let registrations = []
let filterRegistration
let blocked = []

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function networkPattern(source) {
  let value = source
  let prefix = ""
  if (value.startsWith("||")) {
    value = value.slice(2)
    prefix = "^[^:]+:(?://)?(?:[^/]+\\.)?"
  } else if (value.startsWith("|")) {
    value = value.slice(1)
    prefix = "^"
  }
  const anchored = value.endsWith("|")
  if (anchored) value = value.slice(0, -1)
  return new RegExp(prefix + escapeRegex(value)
    .replace(/\\\*/g, ".*")
    .replace(/\\\^/g, "(?:[^A-Za-z0-9_.%-]|$)") + (anchored ? "$" : ""))
}

async function loadLists(document) {
  const rules = []
  const selectors = []
  await Promise.all((document?.lists || []).filter(entry => entry.enabled !== false).map(async entry => {
    const response = await fetch(entry.url)
    if (!response.ok) throw new Error(`Filter list returned ${response.status}: ${entry.url}`)
    for (const raw of (await response.text()).split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith("!") || line.startsWith("[") || line.startsWith("@@")) continue
      if (line.startsWith("##") && !line.includes("+js(") && !line.includes(":has-text(")) {
        selectors.push(line.slice(2))
        continue
      }
      if (line.includes("##") || (line.length > 1 && line.startsWith("/") && line.endsWith("/"))) continue
      const [pattern] = line.split("$", 1)
      try { rules.push(networkPattern(pattern)) } catch { /* unsupported expression */ }
    }
  }))
  blocked = rules
  if (filterRegistration) await filterRegistration.unregister()
  filterRegistration = selectors.length ? await browser.contentScripts.register({
    matches: ["<all_urls>"],
    css: [{ code: `${selectors.join(",\n")} { display: none !important; }` }],
    runAt: "document_start",
    allFrames: true
  }) : undefined
}

browser.webRequest.onBeforeRequest.addListener(
  details => blocked.some(pattern => pattern.test(details.url)) ? { cancel: true } : {},
  { urls: ["<all_urls>"] },
  ["blocking"]
)

async function installUserscripts(document) {
  for (const registration of registrations) await registration.unregister()
  registrations = []
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
    registrations.push(await browser.contentScripts.register(registration))
  }
}

native.onMessage.addListener(message => {
  if (message?.type !== "extension-settings") return
  void Promise.all([
    loadLists(message.value.filterLists),
    installUserscripts(message.value.userscripts)
  ]).catch(error => console.error("Unable to apply Once extension settings", error))
})
