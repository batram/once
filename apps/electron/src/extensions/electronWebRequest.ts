// The browser session's webRequest hooks, fed into the shared router: one
// listener per event (all Electron allows), Electron's request records turned
// into the router's input, its decisions turned back into Electron's shapes.

import { Session, WebFrameMain } from "electron"
import {
  FrameFacts,
  NO_FRAME,
  WebRequestDetailsInput,
  WebRequestRouter,
  headersFromWebExt
} from "@once/webext-runtime"

interface ElectronRequestDetails {
  id: number
  url: string
  method: string
  resourceType: string
  referrer: string
  timestamp: number
  webContentsId?: number
  frame?: WebFrameMain | null
}

export function frameFacts(frame: WebFrameMain | null | undefined): FrameFacts {
  if (!frame) return NO_FRAME
  try {
    const parent = frame.parent
    const frameId = parent === null ? 0 : frame.frameTreeNodeId
    const parentFrameId = parent === null
      ? -1
      : parent.parent === null ? 0 : parent.frameTreeNodeId
    return {
      frameId,
      parentFrameId,
      documentUrl: frame.url || null,
      topUrl: frame.top?.url || null
    }
  } catch {
    // The frame was destroyed between the request and this lookup.
    return NO_FRAME
  }
}

/**
 * Registers the router on a session's webRequest events for every URL.
 * `tabIdFor` names the extension tab id of a webContents, or -1 when the
 * request has no tracked tab.
 */
export function installWebRequestRouter(
  session: Session,
  router: WebRequestRouter,
  tabIdFor: (webContentsId: number | undefined) => number
): void {
  const base = (details: ElectronRequestDetails): WebRequestDetailsInput => ({
    id: details.id,
    url: details.url,
    method: details.method,
    resourceType: details.resourceType,
    referrer: details.referrer,
    timestamp: details.timestamp,
    tabId: tabIdFor(details.webContentsId),
    frame: frameFacts(details.frame)
  })
  const filter = { urls: ["<all_urls>"] }
  session.webRequest.onBeforeRequest(filter, (details, callback) => {
    void router.beforeRequest(base(details)).then((decision) => {
      if (decision.cancel) callback({ cancel: true })
      else if (decision.redirectUrl) callback({ redirectURL: decision.redirectUrl })
      else callback({})
    })
  })
  session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    void router.beforeSendHeaders({ ...base(details), requestHeaders: details.requestHeaders }).then((decision) => {
      if (decision.cancel) callback({ cancel: true })
      else if (decision.requestHeaders) callback({ requestHeaders: headersFromWebExt(decision.requestHeaders) })
      else callback({})
    })
  })
  session.webRequest.onHeadersReceived(filter, (details, callback) => {
    void router.headersReceived({
      ...base(details),
      responseHeaders: details.responseHeaders ?? {},
      statusLine: details.statusLine,
      statusCode: details.statusCode
    }).then((decision) => {
      if (decision.cancel) callback({ cancel: true })
      else if (decision.responseHeaders) callback({ responseHeaders: headersFromWebExt(decision.responseHeaders) })
      else callback({})
    })
  })
  session.webRequest.onSendHeaders(filter, (details) => {
    router.sendHeaders({ ...base(details), requestHeaders: details.requestHeaders })
  })
  session.webRequest.onResponseStarted(filter, (details) => {
    router.responseStarted({
      ...base(details),
      responseHeaders: details.responseHeaders ?? {},
      statusLine: details.statusLine,
      statusCode: details.statusCode,
      fromCache: details.fromCache
    })
  })
  session.webRequest.onBeforeRedirect(filter, (details) => {
    router.beforeRedirect({
      ...base(details),
      responseHeaders: details.responseHeaders ?? {},
      statusLine: details.statusLine,
      statusCode: details.statusCode,
      redirectUrl: details.redirectURL,
      fromCache: details.fromCache
    })
  })
  session.webRequest.onCompleted(filter, (details) => {
    router.completed({ ...base(details), statusLine: details.statusLine, statusCode: details.statusCode })
  })
  session.webRequest.onErrorOccurred(filter, (details) => {
    router.errorOccurred({ ...base(details), error: details.error })
  })
}
