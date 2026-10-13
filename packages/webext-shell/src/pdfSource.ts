import type browser from "webextension-polyfill"
import { isDownloadByHeaders, isPdfByHeaders } from "@once/app/documents"

/** Decides from a response's headers whether a source is a PDF; a generic download type defers to the `.pdf` name. */
export function pdfResponse(url: string, contentType: string | null | undefined, disposition?: string | null): boolean {
  return isPdfByHeaders(url, contentType, disposition)
}

export interface PdfSourceWatch {
  /**
   * Whether the tab's navigation answered with a PDF: resolved as soon as its
   * main-frame headers arrive, or once the navigation completes without any
   * having been seen (a cached document), when a credential-less probe
   * decides. `loaded` stands in for navigation completion where the browser
   * reports none; a tab's status alone can read "complete" before it has
   * even started, so it is only the last resort.
   */
  isPdf(tabId: number, loaded: Promise<void>): Promise<boolean>
  /** The URL the tab's PDF arrived from as a download, which the browser saves and closes the tab it opened for. */
  downloadUrl(tabId: number): string | undefined
  stop(): void
}

type HeadersEvent = typeof browser.webRequest.onHeadersReceived
type HeadersDetails = Parameters<Parameters<HeadersEvent["addListener"]>[0]>[0]
type CompletedEvent = typeof browser.webNavigation.onCompleted
type CompletedDetails = Parameters<Parameters<CompletedEvent["addListener"]>[0]>[0]

export interface PdfSources {
  /** Watches the tabs about to open for `url`; only events from now on count. */
  watch(url: string): PdfSourceWatch
  stop(): void
}

interface WatchListeners {
  headers(details: HeadersDetails): void
  completed(details: CompletedDetails): void
}

/**
 * PDF viewers forbid content-script injection, so a PDF source is shown in the
 * extension's own reader page. The navigation the user asked for is the probe:
 * the new tab's main-frame response headers say what it is, without an extra
 * request to the site before the tab exists.
 *
 * The browser listeners are registered once, when the background starts, not
 * per request: Firefox activates a new webRequest listener asynchronously, and
 * a tab opened right after `addListener` could answer before it was live,
 * leaving only the fallback probe.
 */
export function trackPdfSources(browserApi: Pick<typeof browser, "webRequest" | "webNavigation">): PdfSources {
  const watches = new Set<WatchListeners>()
  const headers: HeadersEvent | undefined = browserApi.webRequest?.onHeadersReceived
  const navigation: CompletedEvent | undefined = browserApi.webNavigation?.onCompleted
  const onHeaders = (details: HeadersDetails) => { for (const watch of watches) watch.headers(details) }
  const onCompleted = (details: CompletedDetails) => { for (const watch of watches) watch.completed(details) }
  headers?.addListener(onHeaders, { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] }, ["responseHeaders"])
  navigation?.addListener(onCompleted, { url: [{ schemes: ["http", "https"] }] })
  return {
    watch: url => watchPdfSource(url, Boolean(navigation), watches),
    stop() {
      headers?.removeListener(onHeaders)
      navigation?.removeListener(onCompleted)
      watches.clear()
    }
  }
}

function watchPdfSource(url: string, reportsCompletion: boolean, watches: Set<WatchListeners>): PdfSourceWatch {
  const seen = new Map<number, boolean>()
  const downloads = new Map<number, string>()
  const completed = new Set<number>()
  const waiting = new Map<number, (pdf: boolean) => void>()
  const onHeaders = (details: HeadersDetails) => {
    if (details.statusCode >= 300 && details.statusCode < 400) return
    const header = (name: string) => details.responseHeaders?.find(candidate => candidate.name.toLowerCase() === name)?.value
    const pdf = pdfResponse(details.url, header("content-type"), header("content-disposition"))
    seen.set(details.tabId, pdf)
    if (pdf && isDownloadByHeaders(header("content-type"), header("content-disposition"))) downloads.set(details.tabId, details.url)
    waiting.get(details.tabId)?.(pdf)
  }
  const onCompleted = (details: CompletedDetails) => {
    if (details.frameId !== 0) return
    completed.add(details.tabId)
    const resolve = waiting.get(details.tabId)
    if (resolve && !seen.has(details.tabId)) void isPdfSource(url).then(resolve)
  }
  const listeners: WatchListeners = { headers: onHeaders, completed: onCompleted }
  watches.add(listeners)
  return {
    isPdf(tabId, loaded) {
      const known = seen.get(tabId)
      if (known !== undefined) return Promise.resolve(known)
      if (completed.has(tabId)) return isPdfSource(url)
      return new Promise(resolve => {
        waiting.set(tabId, resolve)
        if (!reportsCompletion) loaded.then(() => resolve(seen.get(tabId) ?? isPdfSource(url)), () => resolve(false))
      })
    },
    downloadUrl: tabId => downloads.get(tabId),
    stop() {
      watches.delete(listeners)
      waiting.clear()
    }
  }
}

/** The fallback probe, for a navigation whose headers the browser did not report. */
export async function isPdfSource(url: string): Promise<boolean> {
  try {
    let response = await fetch(url, { method: "HEAD", credentials: "omit", signal: AbortSignal.timeout(5000) })
    if (response.status === 405 || response.status === 501 || !response.headers.get("content-type")) {
      response = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(5000) })
    }
    const type = response.headers.get("content-type")
    const disposition = response.headers.get("content-disposition")
    await response.body?.cancel()
    return pdfResponse(response.url || url, type, disposition)
  } catch { return /\.pdf$/i.test(new URL(url).pathname) }
}
