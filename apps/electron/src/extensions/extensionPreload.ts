// Runs in every page of a loaded extension (background, popup, options) and
// builds the `browser` object those pages expect. Synchronous APIs answer
// here from the init payload; everything else is one IPC call to main.

import { contextBridge, ipcRenderer } from "electron"
import { BRIDGE_STAGING_KEY, PreloadApi, adoptBridge, localEvent } from "./preloadRuntime"
import {
  EXTENSION_API_SURFACE,
  EXTENSION_IPC,
  ExtensionContextInit,
  ExtensionEvent,
  PRIVACY_SETTINGS
} from "./protocol"

function requireInit(): ExtensionContextInit {
  const init = ipcRenderer.sendSync(EXTENSION_IPC.init) as ExtensionContextInit | null
  if (!init) throw new Error("This page is not a registered extension context")
  return init
}

// A setting the extension may "control": the value is remembered for the
// page's lifetime and read back, but nothing in the browser changes. uBlock
// sets a few of these at startup and treats a rejection as an error.
function privacySetting(initial: unknown): Record<string, unknown> {
  let value = initial
  return {
    get: async () => ({ value, levelOfControl: "controllable_by_this_extension" }),
    set: async (details: unknown) => {
      const record = details as { value?: unknown } | null
      if (record && "value" in record) value = record.value
    },
    clear: async () => {
      value = initial
    },
    onChange: localEvent().object
  }
}

function privacyNamespace(): Record<string, unknown> {
  const privacy: Record<string, unknown> = {}
  for (const [group, settings] of Object.entries(PRIVACY_SETTINGS)) {
    const namespace: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(settings)) namespace[name] = privacySetting(value)
    privacy[group] = namespace
  }
  return privacy
}

const init = requireInit()
const api = new PreloadApi(init, EXTENSION_API_SURFACE, {
  invoke: (namespace, method, args) =>
    ipcRenderer.invoke(EXTENSION_IPC.invoke, { api: namespace, method, args }),
  reply: (token, result) => ipcRenderer.send(EXTENSION_IPC.reply, { token, result })
})
ipcRenderer.on(EXTENSION_IPC.event, (_ipcEvent, message: ExtensionEvent) => api.handleEvent(message))

const browser = api.build()
const webRequest = browser.webRequest as Record<string, unknown>
webRequest.ResourceType = Object.freeze({
  MAIN_FRAME: "main_frame", SUB_FRAME: "sub_frame", STYLESHEET: "stylesheet",
  SCRIPT: "script", IMAGE: "image", FONT: "font", OBJECT: "object",
  XMLHTTPREQUEST: "xmlhttprequest", PING: "ping", CSP_REPORT: "csp_report",
  MEDIA: "media", WEBSOCKET: "websocket", OTHER: "other"
})
webRequest.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES = 20
;(browser.tabs as Record<string, unknown>).TAB_ID_NONE = -1
const windows = browser.windows as Record<string, unknown>
windows.WINDOW_ID_NONE = -1
windows.WINDOW_ID_CURRENT = -2
browser.privacy = privacyNamespace()

// Only `browser`: Chromium already defines `window.chrome` in every page and
// the bridge refuses to bind over it. Firefox builds use `browser` anyway.
// Staged under a private key, then adopted as an extensible copy in the page.
contextBridge.exposeInMainWorld(BRIDGE_STAGING_KEY, browser)
contextBridge.executeInMainWorld({ func: adoptBridge })
