const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const path = require("node:path")

const SOURCE_URL = "https://old.reddit.com/r/netsec/.json"
const FIXTURE_PATH = path.resolve(
  __dirname,
  "../fixtures/story-sources/reddit-netsec.json"
)
const MAX_RESPONSE_BYTES = 1_000_000
const TIMEOUT_MS = 10_000

test("refreshes the reusable story fixture with exactly one live request", async () => {
  let requestCount = 0
  const fetchOnce = async () => {
    requestCount += 1
    assert.equal(requestCount, 1, "the refresh may make only one network request")
    return fetch(SOURCE_URL, {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: "application/json",
        "user-agent": "once-test-fixture-refresh/1.0 (single opt-in request)",
      },
    })
  }

  const response = await fetchOnce()
  assert.equal(response.ok, true, `story source returned HTTP ${response.status}`)
  const declaredSize = Number(response.headers.get("content-length") || 0)
  assert.ok(
    declaredSize <= MAX_RESPONSE_BYTES,
    `story source response exceeds ${MAX_RESPONSE_BYTES} bytes`
  )

  assert.ok(response.body, "story source response has no body")
  const reader = response.body.getReader()
  const chunks = []
  let receivedBytes = 0
  while (true) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    receivedBytes += chunk.byteLength
    if (receivedBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel("response exceeded the fixture size limit")
      assert.fail("story source response is too large")
    }
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks, receivedBytes)
  const fixture = JSON.parse(new TextDecoder().decode(bytes))
  assert.equal(fixture.kind, "Listing")
  assert.ok(Array.isArray(fixture.data?.children))
  assert.ok(fixture.data.children.length > 0)
  assert.ok(
    fixture.data.children.some(({ data }) => data?.ups >= 35),
    "fixture must contain a story accepted by the collector"
  )
  assert.equal(requestCount, 1)

  await fs.writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8")
})
