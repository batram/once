/** Read supported web URLs from a drop, preserving order and removing duplicates. */
export function parseDroppedUrls(transfer: DataTransfer): string[] {
  const values = transfer.getData("text/uri-list") || transfer.getData("text/plain")
  const urls: string[] = []
  for (const line of values.split(/\r?\n/)) {
    const value = line.trim()
    if (!value || value.startsWith("#")) continue
    if (value.startsWith("http://") || value.startsWith("https://")) urls.push(value)
  }
  return [...new Set(urls)]
}
