const test = require("node:test")
const assert = require("node:assert/strict")
const { AddonConnections } = require("../../../packages/app/dist/addonConnections")
const manifest = { id: "example-addon", connections: [{ id: "provider", endpoint: "endpoint", secret: "token", auth: "bearer" }] }
const options = { endpoint: "https://api.example.test/v1/messages" }
function fixture(fetch) {
  const storage = new Map()
  const connections = new AddonConnections(fetch, { get: key => storage.get(key) || "", set: (key, value) => storage.set(key, value) })
  return { connections, storage }
}

test("host injects bound credentials and preserves status while redacting echoed secrets", async () => {
  let received
  const { connections } = fixture(async (url, init) => {
    received = { url, init }
    return new Response("token abc-secret", { status: 429, headers: { "retry-after": "15", "set-cookie": "private" } })
  })
  await connections.save(manifest.id, "token", options.endpoint, "abc-secret")
  assert.equal(await connections.configured(manifest.id, "token", options.endpoint), true)
  const result = await connections.request(manifest, options, "provider", { method: "POST", body: "{}" })
  assert.equal(received.init.headers.get("authorization"), "Bearer abc-secret")
  assert.equal(received.init.redirect, "error")
  assert.equal(received.init.credentials, "omit")
  assert.equal(result.status, 429)
  assert.equal(result.text, "token [redacted]")
  assert.deepEqual(result.headers, { "content-type": "text/plain;charset=UTF-8", "retry-after": "15" })
})

test("endpoint changes and undeclared connections fail before network access", async () => {
  let requests = 0
  const { connections } = fixture(async () => { requests++; return new Response("ok") })
  await connections.save(manifest.id, "token", options.endpoint, "abc-secret")
  await assert.rejects(connections.request(manifest, { endpoint: "https://other.test/" }, "provider", {}), /Endpoint changed/)
  await assert.rejects(connections.request(manifest, options, "unknown", {}), /not declared/)
  assert.equal(requests, 0)
  await connections.save(manifest.id, "token", "", "")
  assert.equal(await connections.configured(manifest.id, "token", options.endpoint), false)
})

test("cancelled operations never begin, oversized responses fail, transport errors hide details", async () => {
  let requests = 0
  const { connections } = fixture(async () => { requests++; return new Response("x".repeat(1024 * 1024 + 1)) })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(connections.request(manifest, options, "provider", {}, controller.signal))
  assert.equal(requests, 0)
  await assert.rejects(connections.request(manifest, options, "provider", {}), /too large/)
  const broken = fixture(async () => { throw new Error("server echoed secret") }).connections
  await assert.rejects(broken.request(manifest, options, "provider", {}), error => !error.message.includes("secret"))
})
