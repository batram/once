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
    fetchDocument: async href => {calls.push("fetch");return {html,url:href,mediaType:"text/html"}}
  }
  const saved = await addonStoryContent(client,"https://example.test/a")
  assert.equal(saved.origin,"stored")
  const fresh = await addonStoryContent(client,"https://example.test/a",undefined,true)
  assert.equal(fresh.origin,"page")
  assert.match(fresh.text,/new article/)
  assert.deepEqual(calls,["saved","fetch"])
})
