/* global browser */
// Ran, and reached the background as a page of a tab it can look up.
document.documentElement.dataset.contentProbe = "ran"
browser.runtime.sendMessage({ url: location.href }).then(reply => {
  document.documentElement.dataset.contentProbeReply = JSON.stringify(reply)
})
