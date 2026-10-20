// Once Lite's Tier 2 (no DevTools) in the broker, against a fake Java: the
// catalogue, the rule groups Java's evaluator takes (`net.rules`) from uBO
// Lite's rulesets, the session rules and the synced lists, the page
// sources (`tier2.scripts`) and what they do in a document, and the
// portable list subset agreeing with the GeckoView bridge's parser.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const vm = require("node:vm")
const esbuild = require("esbuild")
const { lite, fakeFiles, FakeJava, root } = require("./lite-support")

const { LiteBroker } = lite("broker")
const { parseFilterList, filterListRules } = lite("liteFilterLists")
const { UBOLITE_ID, TIER2_DISABLED_REASON } = lite("protocol")

const UBLOCK_ID = "uBlock0@raymondhill.net"
const VIOLENTMONKEY_ID = "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}"
const TOKEN = "0123456789abcdef0123456789abcdef"
const UBOLITE_DIR = path.join(root, "vendor/extensions/ublock-origin-lite")
const LIST_URL = "http://10.0.2.2:8080/fixtures/mobile-filter-list.txt"
const LIST_TEXT = ["*/fixtures/blocked-ad.png|", "##.once-filter-hide", "||ads.example^$image", "@@||ads.example/ok^"].join("\n")
const USERSCRIPT = `// ==UserScript==
// @name Mobile e2e probe
// @namespace once-e2e
// @match <all_urls>
// @run-at document-start
// @grant GM_addStyle
// @grant GM_getValue
// @grant GM_setValue
// ==/UserScript==
document.documentElement.dataset.onceUserscriptStart = document.readyState;
GM_addStyle('#once-userscript-target { display: none !important; }');
GM_setValue('ran', true);
document.documentElement.dataset.onceGmValue = String(GM_getValue('ran', false)); // a trailing comment`

/** The real `lite-tier2-page.js`, bundled the way webpack does it (an IIFE reading `ONCE_TIER2`). */
const pageBundle = esbuild.buildSync({
  entryPoints: [path.join(root, "apps/mobile/src/lite/tier2Page.ts")],
  bundle: true, format: "iife", platform: "browser", write: false, target: "es2022"
}).outputFiles[0].text

function manifestFor(id, name) {
  return JSON.stringify({ manifest_version: 2, name, version: "1.0", browser_specific_settings: { gecko: { id } },
    background: { scripts: ["background.js"] }, permissions: ["storage", "<all_urls>"] })
}

async function startTier2({ ubolite = true } = {}) {
  const files = fakeFiles({
    "/bundles/ublock": { "manifest.json": manifestFor(UBLOCK_ID, "uBlock Origin"), "background.js": "" },
    "/bundles/violentmonkey": { "manifest.json": manifestFor(VIOLENTMONKEY_ID, "Violentmonkey"), "background.js": "" }
  })
  const read = files.read
  files.read = (directory, relativePath) => directory === "@bundle" && relativePath === "lite-tier2-page.js"
    ? JSON.stringify({ text: pageBundle }) : read(directory, relativePath)
  const java = new FakeJava(files)
  java.netRules = []
  java.scripts = []
  java.handlers["net.rules"] = ({ groups }) => {
    java.netRules.push(groups)
    return { counts: Object.fromEntries(groups.map((group) => [group.id, group.rules.length + (group.rulesets?.length ?? 0)])) }
  }
  java.handlers["tier2.scripts"] = ({ sources }) => { java.scripts.push(sources) }
  java.handlers["tier2.fetchList"] = ({ url }) => url === LIST_URL ? { status: 200, text: LIST_TEXT } : { status: 404 }
  const broker = new LiteBroker(java.port, files)
  const started = await java.request("lite.start", {
    bundled: [
      { id: UBLOCK_ID, directory: "/bundles/ublock", present: true },
      { id: VIOLENTMONKEY_ID, directory: "/bundles/violentmonkey", present: true }
    ],
    locale: "en-US", arch: "arm64", token: TOKEN, storageRoot: "/storage", devtools: false,
    ubolite: { id: UBOLITE_ID, directory: UBOLITE_DIR, present: ubolite }
  })
  return { java, broker, started }
}

/** Runs page sources in a minimal document, as `addDocumentStartJavaScript` would at document start. */
function runInDocument(sources, href = "http://10.0.2.2:8080/fixtures/article.html", prelude = "") {
  const styles = []
  const listeners = {}
  const store = new Map()
  const documentElement = { dataset: {}, append: (node) => styles.push(node) }
  const document = {
    readyState: "loading",
    documentElement,
    head: null,
    createElement: () => ({ textContent: "" }),
    addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener) },
    querySelectorAll: () => []
  }
  const localStorage = {
    get length() { return store.size },
    key: (index) => [...store.keys()][index] ?? null,
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  }
  const url = new URL(href)
  const context = { document, localStorage, location: { href, origin: url.origin, hostname: url.hostname }, console, URL, setTimeout, clearTimeout, AbortController }
  context.window = context
  context.top = context
  context.self = context
  context.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  vm.createContext(context)
  if (prelude) vm.runInContext(prelude, context)
  for (const source of sources) vm.runInContext(source, context)
  return { document, styles, store, listeners, window: context }
}

test("the portable subset matches the GeckoView bridge parser", () => {
  const context = { globalThis: {} }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(root, "apps/mobile/extensions/once-surface/filterRules.js"), "utf8"), context)
  const samples = [
    LIST_TEXT,
    "! comment\n[Adblock Plus]\n||tracker.example^\n/regex/\n##.ad\n##div:has(.x)\nexample.com##.scoped",
    "||a.example^\n@@||b.example^$document",
    "||a.example^\n##.hide\nexample.com#@#.hide",
    // Selectors that would leave their rule or swallow the next ones are refused by both.
    "##.x{\n##@import url(//evil.example/x.css);x\n##.a /* \n##[href=\"x\n##div[a=\"]\"]\n##.ok\n##.b)\n##\\66 oo"
  ]
  for (const text of samples) {
    const gecko = context.onceFilterRules.parse(text)
    const ported = parseFilterList(text)
    assert.equal(ported.blocked.length, gecko.blocked.length, text)
    assert.equal(ported.allowed.length, gecko.allowed.length, text)
    assert.deepEqual(ported.selectors, [...gecko.selectors], text)
    assert.equal(ported.skipped, gecko.skipped, text)
  }
  assert.deepEqual(parseFilterList(samples.at(-1)).selectors, ['div[a="]"]', ".ok"])
})

test("filter lists become DNR block and allow rules plus generic selectors", () => {
  const converted = filterListRules([parseFilterList(LIST_TEXT)])
  assert.deepEqual(converted.rules.map((rule) => [rule.action.type, rule.condition.urlFilter, rule.priority]), [
    ["block", "*/fixtures/blocked-ad.png|", 1],
    ["allow", "||ads.example/ok^", 1]
  ])
  assert.deepEqual(converted.selectors, [".once-filter-hide"])
  assert.equal(converted.skipped, 1)
})

test("Tier 2 lists uBO Lite as the running extension and the full ones as limited", async () => {
  const { java, started } = await startTier2()
  assert.equal(started.ready, true)
  assert.deepEqual(started.extensions.map((entry) => [entry.id, entry.enabled, entry.disabledReason]), [
    [UBOLITE_ID, true, ""],
    [UBLOCK_ID, false, TIER2_DISABLED_REASON],
    [VIOLENTMONKEY_ID, false, TIER2_DISABLED_REASON]
  ])
  const [ubolite] = started.extensions
  assert.equal(ubolite.name, "uBlock Origin Lite")
  assert.match(ubolite.description, /content blocker/)
  assert.equal(ubolite.hasOptions, false)
  assert.equal(ubolite.hasAction, false)
  assert.match(ubolite.iconDataUrl, /^data:image\/png;base64,/)
  // No extension loads: no world registrations, no background pages.
  assert.equal(java.registrations, undefined)
  assert.equal(java.pages.size, 0)
  // uBO Lite's default rulesets reach Java by path before the first settings.
  const [groups] = java.netRules
  const group = groups.find((entry) => entry.id === "ubolite")
  assert.equal(group.directory, UBOLITE_DIR)
  assert.deepEqual(group.rulesets, [
    "rulesets/main/ublock-filters.json", "rulesets/regex/ublock-filters.json",
    "rulesets/main/easylist.json", "rulesets/regex/easylist.json",
    "rulesets/main/easyprivacy.json", "rulesets/regex/easyprivacy.json"
  ])
  for (const file of group.rulesets.filter((entry) => entry.startsWith("rulesets/main/"))) assert.ok(fs.existsSync(path.join(UBOLITE_DIR, file)), file)
  // Its generic cosmetics are one page source, scoped off the page's window.
  const [sources] = java.scripts
  assert.equal(sources.length, 1)
  assert.match(sources[0], /uBOL_cssGeneric/)
  assert.match(sources[0], /^\(function \(\) \{\nconst self = \{/)
  assert.doesNotThrow(() => new vm.Script(sources[0]))

  const list = await java.request("extension.command", { action: "list" })
  assert.equal(list.extensions.length, 3)
  await assert.rejects(java.request("extension.command", { action: "enable", id: UBLOCK_ID, enabled: true }), (error) =>
    error.code === "LIMITED" && error.message === TIER2_DISABLED_REASON)
  assert.deepEqual(await java.request("extension.command", { action: "options", id: UBOLITE_ID }), { noPage: true })
})

test("settings.apply compiles the synced lists and userscripts and answers once Java has them", async () => {
  const { java } = await startTier2({ ubolite: false })
  const before = java.scripts.length
  const order = []
  java.handlers["tier2.scripts"] = ({ sources }) => { order.push("scripts"); java.scripts.push(sources) }
  const applied = java.request("settings.apply", {
    filterLists: { version: 1, lists: [{ url: LIST_URL, enabled: true }, { url: "http://10.0.2.2:8080/missing.txt", enabled: true }, { url: "http://off.example/x.txt", enabled: false }] },
    userscripts: { version: 1, scripts: [
      { id: "probe", name: "Mobile e2e probe", source: USERSCRIPT, enabled: true },
      { id: "off", name: "Off", source: USERSCRIPT, enabled: false },
      { id: "broken", name: "Broken", source: "not a userscript", enabled: true }
    ] }
  }).then(() => order.push("applied"))
  await applied
  assert.deepEqual(order, ["scripts", "applied"])
  const groups = java.netRules.at(-1)
  assert.deepEqual(groups.map((group) => group.id), ["once-lists"])
  assert.deepEqual(groups[0].rules.map((rule) => [rule.action.type, rule.condition.urlFilter]), [
    ["block", "*/fixtures/blocked-ad.png|"], ["allow", "||ads.example/ok^"]
  ])
  const sources = java.scripts.at(-1)
  assert.equal(java.scripts.length, before + 1)
  // The cosmetic sheet, the runtime, the one enabled userscript with a header, and the runtime's removal.
  assert.equal(sources.length, 4)
  assert.match(sources[1], /const ONCE_TIER2 = \{"kind":"runtime","key":"__onceTier2[0-9a-f]{32}"\}/)
  assert.match(sources[3], /^\(function \(\) \{ delete window\["__onceTier2/)
  assert.ok(java.events.some((event) => event.event === "log" && /missing\.txt was not applied/.test(event.params.message)))

  const page = runInDocument(sources)
  assert.equal(page.document.documentElement.dataset.onceUserscriptStart, "loading")
  assert.equal(page.document.documentElement.dataset.onceGmValue, "true")
  assert.equal(page.store.get("once.userscript.probe.ran"), "true")
  assert.match(page.styles[0].textContent, /^\.once-filter-hide \{ display: none !important; \}$/)
  assert.match(page.styles[1].textContent, /#once-userscript-target/)
  // Nothing of the runtime is left on the page's window.
  assert.deepEqual(Object.getOwnPropertyNames(page.window).filter((name) => name.startsWith("__onceTier2") || name.startsWith("GM")), [])
})

test("a userscript runs at its run-at point and only where it matches", async () => {
  const { java } = await startTier2({ ubolite: false })
  const late = USERSCRIPT.replace("@run-at document-start", "@run-at document-end").replace("@match <all_urls>", "@match https://only.example/*")
  await java.request("settings.apply", {
    filterLists: { version: 1, lists: [] },
    userscripts: { version: 1, scripts: [{ id: "late", name: "Late", source: late, enabled: true }] }
  })
  const sources = java.scripts.at(-1)
  assert.equal(sources.length, 3)
  const elsewhere = runInDocument(sources)
  assert.deepEqual(elsewhere.listeners, {})
  assert.equal(elsewhere.document.documentElement.dataset.onceUserscriptStart, undefined)
  const matching = runInDocument(sources, "https://only.example/page")
  assert.equal(matching.document.documentElement.dataset.onceUserscriptStart, undefined)
  matching.document.readyState = "interactive"
  for (const listener of matching.listeners.DOMContentLoaded) listener()
  assert.equal(matching.document.documentElement.dataset.onceUserscriptStart, "interactive")
})

test("userscripts in the shell's parsed form run like whole sources", async () => {
  const { java } = await startTier2({ ubolite: false })
  // What @once/platform-mobile's nativeExtensionSettings sends: the body and the matching keys.
  await java.request("settings.apply", {
    filterLists: { version: 1, lists: [] },
    userscripts: { version: 1, scripts: [{
      id: "probe", name: "Mobile e2e probe", enabled: true, body: USERSCRIPT.split("// ==/UserScript==\n")[1],
      matches: ["<all_urls>"], includes: [], excludes: [], runAt: "document-start", noFrames: false
    }] }
  })
  const page = runInDocument(java.scripts.at(-1))
  assert.equal(page.document.documentElement.dataset.onceUserscriptStart, "loading")
  assert.equal(page.document.documentElement.dataset.onceGmValue, "true")
})

test("session rules set through the broker join uBO Lite's group", async () => {
  const { java } = await startTier2()
  const result = await java.request("net.sessionRules", {
    addRules: [{ id: 7, priority: 2, action: { type: "block" }, condition: { urlFilter: "/fixtures/tier2-static.png", resourceTypes: ["image"] } }]
  })
  assert.equal(result.counts.ubolite, 7)
  const group = java.netRules.at(-1).find((entry) => entry.id === "ubolite")
  assert.deepEqual(group.rules.map((rule) => rule.id), [7])
  await assert.rejects(java.request("net.sessionRules", { addRules: [{ id: 7, action: { type: "block" }, condition: {} }] }), /already in use/)
  await assert.rejects(java.request("net.sessionRules", { addRules: [{ id: 8, action: { type: "explode" }, condition: {} }] }))
  await java.request("net.sessionRules", { removeRuleIds: [7] })
  assert.deepEqual(java.netRules.at(-1).find((entry) => entry.id === "ubolite").rules, [])
})

test("session rules are refused outside Tier 2", async () => {
  const files = fakeFiles({})
  const java = new FakeJava(files)
  new LiteBroker(java.port, files)
  await java.request("lite.start", { bundled: [], locale: "en-US", arch: "arm64", token: TOKEN, storageRoot: "/storage", devtools: true })
  await assert.rejects(java.request("net.sessionRules", { addRules: [] }), /Tier 2 only/)
})

test("Lite fetches the uBO Lite bundle iOS pins, and ships its Tier 2 files", () => {
  const android = fs.readFileSync(path.join(root, "scripts/fetch-extensions.js"), "utf8")
  const ios = fs.readFileSync(path.join(root, "scripts/fetch-ios-extensions.js"), "utf8")
  const iosVersion = /const version = "([^"]+)"/.exec(ios)[1]
  const iosHash = /const sha256 = "([0-9a-f]{64})"/.exec(ios)[1]
  const pin = /const UBOLITE = \{[^}]*version: "([^"]+)"[^}]*sha256: "([0-9a-f]{64})"/s.exec(android)
  assert.deepEqual([pin[1], pin[2]], [iosVersion, iosHash])
  // Every fetch brings it, so the Lite unit tests find it; Electron's package leaves it out.
  assert.match(android, /^ {2}await fetchBundle\(UBOLITE\)$/m)
  const forge = fs.readFileSync(path.join(root, "apps/electron/forge.config.js"), "utf8")
  assert.match(forge, /afterCopyExtraResources[\s\S]*"ublock-origin-lite"/)
  // The asset task carries the default rulesets the manifest enables, and what the cosmetics need.
  const gradle = fs.readFileSync(path.join(root, "apps/mobile/android/app/build.gradle"), "utf8")
  const manifest = JSON.parse(fs.readFileSync(path.join(UBOLITE_DIR, "manifest.json"), "utf8"))
  const enabled = manifest.declarative_net_request.rule_resources.filter((resource) => resource.enabled).map((resource) => resource.id)
  assert.match(gradle, new RegExp(`for \\(String ruleset : \\[${enabled.map((id) => `'${id}'`).join(", ")}\\]\\)`))
  for (const file of ["js/scripting/isolated-api.js", "js/scripting/css-generic.js"]) {
    assert.ok(gradle.includes(`ublock-origin-lite/${file}`), file)
    assert.ok(fs.existsSync(path.join(UBOLITE_DIR, file)), file)
  }
})

test("a userscript's GM API stays out of the page's reach: no caller arguments, pristine storage and JSON", async () => {
  const { java } = await startTier2({ ubolite: false })
  const body = [
    "GM_setValue('secret', 41);",
    "document.documentElement.dataset.callerArgs = String(window.spy());",
    "GM_xmlhttpRequest({ url: '/data.json', responseType: 'json', onload: () => { document.documentElement.dataset.loaded = '1' },",
    "  onerror: () => { document.documentElement.dataset.failed = '1' } });"
  ].join("\n")
  await java.request("settings.apply", {
    filterLists: { version: 1, lists: [] },
    userscripts: { version: 1, scripts: [{ id: "guarded", name: "Guarded", enabled: true, body, matches: ["<all_urls>"], includes: [], excludes: [], runAt: "document-start", noFrames: false }] }
  })
  // The page: a function that looks at who called it, and a JSON.stringify patched later (after the runtime started).
  const prelude = [
    "window.spy = function spy() { const caller = spy.caller; return caller ? caller.arguments.length : -1 };",
    "window.fetch = () => Promise.resolve({ clone: () => ({ text: () => Promise.resolve('not json') }), headers: new Map(), status: 200 });"
  ].join("\n")
  const sources = java.scripts.at(-1)
  const page = runInDocument([sources[0], "JSON.stringify = () => { window.leaked = true; return '\"forged\"' }", ...sources.slice(1)], undefined, prelude)
  assert.equal(page.document.documentElement.dataset.callerArgs, "0", "the GM API is no argument a page function can read")
  assert.equal(page.window.leaked, undefined, "the page's later JSON.stringify never sees a value")
  assert.equal(page.store.get("once.userscript.guarded.secret"), "41")
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(page.document.documentElement.dataset.failed, "1", "a body that is not JSON fails the request through onerror")
  assert.equal(page.document.documentElement.dataset.loaded, undefined)
})

test("an older settings application finishing after a newer one does not replace its state", async () => {
  const { java } = await startTier2({ ubolite: false })
  let releaseSlow
  const slow = new Promise((resolve) => { releaseSlow = resolve })
  java.handlers["tier2.fetchList"] = async ({ url }) => {
    if (url.endsWith("slow.txt")) { await slow; return { status: 200, text: "||slow.example^" } }
    return { status: 200, text: "||fast.example^" }
  }
  const older = java.request("settings.apply", { filterLists: { version: 1, lists: [{ url: "http://10.0.2.2:8080/slow.txt", enabled: true }] }, userscripts: { version: 1, scripts: [] } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await java.request("settings.apply", { filterLists: { version: 1, lists: [{ url: "http://10.0.2.2:8080/fast.txt", enabled: true }] }, userscripts: { version: 1, scripts: [] } })
  releaseSlow()
  await older
  const lists = java.netRules.at(-1).find((group) => group.id === "once-lists")
  assert.deepEqual(lists.rules.map((rule) => rule.condition.urlFilter), ["||fast.example^"])
})
