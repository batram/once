const test = require("node:test")
const assert = require("node:assert/strict")
const {
  ManifestError,
  parseWebExtensionManifest,
  parseWebExtensionManifestJson
} = require("../../../packages/core/dist/webext/manifest")
const {
  getLocaleMessage,
  localeCandidates,
  localizeManifestString
} = require("../../../packages/core/dist/webext/i18n")

// Shaped like uBlock Origin's Firefox manifest, trimmed to what matters.
function ublockLike(overrides = {}) {
  return {
    manifest_version: 2,
    name: "__MSG_extName__",
    version: "1.60.0",
    description: "__MSG_extShortDesc__",
    default_locale: "en",
    browser_specific_settings: { gecko: { id: "uBlock0@raymondhill.net" } },
    background: { page: "background.html" },
    browser_action: {
      default_icon: { 16: "img/icon_16.png" },
      default_popup: "popup-fenix.html",
      default_title: "uBlock Origin"
    },
    content_scripts: [
      {
        matches: ["http://*/*", "https://*/*"],
        js: ["js/vapi.js", "js/contentscript.js"],
        run_at: "document_start",
        all_frames: true
      },
      {
        matches: ["https://easylist.to/*"],
        js: ["js/scriptlets/subscriber.js"]
      }
    ],
    options_ui: { page: "dashboard.html", open_in_tab: true },
    permissions: [
      "contextMenus", "privacy", "storage", "tabs", "unlimitedStorage",
      "webNavigation", "webRequest", "webRequestBlocking", "<all_urls>",
      "http://*/*"
    ],
    web_accessible_resources: ["/web_accessible_resources/*"],
    ...overrides
  }
}

test("a uBlock-shaped manifest parses into typed specs", () => {
  const manifest = parseWebExtensionManifest(ublockLike())
  assert.equal(manifest.id, "uBlock0@raymondhill.net")
  assert.equal(manifest.version, "1.60.0")
  assert.equal(manifest.defaultLocale, "en")
  assert.deepEqual(manifest.background, {
    kind: "page", page: "background.html", persistent: true
  })
  assert.equal(manifest.contentScripts.length, 2)
  assert.equal(manifest.contentScripts[0].runAt, "document_start")
  assert.equal(manifest.contentScripts[0].allFrames, true)
  assert.equal(manifest.contentScripts[1].runAt, "document_idle")
  assert.equal(manifest.contentScripts[1].allFrames, false)
  assert.equal(manifest.permissions.has("webRequestBlocking"), true)
  assert.equal(manifest.permissions.has("<all_urls>"), false)
  assert.deepEqual(manifest.hostPermissions, ["<all_urls>", "http://*/*"])
  assert.equal(manifest.browserAction.defaultPopup, "popup-fenix.html")
  assert.deepEqual(manifest.browserAction.defaultIcon, { 16: "img/icon_16.png" })
  assert.deepEqual(manifest.optionsUi, { page: "dashboard.html", openInTab: true })
  assert.deepEqual(manifest.webAccessibleResources, ["/web_accessible_resources/*"])
})

test("background scripts and a non-persistent event page are understood", () => {
  const manifest = parseWebExtensionManifest(ublockLike({
    background: { scripts: ["a.js", "b.js"], persistent: false }
  }))
  assert.deepEqual(manifest.background, {
    kind: "scripts", scripts: ["a.js", "b.js"], persistent: false
  })
})

test("the legacy applications.gecko.id key still supplies the id", () => {
  const manifest = parseWebExtensionManifest(ublockLike({
    browser_specific_settings: undefined,
    applications: { gecko: { id: "legacy@example.org" } }
  }))
  assert.equal(manifest.id, "legacy@example.org")
})

test("what the runtime relies on is validated", () => {
  const cases = [
    [{ manifest_version: 3 }, /manifest_version 2/],
    [ublockLike({ browser_specific_settings: {} }), /gecko\.id/],
    [ublockLike({ name: "" }), /"name"/],
    [ublockLike({ background: {} }), /"scripts" or "page"/],
    [ublockLike({ content_scripts: [{ matches: [], js: ["x.js"] }] }), /must not be empty/],
    [ublockLike({ content_scripts: [{ matches: ["nope"], js: ["x.js"] }] }), /invalid match pattern/],
    [ublockLike({ content_scripts: [{ matches: ["<all_urls>"] }] }), /"js" or "css"/],
    [ublockLike({ content_scripts: [{ matches: ["<all_urls>"], js: ["x"], run_at: "now" }] }), /run_at/],
    [ublockLike({ permissions: [1] }), /list of strings/]
  ]
  for (const [input, expected] of cases) {
    assert.throws(() => parseWebExtensionManifest(input), ManifestError)
    assert.throws(() => parseWebExtensionManifest(input), expected)
  }
})

test("manifest text that is not JSON reports as a manifest error", () => {
  assert.throws(() => parseWebExtensionManifestJson("{"), ManifestError)
  assert.equal(parseWebExtensionManifestJson(JSON.stringify(ublockLike())).name, "__MSG_extName__")
})

test("__MSG_ references resolve through messages.json with placeholders", () => {
  const messages = {
    extName: { message: "uBlock Origin" },
    greeting: {
      message: "Hello, $USER$! You have $1 items ($$).",
      placeholders: { user: { content: "$2" } }
    }
  }
  assert.equal(localizeManifestString("__MSG_extName__ (__MSG_missing__)", messages), "uBlock Origin ()")
  assert.equal(
    getLocaleMessage(messages, "greeting", ["3", "Ada"]),
    "Hello, Ada! You have 3 items ($)."
  )
  assert.equal(getLocaleMessage(messages, "nope"), "")
})

test("locale lookup narrows from region to language to the default", () => {
  assert.deepEqual(localeCandidates("en-US", "en"), ["en_US", "en"])
  assert.deepEqual(localeCandidates("de", "en"), ["de", "en"])
  assert.deepEqual(localeCandidates("pt_BR", null), ["pt_BR", "pt"])
})
