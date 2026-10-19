/* global browser */
// Fixture background: the unit test plays this page over the broker protocol.
browser.webRequest.onBeforeRequest.addListener(
  () => ({ cancel: true }), { urls: ["*://*/*blocked.png"], types: ["image"] }, ["blocking"]
)
browser.runtime.onMessage.addListener((message) => Promise.resolve({ echo: message }))
