const test = require("node:test")
const assert = require("node:assert/strict")
const {
  moveRedirectedUrl,
  parseAddonsText,
  presentAddons,
  readAddonManifest,
  readAddonRedirects,
  readAddonsDocument,
  redirectReplacementPrefix,
  upsertAddon
} = require("../../../packages/core/dist")

const SCRIPT = { url: "https://addon.test/main.js", integrity: `sha256-${"A".repeat(43)}=` }
const manifest = (redirects, extra = {}) => ({ protocol: 1, id: "mirror", name: "Mirror", version: "1.0.0", contributions: [], redirects, ...extra })

test("redirects are read with their defaults", () => {
  assert.deepEqual(readAddonRedirects([{ id: "to-mirror", title: "To mirror", match: "^https://a\\.test/(.*)$", replace: "https://b.test/$1" }]), [{
    id: "to-mirror", title: "To mirror", match: "^https://a\\.test/(.*)$", replace: "https://b.test/$1",
    dynamic: false, enabledByDefault: true, refreshMinutes: 360
  }])
})

test("a static redirect needs a replacement with a fixed host; a dynamic one needs a script", () => {
  assert.throws(() => readAddonRedirects([{ id: "to-mirror", title: "T", match: "x" }]), /replace/)
  assert.throws(() => readAddonRedirects([{ id: "to-mirror", title: "T", match: "x", replace: "https://$1/" }]), /fixed host/)
  assert.throws(() => readAddonRedirects([{ id: "to-mirror", title: "T", match: "(" }]), /regular expression/)
  const dynamic = [{ id: "to-mirror", title: "T", match: "x", dynamic: true }]
  assert.equal(readAddonManifest(manifest(dynamic)).ok, false)
  const read = readAddonManifest(manifest(dynamic, { script: SCRIPT }))
  assert.equal(read.ok, true)
  assert.equal(read.manifest.redirects[0].dynamic, true)
})

test("the user's switches survive the doc, the text editor, and an update", () => {
  const entry = { enabled: true, manifest: manifest([{ id: "to-mirror", title: "T", match: "x", dynamic: true }], { script: SCRIPT }), redirectToggles: { "to-mirror": false, "Bad Id": true } }
  const doc = readAddonsDocument({ version: 1, addons: [entry] })
  assert.deepEqual(doc.addons[0].redirectToggles, { "to-mirror": false })
  const again = parseAddonsText(presentAddons(doc))
  assert.deepEqual(again.addons[0].redirectToggles, { "to-mirror": false })
  assert.equal(again.addons[0].manifest.redirects.length, 1)
  const updated = upsertAddon(doc, { enabled: true, manifest: { ...doc.addons[0].manifest, version: "1.0.1" } })
  assert.deepEqual(updated.addons[0].redirectToggles, { "to-mirror": false })
})

test("a page moves between mirrors by its replacement's fixed prefix", () => {
  assert.equal(redirectReplacementPrefix("https://a.test/$1"), "https://a.test/")
  assert.equal(moveRedirectedUrl("https://a.test/jack/status/1", "https://a.test/$1", "https://b.test/$1"), "https://b.test/jack/status/1")
  assert.equal(moveRedirectedUrl("https://other.test/x", "https://a.test/$1", "https://b.test/$1"), null)
})
