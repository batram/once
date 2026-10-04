/* global browser */
// What a content script's sender looks like, as blockers and theming
// extensions read it: the tab, and whether tabs.get finds it.
browser.runtime.onMessage.addListener(async (_message, sender) => {
  const tab = sender.tab
  const found = tab ? await browser.tabs.get(tab.id).then(item => item.id, () => null) : null
  return { tabId: tab?.id ?? null, tabUrl: tab?.url ?? null, found }
})
