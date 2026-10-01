const assert = require("node:assert/strict")
const test = require("node:test")
const { downloadExtension } = require("../../scripts/download-extension")

const url = "https://example.test/pinned-extension.zip"

test("a transient connection failure retries and returns the original archive bytes", async () => {
  let calls = 0
  const waits = []
  const body = Buffer.from([0, 255, 1, 128])
  const result = await downloadExtension(url, {
    async request(target, options) {
      assert.equal(target, url)
      assert.equal(options.redirect, "follow")
      if (++calls < 3) throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "UND_ERR_CONNECT_TIMEOUT" }
      })
      return new Response(body)
    },
    wait: async ms => { waits.push(ms) },
    warn() {}
  })
  assert.deepEqual(result, body)
  assert.deepEqual(waits, [1000, 2000])
  assert.equal(calls, 3)
})

test("temporary HTTP failures release their body and retry", async () => {
  let calls = 0
  let cancelled = 0
  const result = await downloadExtension(url, {
    async request() {
      if (++calls === 1) return {
        ok: false, status: 503, body: { async cancel() { cancelled++ } }
      }
      return new Response("archive")
    },
    wait: async () => {},
    warn() {}
  })
  assert.equal(result.toString(), "archive")
  assert.equal(cancelled, 1)
  assert.equal(calls, 2)
})

test("transient failures still reject after three attempts", async () => {
  let calls = 0
  await assert.rejects(downloadExtension(url, {
    async request() { calls++; return new Response("unavailable", { status: 503 }) },
    wait: async () => {},
    warn() {}
  }), /HTTP 503/)
  assert.equal(calls, 3)
})

test("permanent HTTP and certificate errors fail without retrying", async () => {
  for (const outcome of [
    new Response("not found", { status: 404 }),
    Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } })
  ]) {
    let calls = 0
    await assert.rejects(downloadExtension(url, {
      async request() {
        calls++
        if (outcome instanceof Error) throw outcome
        return outcome
      },
      wait: async () => { assert.fail("permanent errors must not wait") },
      warn() {}
    }))
    assert.equal(calls, 1)
  }
})
