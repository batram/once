const test = require("node:test")
const assert = require("node:assert/strict")
const { connectionOriginRules, installConnectionOriginBackground, panelFrameRules } =require("../../../packages/webext-shell/dist/connectionOriginBackground")

// YouTube's InnerTube player answers 403 to a request carrying an extension
// Origin, so the side panels drop it there, and only for their own requests.
test("the extension's own InnerTube requests lose their Origin header", () => {
  const [rule, ...rest] = connectionOriginRules("ffnhmhcbmagonmmmghomcolcmeikcine")
  assert.equal(rest.length, 0)
  assert.deepEqual(rule.action, { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] })
  assert.deepEqual(rule.condition, {
    urlFilter: "||youtube.com/youtubei/",
    initiatorDomains: ["ffnhmhcbmagonmmmghomcolcmeikcine"],
    resourceTypes: ["xmlhttprequest"]
  })
})

// Comment sites forbid framing; the comments panel frames them outside any tab,
// including pages the reader reaches by following links inside the frame.
test("pages framed outside a tab lose the headers that forbid framing", () => {
  const rules = panelFrameRules("ffnhmhcbmagonmmmghomcolcmeikcine")
  for (const rule of rules) {
    assert.deepEqual(rule.action.responseHeaders.map((header) => [header.header, header.operation]), [
      ["x-frame-options", "remove"],
      ["content-security-policy", "remove"]
    ])
  }
  assert.deepEqual(rules.map((rule) => rule.condition), [
    { initiatorDomains: ["ffnhmhcbmagonmmmghomcolcmeikcine"], resourceTypes: ["sub_frame"] },
    { tabIds: [-1], resourceTypes: ["sub_frame"] }
  ])
})

test("every start replaces the rules under the extension's own host", async () => {
  const calls = []
  const session = []
  await installConnectionOriginBackground({
    updateDynamicRules: async (options) => { calls.push(options) },
    updateSessionRules: async (options) => { session.push(options) }
  }, "moz-extension://00000000-0000-4000-8000-000000000002/")
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].removeRuleIds, calls[0].addRules.map((rule) => rule.id))
  assert.deepEqual(calls[0].addRules[0].condition.initiatorDomains, ["00000000-0000-4000-8000-000000000002"])
  // The tab condition is only allowed on session rules.
  assert.equal(session.length, 1)
  assert.deepEqual(session[0].removeRuleIds, session[0].addRules.map((rule) => rule.id))
  assert.deepEqual(session[0].addRules[1].condition.tabIds, [-1])
  // Without session rules, the dynamic ones still install.
  await installConnectionOriginBackground({ updateDynamicRules: async () => {} }, "chrome-extension://x/")
  // A browser without the API leaves requests as they are.
  await installConnectionOriginBackground(undefined, "chrome-extension://x/")
})
