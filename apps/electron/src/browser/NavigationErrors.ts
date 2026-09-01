import { ErrorPageState, TabEntry, WindowEntry } from "./BrowserState"
import { errorPageTheme, storeErrorPage } from "./ErrorPageProtocol"

interface NavigationErrorHost {
  ownerFor(entry: TabEntry): WindowEntry | undefined
  notify(entry: TabEntry): void
}

export class NavigationErrors {
  constructor(private readonly host: NavigationErrorHost) {}

  load(entry: TabEntry, url: string): void {
    entry.displayedUrl = url
    entry.loadError = null
    entry.loadErrorRetryable = false
    entry.errorPageUrl = null
    this.host.notify(entry)
    entry.view.webContents.loadURL(url).catch((error) => {
      // A tab replaced while loading (an extension page taking its place)
      // has no webContents left by the time the load reports back.
      const contents = entry.view.webContents
      if (isAborted(error) || !contents || contents.isDestroyed()) return
      if (!sameUrl(entry.displayedUrl, url) || entry.loadError) return
      this.handleFailure(entry, url, error?.message || String(error), true)
    })
  }

  handleFailure(entry: TabEntry, url: string, error: string, retryable = true): void {
    entry.displayedUrl = url
    entry.loadError = error
    entry.loadErrorRetryable = retryable
    entry.loading = false
    entry.title = "Failed to load"
    this.host.notify(entry)
    this.show(entry, url, error, retryable)
  }

  show(entry: TabEntry, url: string, error: string, retryable: boolean): void {
    if (entry.view.webContents.isDestroyed()) return
    const background = this.host.ownerFor(entry)?.backgroundColor || "#FFFFFF"
    const pageUrl = storeErrorPage(url, error, background, retryable)
    entry.errorPageUrl = pageUrl
    entry.errorPages.set(pageUrl, { url, error, retryable })
    entry.view.webContents.loadURL(pageUrl).catch((pageError) => {
      console.error("Failed to render the browser error page", pageError)
    })
  }

  state(entry: TabEntry, url: string): ErrorPageState | undefined {
    return entry.errorPages.get(url)
  }

  backTargetIndex(entry: TabEntry): number {
    const history = entry.view.webContents.navigationHistory
    let targetIndex = history.getActiveIndex() - 1
    const currentError = this.state(
      entry,
      history.getEntryAtIndex(history.getActiveIndex())?.url || ""
    )
    if (!currentError) return targetIndex
    if (targetIndex >= 0 && sameUrl(history.getEntryAtIndex(targetIndex).url, currentError.url)) {
      targetIndex -= 1
    }
    while (targetIndex >= 0) {
      const errorState = this.state(entry, history.getEntryAtIndex(targetIndex).url)
      if (!errorState) break
      targetIndex -= 1
      if (targetIndex >= 0 && sameUrl(history.getEntryAtIndex(targetIndex).url, errorState.url)) {
        targetIndex -= 1
      }
    }
    return targetIndex
  }

  collapseFailedEntry(entry: TabEntry): void {
    const history = entry.view.webContents.navigationHistory
    const activeIndex = history.getActiveIndex()
    const current = this.state(
      entry,
      history.getEntryAtIndex(activeIndex)?.url || ""
    )
    if (!current || activeIndex < 1) return
    if (sameUrl(history.getEntryAtIndex(activeIndex - 1)?.url || "", current.url)) {
      history.removeEntryAtIndex(activeIndex - 1)
    }
  }

  restore(entry: TabEntry, errorPageUrl: string, state: ErrorPageState): void {
    entry.displayedUrl = state.url
    entry.loadError = state.error
    entry.loadErrorRetryable = state.retryable
    entry.errorPageUrl = errorPageUrl
    entry.title = "Failed to load"
    this.host.notify(entry)
  }

  applyTheme(entry: TabEntry, background: string): void {
    const contents = entry.view.webContents
    if (contents.isDestroyed() || !this.state(entry, contents.getURL())) return
    const theme = errorPageTheme(background)
    const script = `document.documentElement.dataset.theme = ${JSON.stringify(theme.name)}; document.documentElement.style.setProperty("--page-bg", ${JSON.stringify(theme.background)})`
    void contents.executeJavaScript(script).catch(() => {
      // A navigation away from the error page can race this theme update.
    })
  }
}

/**
 * An aborted load is what every replaced navigation looks like — switching to
 * reader mode while a page is still loading, most visibly. Electron names the
 * rejection after the Chromium error description, which arrives empty for some
 * aborts, so the numeric errno decides.
 */
function isAborted(error: unknown): boolean {
  const failure = error as { code?: unknown; errno?: unknown } | null
  return failure?.code === "ERR_ABORTED" || failure?.errno === -3
}

export function sameUrl(left: string, right: string): boolean {
  if (left === right) return true
  try {
    return new URL(left).toString() === new URL(right).toString()
  } catch {
    return false
  }
}
