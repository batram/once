/* global browser */
globalThis.contentVisits = []
browser.runtime.onMessage.addListener(message => {
  globalThis.contentVisits.push(message)
})
