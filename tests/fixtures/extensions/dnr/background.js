/* global browser */
// Fixture background: adds one dynamic rule that redirects any
// `dnr-redirect.txt` fetch to `dnr-redirected.txt` on the same origin, and
// records what the API reports so a test can read it back from this page.
globalThis.dnrState = { ready: false, error: null, enabled: null, dynamic: null }

;(async () => {
  try {
    await browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [100],
      addRules: [{
        id: 100,
        priority: 1,
        action: { type: "redirect", redirect: { transform: { path: "/dnr-redirected.txt" } } },
        condition: { urlFilter: "dnr-redirect.txt", resourceTypes: ["xmlhttprequest"] }
      }]
    })
    globalThis.dnrState.enabled = await browser.declarativeNetRequest.getEnabledRulesets()
    globalThis.dnrState.dynamic = (await browser.declarativeNetRequest.getDynamicRules()).map((rule) => rule.id)
  } catch (error) {
    globalThis.dnrState.error = String(error)
  }
  globalThis.dnrState.ready = true
})()
