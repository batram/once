const test = require("node:test")
const assert = require("node:assert/strict")
const { AddonRedirects } = require("../../../packages/app/dist/AddonRedirects")
const { readAddonRedirects, emptyAddonsDocument } = require("../../../packages/core/dist")

const [rule] = readAddonRedirects([{
  id: "x-to-mirror", title: "X → mirror", match: "^https://x\\.com/(.*)$", dynamic: true
}])

function memoryCache() {
  const entries = new Map()
  return { entries, get: async (key) => entries.get(key), set: async (key, value) => { entries.set(key, value) }, delete: async () => {}, clear: async () => {} }
}

function harness({ cache = memoryCache(), now = { value: 1_000_000 }, handler } = {}) {
  let changes = 0
  let doc = emptyAddonsDocument()
  doc.addons.push({ enabled: true, manifest: { id: "mirror" } })
  const redirects = new AddonRedirects(cache, () => { changes++ }, async (change) => { doc = change(doc) }, () => now.value)
  return { redirects, cache, now, handler, changes: () => changes, doc: () => doc }
}

function mirrors(...targets) {
  const asked = { target: 0, failed: [] }
  let index = 0
  return {
    asked,
    target: async () => { asked.target++; return targets[index] },
    failed: async (_id, url) => { asked.failed.push(url); index++; return targets[index] ?? null }
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("a dynamic rule is off until the add-on names a replacement, then joins the rules", async () => {
  const h = harness()
  const handler = mirrors("https://a.test/$1")
  await h.redirects.register("mirror", "Mirror", [rule], handler)
  await settle()
  assert.equal(handler.asked.target, 1)
  assert.deepEqual(h.redirects.rules(), [{ match_url: rule.match, replace_url: "https://a.test/$1", origin: "addon:mirror/x-to-mirror" }])
  assert.equal(h.cache.entries.get("addon-redirect:addon:mirror/x-to-mirror").replacement, "https://a.test/$1")
})

test("a recent pick from this device is used at startup without asking the add-on", async () => {
  const cache = memoryCache()
  cache.entries.set("addon-redirect:addon:mirror/x-to-mirror", { replacement: "https://cached.test/$1", at: 999_000 })
  const h = harness({ cache })
  const handler = mirrors("https://a.test/$1")
  await h.redirects.register("mirror", "Mirror", [rule], handler)
  await settle()
  assert.equal(handler.asked.target, 0)
  assert.equal(h.redirects.rules()[0].replace_url, "https://cached.test/$1")
})

test("an old pick is used at once and refreshed behind it", async () => {
  const cache = memoryCache()
  cache.entries.set("addon-redirect:addon:mirror/x-to-mirror", { replacement: "https://old.test/$1", at: 0 })
  const h = harness({ cache, now: { value: rule.refreshMinutes * 60_000 + 1 } })
  let answer
  const handler = { target: () => new Promise((resolve) => { answer = resolve }), failed: async () => null }
  await h.redirects.register("mirror", "Mirror", [rule], handler)
  assert.equal(h.redirects.rules()[0].replace_url, "https://old.test/$1")
  answer("https://fresh.test/$1")
  await settle()
  assert.equal(h.redirects.rules()[0].replace_url, "https://fresh.test/$1")
})

test("a failed page moves the rule and comes back as the same page on the next mirror", async () => {
  const h = harness()
  const handler = mirrors("https://a.test/$1", "https://b.test/$1")
  await h.redirects.register("mirror", "Mirror", [rule], handler)
  await settle()
  assert.equal(await h.redirects.reportFailure("https://a.test/jack/status/1", "HTTP 503"), "https://b.test/jack/status/1")
  assert.equal(h.redirects.rules()[0].replace_url, "https://b.test/$1")
  // Another tab still on the old mirror follows without asking again.
  assert.equal(await h.redirects.reportFailure("https://a.test/other", "HTTP 503"), "https://b.test/other")
  assert.deepEqual(handler.asked.failed, ["https://a.test/jack/status/1"])
})

test("failover is spaced out, and pages no rule produced are left alone", async () => {
  const h = harness()
  const handler = mirrors("https://a.test/$1", "https://b.test/$1", "https://c.test/$1")
  await h.redirects.register("mirror", "Mirror", [rule], handler)
  await settle()
  assert.equal(await h.redirects.reportFailure("https://unrelated.test/", "net::ERR"), null)
  await h.redirects.reportFailure("https://a.test/x", "HTTP 503")
  assert.equal(await h.redirects.reportFailure("https://b.test/x", "HTTP 503"), null, "within 30 s of the last move")
  h.now.value += 30_000
  assert.equal(await h.redirects.reportFailure("https://b.test/x", "HTTP 503"), "https://c.test/x")
})

test("the user's switch is stored in the add-ons doc and turns the rule off", async () => {
  const h = harness()
  await h.redirects.register("mirror", "Mirror", [rule], mirrors("https://a.test/$1"))
  await settle()
  await h.redirects.setEnabled("addon:mirror/x-to-mirror", false)
  assert.deepEqual(h.doc().addons[0].redirectToggles, { "x-to-mirror": false })
  h.redirects.readToggles(h.doc())
  assert.deepEqual(h.redirects.rules(), [])
  assert.equal(h.redirects.list()[0].enabled, false)
  assert.equal(await h.redirects.reportFailure("https://a.test/x", "HTTP 503"), null)
})

test("withdrawing an add-on removes its rules", async () => {
  const h = harness()
  const withdraw = await h.redirects.register("mirror", "Mirror", [rule], mirrors("https://a.test/$1"))
  await settle()
  withdraw()
  assert.deepEqual(h.redirects.list(), [])
})
