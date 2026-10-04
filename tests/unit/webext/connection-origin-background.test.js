const test = require("node:test")
const assert = require("node:assert/strict")
const { connectionOriginRules, installConnectionOriginBackground } = require("../../../packages/webext-shell/dist/connectionOriginBackground")

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

test("every start replaces the rules under the extension's own host", async () => {
  const calls = []
  await installConnectionOriginBackground({ updateDynamicRules: async (options) => { calls.push(options) } },
    "moz-extension://00000000-0000-4000-8000-000000000002/")
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].removeRuleIds, calls[0].addRules.map((rule) => rule.id))
  assert.deepEqual(calls[0].addRules[0].condition.initiatorDomains, ["00000000-0000-4000-8000-000000000002"])
  // A browser without the API leaves requests as they are.
  await installConnectionOriginBackground(undefined, "chrome-extension://x/")
})
