import type browser from "webextension-polyfill"

/** How long after the decision a late-starting download is still caught. */
const WATCH_MS = 10_000

type Downloads = typeof browser.downloads
/** Chrome also reports the URL after redirects; the polyfill's type predates it. */
type DownloadItem = browser.downloads.DownloadItem & { finalUrl?: string }

/**
 * Reading a PDF that a server sent as a download must not also leave a copy
 * in the user's downloads. The browser's own download of the source is
 * cancelled, its file removed if it already finished, and the entry erased
 * from the list. Only downloads of that URL that started after `since` (the
 * moment the reader was asked for) are touched, never an earlier one the user
 * kept on purpose.
 */
export function cancelSourceDownload(browserApi: { downloads?: Downloads }, url: string, since: Date): void {
  const downloads = browserApi.downloads
  if (!downloads) return
  const handled = new Set<number>()
  // A second of slack for browsers that round a download's start time.
  const after = since.getTime() - 1000
  const matches = (item: DownloadItem) =>
    (item.url === url || item.finalUrl === url) && Date.parse(item.startTime) >= after
  const discard = (item: DownloadItem) => {
    if (handled.has(item.id) || !matches(item)) return
    handled.add(item.id)
    void (async () => {
      await downloads.cancel(item.id).catch(() => undefined)
      const [current] = await downloads.search({ id: item.id }).catch(() => [])
      if (current?.state === "complete" && current.exists !== false) await downloads.removeFile(item.id).catch(() => undefined)
      await downloads.erase({ id: item.id }).catch(() => undefined)
    })()
  }
  downloads.onCreated.addListener(discard)
  setTimeout(() => downloads.onCreated.removeListener(discard), WATCH_MS)
  void downloads.search({ startedAfter: new Date(after).toISOString() }).then(items => items.forEach(discard), () => undefined)
}
