const test = require("node:test")
const assert = require("node:assert/strict")
const { documentRetrievalMethods } = require("../../../packages/app/dist/documentRetrievalMethods")

const html = async (url) => new Response("<!doctype html><p>Body</p>", { headers: { "content-type": "text/html" } , status: 200 })

test("documents are fetched through the platform's bounded document fetch when it has one", async () => {
  const used = []
  const platform = {
    fetch: async (url) => { used.push(["fetch", url]); return html(url) },
    documentFetch: async (url) => { used.push(["documentFetch", url]); return html(url) }
  }
  const result = await documentRetrievalMethods(platform).retrieveDocument("https://example.test/article")
  assert.equal(result.kind, "html")
  assert.deepEqual(used, [["documentFetch", "https://example.test/article"]])
  const plain = []
  await documentRetrievalMethods({ fetch: async (url) => { plain.push(url); return html(url) } }).fetchDocument("https://example.test/article")
  assert.deepEqual(plain, ["https://example.test/article"])
})
