/** Check the actual sender document, rather than trusting a command in its message. */
export function isExtensionPageSender(
  browserApi: typeof browser,
  sender: browser.runtime.MessageSender,
  page: "sidepanel" | "reader"
): boolean {
  if (!sender.url) return false
  try {
    const actual = new URL(sender.url)
    const expected = new URL(browserApi.runtime.getURL(`/static/${page}.html`))
    return actual.protocol === expected.protocol && actual.host === expected.host &&
      actual.pathname === expected.pathname
  } catch {
    return false
  }
}

export function isTabContentSender(sender: browser.runtime.MessageSender): boolean {
  if (sender.tab?.id == null || !sender.url) return false
  try {
    const protocol = new URL(sender.url).protocol
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}
