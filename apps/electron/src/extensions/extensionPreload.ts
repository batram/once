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
  ExtensionEvent
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
      ipcRenderer.invoke(EXTENSION_IPC.invoke, { api: namespace, method, args }),
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

const init = requireInit()
if (init) expose(init)
