// Runs in every page of a loaded extension (background, popup, options) and
// builds the `browser` object those pages expect. Synchronous APIs answer
// here from the init payload; everything else is one IPC call to main.
// Events arrive from main; when they carry a token, the listeners' results
// go back so main can honour a blocking webRequest decision or a message
// reply.

import { contextBridge, ipcRenderer } from "electron"
import { getLocaleMessage } from "@once/core"
import {
  EXTENSION_API_SURFACE,
  EXTENSION_IPC,
  EXTENSION_SCHEME,
  ExtensionContextInit,
  ExtensionEvent,
  PRIVACY_SETTINGS
} from "./protocol"

type Listener = (...args: unknown[]) => unknown

interface Registered {
  listener: Listener
  id: number
}

function requireInit(): ExtensionContextInit {
  const init = ipcRenderer.sendSync(EXTENSION_IPC.init) as ExtensionContextInit | null
  if (!init) throw new Error("This page is not a registered extension context")
  return init
}

const init = requireInit()
const listeners = new Map<string, Registered[]>()
let nextListenerId = 1

function invoke(api: string, method: string, args: unknown[]): Promise<unknown> {
  return ipcRenderer.invoke(EXTENSION_IPC.invoke, { api, method, args })
}

function baseUrl(): string {
  return `${EXTENSION_SCHEME}://${init.host}/`
}

function getURL(path: unknown): string {
  const relative = typeof path === "string" ? path.replace(/^\/+/, "") : ""
  return `${baseUrl()}${relative}`
}

function eventObject(api: string, event: string): Record<string, unknown> {
  const key = `${api}.${event}`
  return {
    addListener(listener: Listener, filter?: unknown, extraInfoSpec?: unknown) {
      if (typeof listener !== "function") return
      const registered = listeners.get(key) ?? []
      if (registered.some((entry) => entry.listener === listener)) return
      const id = nextListenerId++
      registered.push({ listener, id })
      listeners.set(key, registered)
      const spec = api === "webRequest"
        ? { filter, extraInfoSpec: Array.isArray(extraInfoSpec) ? extraInfoSpec : [] }
        : undefined
      void invoke("__listeners", "add", [{ api, event, id, spec }])
    },
    removeListener(listener: Listener) {
      const registered = listeners.get(key)
      if (!registered) return
      const index = registered.findIndex((entry) => entry.listener === listener)
      if (index < 0) return
      const [removed] = registered.splice(index, 1)
      void invoke("__listeners", "remove", [{ api, event, id: removed.id }])
    },
    hasListener(listener: Listener) {
      return (listeners.get(key) ?? []).some((entry) => entry.listener === listener)
    },
    hasListeners() {
      return (listeners.get(key) ?? []).length > 0
    }
  }
}

// runtime.onMessage listeners answer in one of three ways: return a value or
// a promise, return true and call sendResponse later, or call sendResponse
// synchronously. All three end in one settled value.
function runMessageListener(listener: Listener, args: unknown[]): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false
    const sendResponse = (value?: unknown) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let result: unknown
    try {
      result = listener(...args, sendResponse)
    } catch (error) {
      console.error("runtime.onMessage listener failed", error)
      sendResponse(undefined)
      return
    }
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(sendResponse, (error) => {
        console.error("runtime.onMessage listener rejected", error)
        sendResponse(undefined)
      })
    } else if (result !== true && !settled) {
      sendResponse(undefined)
    }
  })
}

async function runListener(api: string, event: string, listener: Listener, args: unknown[]): Promise<unknown> {
  if (api === "runtime" && event === "onMessage") return runMessageListener(listener, args)
  try {
    return await listener(...args)
  } catch (error) {
    console.error(`${api}.${event} listener failed`, error)
    return undefined
  }
}

ipcRenderer.on(EXTENSION_IPC.event, (_ipcEvent, message: ExtensionEvent & { listeners?: number[] }) => {
  const registered = listeners.get(`${message.api}.${message.event}`) ?? []
  const selected = message.listeners
    ? registered.filter((entry) => message.listeners?.includes(entry.id))
    : registered
  const runs = selected.map((entry) =>
    runListener(message.api, message.event, entry.listener, message.args)
  )
  if (message.token === undefined) return
  const token = message.token
  void Promise.all(runs).then((result) => {
    ipcRenderer.send(EXTENSION_IPC.reply, { token, result })
  })
})

function method(api: string, name: string): Listener {
  return (...args: unknown[]) => invoke(api, name, args)
}

function namespace(api: string): Record<string, unknown> {
  const surface = EXTENSION_API_SURFACE[api]
  const object: Record<string, unknown> = {}
  for (const name of surface.methods) object[name] = method(api, name)
  for (const name of surface.events) object[name] = eventObject(api, name)
  return object
}

function assign(root: Record<string, unknown>, dotted: string, value: Record<string, unknown>): void {
  const parts = dotted.split(".")
  let target = root
  for (const part of parts.slice(0, -1)) {
    target[part] ??= {}
    target = target[part] as Record<string, unknown>
  }
  const last = parts[parts.length - 1]
  target[last] = { ...(target[last] as Record<string, unknown> | undefined), ...value }
}

/** An event nothing in main ever raises; listeners are accepted and kept. */
function inertEvent(): Record<string, unknown> {
  const held = new Set<Listener>()
  return {
    addListener: (listener: Listener) => {
      held.add(listener)
    },
    removeListener: (listener: Listener) => {
      held.delete(listener)
    },
    hasListener: (listener: Listener) => held.has(listener),
    hasListeners: () => held.size > 0
  }
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
    onChange: inertEvent()
  }
}

function privacyNamespace(): Record<string, unknown> {
  const privacy: Record<string, unknown> = {}
  for (const [group, settings] of Object.entries(PRIVACY_SETTINGS)) {
    const namespace: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(settings)) {
      namespace[name] = privacySetting(value)
    }
    privacy[group] = namespace
  }
  return privacy
}

function buildBrowser(): Record<string, unknown> {
  const browser: Record<string, unknown> = {}
  for (const api of Object.keys(EXTENSION_API_SURFACE)) assign(browser, api, namespace(api))

  const runtime = browser.runtime as Record<string, unknown>
  runtime.id = init.id
  runtime.getURL = getURL
  runtime.getManifest = () => init.manifest
  runtime.lastError = undefined
  // Ports arrive with the popup and content scripts (plan step 3).
  runtime.connect = () => {
    throw new Error("runtime.connect is not available yet")
  }

  const webRequest = browser.webRequest as Record<string, unknown>
  webRequest.ResourceType = Object.freeze({
    MAIN_FRAME: "main_frame", SUB_FRAME: "sub_frame", STYLESHEET: "stylesheet",
    SCRIPT: "script", IMAGE: "image", FONT: "font", OBJECT: "object",
    XMLHTTPREQUEST: "xmlhttprequest", PING: "ping", CSP_REPORT: "csp_report",
    MEDIA: "media", WEBSOCKET: "websocket", OTHER: "other"
  })
  webRequest.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES = 20
  const tabs = browser.tabs as Record<string, unknown>
  tabs.TAB_ID_NONE = -1
  const windows = browser.windows as Record<string, unknown>
  windows.WINDOW_ID_NONE = -1
  windows.WINDOW_ID_CURRENT = -2

  const extension = browser.extension as Record<string, unknown>
  extension.getURL = getURL
  extension.inIncognitoContext = false

  const i18n = browser.i18n as Record<string, unknown>
  i18n.getMessage = (key: unknown, substitutions?: unknown) => {
    if (typeof key !== "string") return ""
    const list = substitutions === undefined
      ? []
      : Array.isArray(substitutions) ? substitutions.map(String) : [String(substitutions)]
    return getLocaleMessage(init.messages, key, list)
  }
  i18n.getUILanguage = () => init.uiLanguage

  browser.privacy = privacyNamespace()

  return browser
}

// Only `browser`: Chromium already defines `window.chrome` in every page and
// the bridge refuses to bind over it. Firefox builds use `browser` anyway.
contextBridge.exposeInMainWorld("browser", buildBrowser())
