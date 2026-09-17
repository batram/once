const test = require("node:test")
const assert = require("node:assert/strict")
const {
  DnrMatcher,
  applyHeaderModifications,
  compileUrlFilter,
  isRegexSupported,
  isThirdPartyRequest,
  parseDnrRule,
  parseDnrRules,
  transformUrl
} = require("../../../packages/core/dist/webext")

const BASE = "moz-extension://abc/"

function rule(id, action, condition = {}, priority = 1) {
  return { id, priority, action, condition }
}

function matcher(rules) {
  return new DnrMatcher(rules.map((entry) => parseDnrRule(entry)), { extensionBaseUrl: BASE })
}

function request(url, overrides = {}) {
  return { url, type: "script", method: "GET", initiator: "https://site.test/page", ...overrides }
}

test("urlFilter patterns: domain anchor, edge anchors, wildcard and separator", () => {
  const domain = compileUrlFilter("||ads.test^", false)
  assert.equal(domain.test("https://ads.test/x.js"), true)
  assert.equal(domain.test("https://cdn.ads.test/x.js"), true)
  assert.equal(domain.test("https://ads.test:8080/x.js"), true)
  assert.equal(domain.test("https://notads.test/x.js"), false)
  assert.equal(domain.test("https://ads.testing/x.js"), false)
  assert.equal(domain.test("https://site.test/?ref=ads.test"), false)

  const start = compileUrlFilter("|https://site.test/api", false)
  assert.equal(start.test("https://site.test/api/v1"), true)
  assert.equal(start.test("https://other.test/https://site.test/api"), false)

  const end = compileUrlFilter("*.png|", false)
  assert.equal(end.test("https://site.test/a.png"), true)
  assert.equal(end.test("https://site.test/a.png?x"), false)

  const substring = compileUrlFilter("/tracker/", false)
  assert.equal(substring.test("https://site.test/tracker/pixel"), true)
  assert.equal(substring.test("https://site.test/TRACKER/pixel"), true)
  assert.equal(compileUrlFilter("/tracker/", true).test("https://site.test/TRACKER/pixel"), false)

  // A separator also matches the end of the URL and regex characters are literal.
  assert.equal(compileUrlFilter("||site.test/path^", false).test("https://site.test/path"), true)
  assert.equal(compileUrlFilter("a.b(c)", false).test("https://site.test/a.b(c)"), true)
  assert.equal(compileUrlFilter("a.b(c)", false).test("https://site.test/axb(c)"), false)
})

test("conditions narrow by type, method, domains, domain type and regex", () => {
  const m = matcher([
    rule(1, { type: "block" }, { urlFilter: "||ads.test", resourceTypes: ["image"] }),
    rule(2, { type: "block" }, { regexFilter: "^https://api\\.test/v[0-9]+/", requestMethods: ["post"] }),
    rule(3, { type: "block" }, { requestDomains: ["tracker.test"], excludedInitiatorDomains: ["trusted.test"] }),
    rule(4, { type: "block" }, { domainType: "thirdParty", initiatorDomains: ["strict.test"] }),
    rule(5, { type: "block" }, { urlFilter: "everywhere", excludedResourceTypes: ["main_frame"] }),
    rule(6, { type: "block" }, { urlFilter: "tabbed", tabIds: [7] })
  ])
  const blocked = (url, overrides) => m.evaluate(request(url, overrides)).outcome === "block"
  assert.equal(blocked("https://ads.test/a.png", { type: "image" }), true)
  assert.equal(blocked("https://ads.test/a.js", { type: "script" }), false)
  assert.equal(blocked("https://api.test/v2/x", { method: "POST", type: "xmlhttprequest" }), true)
  assert.equal(blocked("https://api.test/v2/x", { method: "GET", type: "xmlhttprequest" }), false)
  assert.equal(blocked("https://sub.tracker.test/x"), true)
  assert.equal(blocked("https://sub.tracker.test/x", { initiator: "https://a.trusted.test/" }), false)
  assert.equal(blocked("https://cdn.test/x", { initiator: "https://strict.test/" }), true)
  assert.equal(blocked("https://strict.test/x", { initiator: "https://strict.test/" }), false)
  assert.equal(blocked("https://cdn.test/x", { initiator: null }), false, "no initiator matches no initiator list")
  assert.equal(blocked("https://site.test/everywhere", { type: "main_frame", initiator: null }), false)
  assert.equal(blocked("https://site.test/everywhere", { type: "sub_frame" }), true)
  assert.equal(blocked("https://site.test/tabbed", { tabId: 7 }), true)
  assert.equal(blocked("https://site.test/tabbed", { tabId: 8 }), false)
  assert.equal(isThirdPartyRequest("https://cdn.site.test/x", "https://www.site.test/"), false)
  assert.equal(isThirdPartyRequest("https://cdn.other.test/x", "https://www.site.test/"), true)
})

test("priority decides, and at a tie allow beats block beats upgrade beats redirect", () => {
  const tie = matcher([
    rule(1, { type: "redirect", redirect: { url: "https://elsewhere.test/" } }, { urlFilter: "tie" }),
    rule(2, { type: "upgradeScheme" }, { urlFilter: "tie" }),
    rule(3, { type: "block" }, { urlFilter: "tie" }),
    rule(4, { type: "allow" }, { urlFilter: "tie" })
  ])
  assert.equal(tie.evaluate(request("http://site.test/tie")).outcome, "allow")
  const noAllow = matcher([
    rule(1, { type: "redirect", redirect: { url: "https://elsewhere.test/" } }, { urlFilter: "tie" }),
    rule(2, { type: "upgradeScheme" }, { urlFilter: "tie" }),
    rule(3, { type: "block" }, { urlFilter: "tie" })
  ])
  assert.equal(noAllow.evaluate(request("http://site.test/tie")).outcome, "block")
  const upgrade = matcher([
    rule(1, { type: "redirect", redirect: { url: "https://elsewhere.test/" } }, { urlFilter: "tie" }),
    rule(2, { type: "upgradeScheme" }, { urlFilter: "tie" })
  ])
  assert.deepEqual(
    [upgrade.evaluate(request("http://site.test/tie")).outcome, upgrade.evaluate(request("http://site.test/tie")).redirectUrl],
    ["upgradeScheme", "https://site.test/tie"]
  )
  const higher = matcher([
    rule(1, { type: "allow" }, { urlFilter: "x" }, 1),
    rule(2, { type: "block" }, { urlFilter: "x" }, 5)
  ])
  assert.equal(higher.evaluate(request("https://site.test/x")).rule.id, 2)
  assert.equal(matcher([]).evaluate(request("https://site.test/x")).outcome, "none")
})

test("redirects resolve url, extensionPath, regexSubstitution and transform", () => {
  const m = matcher([
    rule(1, { type: "redirect", redirect: { extensionPath: "/blank.js" } }, { urlFilter: "||ads.test", resourceTypes: ["script"] }),
    rule(2, { type: "redirect", redirect: { regexSubstitution: "https://\\1.mirror.test/\\2?from=$" } },
      { regexFilter: "^https://([a-z]+)\\.slow\\.test/(.*)$" }),
    rule(3, { type: "redirect", redirect: { transform: {
      scheme: "https", host: "fast.test", queryTransform: { removeParams: ["utm"], addOrReplaceParams: [
        { key: "v", value: "2" }, { key: "only", value: "x", replaceOnly: true }
      ] }, fragment: "#top"
    } } }, { urlFilter: "||old.test" }),
    rule(4, { type: "redirect", redirect: { url: "https://site.test/same" } }, { urlFilter: "||site.test/same" })
  ])
  assert.equal(m.evaluate(request("https://ads.test/x.js")).redirectUrl, "moz-extension://abc/blank.js")
  assert.equal(
    m.evaluate(request("https://img.slow.test/a/b.png")).redirectUrl,
    "https://img.mirror.test/a/b.png?from=$"
  )
  assert.equal(
    m.evaluate(request("http://old.test/p?utm=1&v=1")).redirectUrl,
    "https://fast.test/p?v=2#top"
  )
  assert.equal(m.evaluate(request("https://site.test/same")).outcome, "none", "a redirect to itself is ignored")
  assert.equal(transformUrl("https://a.test/x?q=1", { port: "8443", path: "/y" }), "https://a.test:8443/y?q=1")
})

test("allowAllRequests from the frame acts as an allow of its priority", () => {
  const m = matcher([
    rule(1, { type: "allowAllRequests" }, { urlFilter: "||trusted.test", resourceTypes: ["main_frame"] }, 3),
    rule(2, { type: "block" }, { urlFilter: "||ads.test" }, 2),
    rule(3, { type: "block" }, { urlFilter: "||worse.test" }, 4)
  ])
  const frame = m.evaluate(request("https://trusted.test/", { type: "main_frame", initiator: null }))
  assert.equal(frame.outcome, "allow")
  assert.equal(frame.rule.id, 1)
  assert.equal(m.evaluate(request("https://ads.test/x", { frameAllowPriority: 3 })).outcome, "allow")
  assert.equal(m.evaluate(request("https://ads.test/x")).outcome, "block")
  assert.equal(m.evaluate(request("https://worse.test/x", { frameAllowPriority: 3 })).outcome, "block")
})

test("modifyHeaders rules apply in priority order and respect allow and block", () => {
  const m = matcher([
    rule(1, { type: "modifyHeaders", requestHeaders: [{ header: "X-Low", operation: "set", value: "low" }] },
      { urlFilter: "||site.test" }, 1),
    rule(2, { type: "modifyHeaders", responseHeaders: [{ header: "Set-Cookie", operation: "remove" }] },
      { urlFilter: "||site.test" }, 5),
    rule(3, { type: "allow" }, { urlFilter: "||site.test/allowed" }, 3),
    rule(4, { type: "block" }, { urlFilter: "||site.test/blocked" }, 1)
  ])
  const plain = m.evaluate(request("https://site.test/plain"))
  assert.deepEqual(plain.modifyHeaders.map((entry) => entry.id), [2, 1])
  const allowed = m.evaluate(request("https://site.test/allowed"))
  assert.deepEqual(allowed.modifyHeaders.map((entry) => entry.id), [2], "an allow drops lower-priority modifiers")
  assert.deepEqual(m.evaluate(request("https://site.test/blocked")).modifyHeaders, [])

  const rules = [
    parseDnrRule(rule(1, { type: "modifyHeaders", requestHeaders: [
      { header: "Cookie", operation: "remove" },
      { header: "Accept-Language", operation: "append", value: "de" },
      { header: "X-Set", operation: "set", value: "high" }
    ] }, {}, 2)),
    parseDnrRule(rule(2, { type: "modifyHeaders", requestHeaders: [
      { header: "cookie", operation: "set", value: "revived" },
      { header: "accept-language", operation: "append", value: "fr" },
      { header: "accept-language", operation: "remove" },
      { header: "x-set", operation: "append", value: "ignored" },
      { header: "X-New", operation: "append", value: "fresh" }
    ] }, {}, 1))
  ]
  const headers = [{ name: "Cookie", value: "a=1" }, { name: "Accept-Language", value: "en" }, { name: "X-Set", value: "old" }]
  const modified = applyHeaderModifications(headers, rules, "requestHeaders")
  assert.deepEqual(modified, [
    { name: "Accept-Language", value: "en, de, fr" },
    { name: "X-Set", value: "high" },
    { name: "X-New", value: "fresh" }
  ])
  assert.deepEqual(headers[0], { name: "Cookie", value: "a=1" }, "the input is not mutated")
  assert.equal(applyHeaderModifications(headers, [], "requestHeaders"), null)
  assert.equal(applyHeaderModifications(headers, [parseDnrRule(rule(1, { type: "modifyHeaders",
    requestHeaders: [{ header: "Nope", operation: "remove" }] }))], "requestHeaders"), null)

  const response = applyHeaderModifications(
    [{ name: "Set-Cookie", value: "a" }],
    [parseDnrRule(rule(1, { type: "modifyHeaders", responseHeaders: [{ header: "Set-Cookie", operation: "append", value: "b" }] }))],
    "responseHeaders"
  )
  assert.deepEqual(response, [{ name: "Set-Cookie", value: "a" }, { name: "Set-Cookie", value: "b" }])
})

test("rule parsing rejects what the browsers reject", () => {
  const parsed = parseDnrRule({ id: 3, action: { type: "block" }, condition: { domains: ["A.Test"], requestMethods: ["POST"] } })
  assert.equal(parsed.priority, 1)
  assert.deepEqual(parsed.condition, { initiatorDomains: ["a.test"], requestMethods: ["post"] })
  const bad = (value, pattern) => assert.throws(() => parseDnrRule(value), pattern)
  bad({ id: 0, action: { type: "block" } }, /positive integer/)
  bad({ id: 1, priority: 0, action: { type: "block" } }, /priority/)
  bad({ id: 1, action: { type: "nope" } }, /known action/)
  bad({ id: 1, action: { type: "block" }, condition: { urlFilter: "a", regexFilter: "b" } }, /both/)
  bad({ id: 1, action: { type: "block" }, condition: { urlFilter: "münchen" } }, /ASCII/)
  bad({ id: 1, action: { type: "block" }, condition: { regexFilter: "(" } }, /syntaxError/)
  bad({ id: 1, action: { type: "block" }, condition: { resourceTypes: ["script"], excludedResourceTypes: ["script"] } }, /overlap/)
  bad({ id: 1, action: { type: "block" }, condition: { resourceTypes: ["hologram"] } }, /unknown resource type/)
  bad({ id: 1, action: { type: "redirect" } }, /redirect object/)
  bad({ id: 1, action: { type: "redirect", redirect: { url: "/relative" } } }, /absolute URL/)
  bad({ id: 1, action: { type: "redirect", redirect: { url: "https://a.test/", extensionPath: "/x" } } }, /exactly one/)
  bad({ id: 1, action: { type: "redirect", redirect: { regexSubstitution: "x" } }, condition: { urlFilter: "a" } }, /regexFilter/)
  bad({ id: 1, action: { type: "redirect", redirect: { extensionPath: "x" } } }, /start with/)
  bad({ id: 1, action: { type: "modifyHeaders" } }, /requestHeaders or responseHeaders/)
  bad({ id: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "X", operation: "set" }] } }, /string value/)
  bad({ id: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "X", operation: "remove", value: "v" }] } }, /no value/)
  bad({ id: 1, action: { type: "allowAllRequests" }, condition: { urlFilter: "a" } }, /main_frame and sub_frame/)
  bad({ id: 1, action: { type: "allowAllRequests" }, condition: { resourceTypes: ["script"] } }, /main_frame and sub_frame/)
  assert.throws(() => parseDnrRules({}), /list of rules/)
  assert.throws(() => parseDnrRules([{ id: "x" }]), /rules\[0\]/)
  assert.deepEqual(isRegexSupported("a(b"), { isSupported: false, reason: "syntaxError" })
  assert.deepEqual(isRegexSupported("a".repeat(3000)), { isSupported: false, reason: "memoryLimitExceeded" })
  assert.deepEqual(isRegexSupported("^https://"), { isSupported: true })
})
