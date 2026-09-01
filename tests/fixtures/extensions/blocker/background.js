/* global browser */
// Fixture background script: cancels every request for a `blocked.txt` and
// remembers what it cancelled, so a test can read the list back through
// storage or a runtime message.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    browser.storage.local.get({ blocked: [] }).then(({ blocked }) =>
      browser.storage.local.set({ blocked: [...blocked, details.url] })
    )
    return { cancel: true }
  },
  { urls: ["*://*/*blocked.txt"] },
  ["blocking"]
)

browser.runtime.onMessage.addListener((message) => {
  if (message === "blocked?") return browser.storage.local.get({ blocked: [] })
  return Promise.resolve({ echo: message, name: browser.i18n.getMessage("extName") })
})
