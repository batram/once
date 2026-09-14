// Runs in every frame of a loaded extension's pages (background, popup,
// options, and iframes showing the extension's own pages) and builds the
// `browser` object those pages expect. Synchronous APIs answer here from the
// init payload; everything else is one IPC call to main.

import { contextBridge, ipcRenderer } from "electron"
import { BRIDGE_STAGING_KEY, PreloadApi, adoptBridge, decorateExtensionPage } from "./preloadRuntime"
import {
  EXTENSION_API_SURFACE,
  EXTENSION_IPC,
  ExtensionContextInit,
  ExtensionEvent,
  unwrapInvoke
} from "./protocol"

// An iframe that shows something other than this extension's own pages gets
// no API and no complaint, and neither does the initial blank document a
// view carries before its first load; a top-level page with no context is a
// bug.
function requireInit(): ExtensionContextInit | null {
  const init = ipcRenderer.sendSync(EXTENSION_IPC.init) as ExtensionContextInit | null
  if (!init && process.isMainFrame && window.location.href !== "about:blank") {
    throw new Error("This page is not a registered extension context")
  }
  return init
}

function expose(init: ExtensionContextInit): void {
  const api = new PreloadApi(init, EXTENSION_API_SURFACE, {
    invoke: (namespace, method, args) =>
      ipcRenderer.invoke(EXTENSION_IPC.invoke, { api: namespace, method, args }).then(unwrapInvoke),
    reply: (token, result) => ipcRenderer.send(EXTENSION_IPC.reply, { token, result }),
    listen: (change) => {
      ipcRenderer.sendSync(EXTENSION_IPC.listeners, change)
    }
  })
  ipcRenderer.on(EXTENSION_IPC.event, (_ipcEvent, message: ExtensionEvent) => api.handleEvent(message))

  const browser = api.build()
  decorateExtensionPage(browser)

  // Only `browser`: Chromium already defines `window.chrome` in every page and
  // the bridge refuses to bind over it. Firefox builds use `browser` anyway.
  // Staged under a private key, then adopted as an extensible copy in the page.
  contextBridge.exposeInMainWorld(BRIDGE_STAGING_KEY, browser)
  contextBridge.executeInMainWorld({ func: adoptBridge })
}

/**
 * A popup is sized to its content, as Firefox does. Chromium's preferred
 * size is the viewport whenever the root box fills it (uBlock's flex html),
 * so it can never shrink the view; the body box plus its margins is what
 * the page actually laid out. Reported on every change so late-arriving
 * panels grow the popup.
 */
function reportPopupSize(): void {
  const send = (): void => {
    const body = document.body
    if (!body) return
    const rect = body.getBoundingClientRect()
    const style = getComputedStyle(body)
    const margin = (value: string): number => Number.parseFloat(value) || 0
    ipcRenderer.send(EXTENSION_IPC.popupSize, {
      width: Math.ceil(Math.max(rect.width, body.scrollWidth) + margin(style.marginLeft) + margin(style.marginRight)),
      height: Math.ceil(Math.max(rect.height, body.scrollHeight) + margin(style.marginTop) + margin(style.marginBottom))
    })
  }
  const observe = (): void => {
    if (!document.body) return
    new ResizeObserver(send).observe(document.body)
    send()
  }
  if (document.body) observe()
  else document.addEventListener("DOMContentLoaded", observe, { once: true })
}

const init = requireInit()
if (init) expose(init)
if (init?.kind === "popup" && process.isMainFrame) reportPopupSize()
