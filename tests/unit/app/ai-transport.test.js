const test = require("node:test")
const assert = require("node:assert/strict")
const { aiTransport } = require("../../../packages/app/dist/ai/transport")
const connection = { id: "local", name: "Local", provider: "compatible", endpoint: "http://localhost/v1/chat/completions" }

async function streamed(pieces, token) {
  const fetch = async () => new Response(new ReadableStream({
    start(controller) { for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece)); controller.close() }
  }), { headers: { "content-type": "text/event-stream" } })
  const chunks = []
  const result = await aiTransport(fetch, connection, token, { method: "POST", body: "{}" }, undefined, text => chunks.push(text))
  return { chunks, result }
}

test("a connection without a token streams every piece whole, as it arrives", async () => {
  const { chunks, result } = await streamed(["abc", "def", "ghi"], "")
  assert.deepEqual(chunks, ["abc", "def", "ghi"])
  assert.equal(result.text, "abcdefghi")
})

test("a one-character token holds nothing back and is still redacted", async () => {
  const { chunks, result } = await streamed(["abc", "dXf", "ghi"], "X")
  assert.deepEqual(chunks, ["abc", "d[redacted]f", "ghi"])
  assert.equal(result.text, "abcd[redacted]fghi")
})

test("a token straddling two pieces is redacted, and no piece carries part of it", async () => {
  const pieces = ["data: a\n", "leak abc-se", "cret here\n", "data: abc-secret", " end\n"]
  const { chunks, result } = await streamed(pieces, "abc-secret")
  assert.equal(result.text, "data: a\nleak [redacted] here\ndata: [redacted] end\n")
  assert.equal(chunks.join(""), result.text)
  assert.ok(chunks.length > 1, "text arrives in pieces, not only at the end")
  assert.ok(chunks.every(chunk => !chunk.includes("abc") && !chunk.includes("cret")), "no piece carries part of the token")
})
