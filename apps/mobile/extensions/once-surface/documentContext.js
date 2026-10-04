/* global browser */
// Response provenance stays in the trusted background; page scripts cannot claim
// that an unrelated page or an HTTP error is the story originally requested.
const onceDocuments = new Map()
const onceDocumentUrl = url => { const value = new URL(url); value.hash = ""; return value.href }
const onceDocumentFilter = { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] }
browser.webRequest.onBeforeRequest.addListener(details => {
  const previous = onceDocuments.get(details.tabId)
  onceDocuments.set(details.tabId, previous?.requestId === details.requestId
    ? { ...previous, url: details.url }
    : { requestId: details.requestId, sourceUrl: previous && onceDocumentUrl(previous.url) === onceDocumentUrl(details.url)
      ? previous.sourceUrl : details.url, url: details.url })
}, onceDocumentFilter)
browser.webRequest.onHeadersReceived.addListener(details => {
  if (details.statusCode >= 300 && details.statusCode < 400) return
  const previous = onceDocuments.get(details.tabId)
  if (previous?.requestId === details.requestId) {
    onceDocuments.set(details.tabId, { ...previous, url: details.url, statusCode: details.statusCode })
  }
}, onceDocumentFilter)
browser.tabs.onRemoved.addListener(id => onceDocuments.delete(id))
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "once-document-context" || sender.frameId !== 0) return undefined
  const context = onceDocuments.get(sender.tab?.id)
  return Promise.resolve(context && onceDocumentUrl(context.url) === onceDocumentUrl(sender.url) ? context : null)
})
