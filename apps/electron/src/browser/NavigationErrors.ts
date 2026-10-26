import { ErrorPageState, TabEntry, WindowEntry } from "./BrowserState"
import { errorPageTheme, storeErrorPage } from "./ErrorPageProtocol"
import { shellBackground } from "./themeBackground"

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
      if (isUnfinished(error) && sameUrl(contents.getURL(), url)) return
      this.handleFailure(entry, url, failureText(error), true)
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
    const background = this.host.ownerFor(entry)?.backgroundColor || shellBackground()
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

/**
 * Electron rejects a load that stopped without finishing or failing. When the
 * requested page did commit, it is on screen: a video or audio file opened on
 * its own is Chromium's media document, which never finishes loading because
 * its player takes the response over. One that never committed (a download, a
 * 204) left the previous page in place, which TabEvents shows again.
 */
function isUnfinished(error: unknown): boolean {
  const failure = error as { code?: unknown; errno?: unknown } | null
  return failure?.code === "ERR_FAILED" || failure?.errno === -2
}

/**
 * The same "ERR_NAME (-code)" a failed load reports through did-fail-load;
 * Electron's rejection adds "loading '<url>'", which the error page already
 * shows on its own.
 */
function failureText(error: unknown): string {
  const failure = error as { code?: unknown; errno?: unknown; message?: unknown } | null
  if (typeof failure?.code === "string" && failure.code && typeof failure.errno === "number") {
    return `${failure.code} (${failure.errno})`
  }
  return typeof failure?.message === "string" && failure.message ? failure.message : String(error)
}

export function sameUrl(left: string, right: string): boolean {
  if (left === right) return true
  try {
    return new URL(left).toString() === new URL(right).toString()
  } catch {
    return false
  }
}
