const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { installRawAssetLoader } = require("../../helpers/raw-assets")

test("an explicit source refresh skips saved content and reports fetched provenance", async () => {
  const { window } = parseHTML("<html><body></body></html>")
  // Browsers put fragments in body; linkedom needs the explicit wrapper.
  class FragmentParser extends window.DOMParser {
    parseFromString(html, type) { return super.parseFromString(/<html[\s>]/i.test(html) ? html : `<html><head></head><body>${html}</body></html>`, type) }
  }
  Object.assign(global, { document: window.document, DOMParser: FragmentParser })
  installRawAssetLoader()
  const { addonStoryContent } = require("../../../packages/ui-web/dist/addons/addonStoryContent")
  const calls = []
  const html = `<html><head><title>New article</title></head><body><article><h1>New article</h1><p>${"A detailed account of the new article and its evidence. ".repeat(50)}</p></article></body></html>`
  const client = {
    getStoryContent: async () => {calls.push("saved");return {html:"<p>Old article</p>",meta:{source:"page",saved_at:1}}},
    livePageHtml: async () => { calls.push("live"); return null },
    fetchDocument: async href => {calls.push("fetch");return {html,url:href,mediaType:"text/html"}}
  }
  const saved = await addonStoryContent(client,"https://example.test/a")
  assert.equal(saved.origin,"stored")
  const fresh = await addonStoryContent(client,"https://example.test/a",undefined,true)
  assert.equal(fresh.origin,"page")
  assert.match(fresh.text,/new article/)
  assert.deepEqual(calls,["saved","live","fetch"])
})

test("an open page is read as shown there before any fetch, and a failed fetch says how to get further", async () => {
  const { window } = parseHTML("<html><body></body></html>")
  class FragmentParser extends window.DOMParser {
    parseFromString(html, type) { return super.parseFromString(/<html[\s>]/i.test(html) ? html : `<html><head></head><body>${html}</body></html>`, type) }
  }
  Object.assign(global, { document: window.document, DOMParser: FragmentParser })
  installRawAssetLoader()
  const { addonStoryContent } = require("../../../packages/ui-web/dist/addons/addonStoryContent")
  const rendered = `<html><head><title>Rendered</title></head><body><article><h1>Rendered</h1><p>${"What the scripts drew into the page after it loaded. ".repeat(50)}</p></article></body></html>`
  const calls = []
  const client = {
    getStoryContent: async () => null,
    livePageHtml: async () => { calls.push("live"); return { html: rendered, url: "https://example.test/a" } },
    fetchDocument: async () => { calls.push("fetch"); throw new Error("should not fetch") }
  }
  const live = await addonStoryContent(client, "https://example.test/a")
  assert.equal(live.origin, "live")
  assert.match(live.text, /scripts drew/)
  assert.deepEqual(calls, ["live"])
  const closed = { ...client, livePageHtml: async () => null, fetchDocument: async () => { throw new Error("The reader request failed with HTTP 403") } }
  await assert.rejects(addonStoryContent(closed, "https://example.test/a"), /HTTP 403\. Open the page, then choose Read the page/)
})

test("an open image retrieves OCR text for addons instead of its empty HTML", async () => {
  const { window } = parseHTML("<html><body></body></html>")
  class FragmentParser extends window.DOMParser {
    parseFromString(html, type) { return super.parseFromString(/<html[\s>]/i.test(html) ? html : `<html><head></head><body>${html}</body></html>`, type) }
  }
  Object.assign(global, { document: window.document, DOMParser: FragmentParser })
  installRawAssetLoader()
  const { addonStoryContent } = require("../../../packages/ui-web/dist/addons/addonStoryContent")
  const { fetchDocument } = require("../../../packages/app/dist/fetchDocument")
  const client = {
    getStoryContent: async () => null,
    livePageHtml: async url => ({ url, html: '<html><head></head><body><img src="image.jpeg"></body></html>' }),
    fetchDocument: url => fetchDocument(async () => new Response(new Uint8Array([1]), {
      headers: { "content-type": "image/jpeg" }
    }), url, { async recognizeImage() { return { lines: ["Short image text", "Second line"] } } })
  }
  const content = await addonStoryContent(client, "https://example.test/image.jpeg")
  assert.match(content.text, /Short image text\nSecond line/)
  assert.equal(content.origin, "page")
  assert.equal(content.sourceUrl, "https://example.test/image.jpeg")
  assert.equal(content.truncated, false)
})
