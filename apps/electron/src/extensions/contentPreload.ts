// Registered on the browser session as a frame preload, so it runs in every
// frame of every tab before the page's own scripts. It asks main which
// extensions have content scripts for this frame, gives each one an
// isolated world with its own `browser`, and runs the scripts at the phase
// the manifest asked for. The page's main world never sees any of it. A
// frame that shows an extension's own page is the exception: that one gets
// the page API in its main world and nothing else.

import { contextBridge, ipcRenderer, webFrame } from "electron"
import {
  ADOPT_BRIDGE_SOURCE,
  BRIDGE_STAGING_KEY,
  PreloadApi,
  adoptBridge,
  decorateExtensionPage
} from "./preloadRuntime"
import {
  CONTENT_API_SURFACE,
  ContentFrameInit,
  ContentScriptBatch,
  EXTENSION_API_SURFACE,
  EXTENSION_IPC,
  EXTENSION_SCHEME,
  ExtensionEvent,
  INTERNAL_API
} from "./protocol"

interface ContentWorld {
  init: ContentFrameInit
  api: PreloadApi
  /** Inserted style keys, so removeCSS can find them again by code. */
  styles: Map<string, string>
}

const worlds = new Map<string, ContentWorld>()

function runScripts(world: ContentWorld, batch: ContentScriptBatch): void {
  for (const css of batch.css) insertStyle(world, css)
  if (batch.js.length === 0) return
  if (batch.world === "MAIN") {
    for (const script of batch.js) {
      void webFrame.executeJavaScript(script.code).catch(error => {
        console.error(`[${world.init.id}] main-world content script failed`, error)
      })
    }
    return
  }
  void webFrame.executeJavaScriptInIsolatedWorld(
    world.init.worldId,
    batch.js.map((script) => ({ code: script.code, url: script.url }))
  ).catch((error) => {
    console.error(`[${world.init.id}] content script failed`, error)
  })
}

function insertStyle(world: ContentWorld, css: string): void {
  if (world.styles.has(css)) return
  world.styles.set(css, webFrame.insertCSS(css, { cssOrigin: "user" }))
}

function removeStyle(world: ContentWorld, css: string): void {
  const key = world.styles.get(css)
  if (key === undefined) return
  world.styles.delete(css)
  webFrame.removeInsertedCSS(key)
}

function whenDocumentEnd(run: () => void): void {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true })
  } else {
    run()
  }
}

function whenDocumentIdle(run: () => void): void {
  if (document.readyState === "complete") {
    setTimeout(run, 0)
  } else {
    window.addEventListener("load", () => setTimeout(run, 0), { once: true })
  }
}

// The preload runs before the parser has created <html>. Browsers define
// document_start as "the root element exists, nothing else does", and
// content scripts rely on it, so wait for that one node and no more. The
// observer's microtask runs before the parser executes any page script.
function whenDocumentStart(run: () => void): void {
  if (document.documentElement) {
    run()
    return
  }
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return
    observer.disconnect()
    run()
  })
  observer.observe(document, { childList: true })
}

function schedule(world: ContentWorld, batch: ContentScriptBatch): void {
  const run = () => runScripts(world, batch)
  if (batch.runAt === "document_start") whenDocumentStart(run)
  else if (batch.runAt === "document_end") whenDocumentEnd(run)
  else whenDocumentIdle(run)
}

// Injection requests from the background page: tabs.executeScript,
// insertCSS, removeCSS. executeScript answers with its result.
function handleInjection(world: ContentWorld, message: ExtensionEvent): void {
  const [details] = message.args as [{ code?: string; url?: string; css?: string }]
  if (message.event === "insertCSS" && typeof details.css === "string") {
    insertStyle(world, details.css)
  } else if (message.event === "removeCSS" && typeof details.css === "string") {
    removeStyle(world, details.css)
  } else if (message.event === "executeScript" && typeof details.code === "string") {
    const token = message.token
    const run = webFrame.executeJavaScriptInIsolatedWorld(
      world.init.worldId,
      [{ code: details.code, url: details.url }]
    )
    if (token === undefined) return
    run.then(
      (result) => reply(world, token, [result]),
      (error) => {
        console.error(`[${world.init.id}] executeScript failed`, error)
        reply(world, token, [undefined])
      }
    )
  }
}

function reply(world: ContentWorld, token: number, result: unknown[]): void {
  ipcRenderer.send(EXTENSION_IPC.contentReply, { host: world.init.host, token, result })
}

// Firefox content scripts reach the page's own globals through
// `wrappedJSObject`; uBlock's scriptlet injector reads a sentinel there to
// confirm its <script> ran in the page. Chromium worlds have no such view,
// but the preload can read and delete main-world globals synchronously, so
// the world gets a proxy that does exactly that and nothing more.
function mainWorldAccess(): Record<string, unknown> {
  return {
    get: (name: unknown): unknown => {
      if (typeof name !== "string") return undefined
      try {
        return contextBridge.executeInMainWorld({
          func: (key: string) => (globalThis as unknown as Record<string, unknown>)[key],
          args: [name]
        })
      } catch {
        return undefined
      }
    },
    delete: (name: unknown): void => {
      if (typeof name !== "string") return
      try {
        contextBridge.executeInMainWorld({
          func: (key: string) => {
            Reflect.deleteProperty(globalThis, key)
          },
          args: [name]
        })
      } catch {
        // Not deletable; the page keeps its global.
      }
    }
  }
}

const MAIN_WORLD_STAGING_KEY = "__onceMainWorld"

const DEFINE_WRAPPED_JS_OBJECT = `(() => {
  const access = globalThis["${MAIN_WORLD_STAGING_KEY}"]
  if (!access) return
  const wrapped = new Proxy({}, {
    get: (_target, name) => (typeof name === "string" ? access.get(name) : undefined),
    has: (_target, name) => typeof name === "string" && access.get(name) !== undefined,
    deleteProperty: (_target, name) => {
      if (typeof name === "string") access.delete(name)
      return true
    }
  })
  Object.defineProperty(globalThis, "wrappedJSObject", {
    value: wrapped, writable: true, configurable: true, enumerable: false
  })
})()`

function createWorld(init: ContentFrameInit): ContentWorld {
  const ownPage = init.kind !== "content"
  const api = new PreloadApi(init, ownPage ? EXTENSION_API_SURFACE : CONTENT_API_SURFACE, {
    invoke: (namespace, method, args) =>
      ipcRenderer.invoke(EXTENSION_IPC.contentInvoke, { host: init.host, api: namespace, method, args }),
    reply: (token, result) => reply(world, token, result),
    listen: (change) => {
      ipcRenderer.sendSync(EXTENSION_IPC.contentListeners, { ...change, host: init.host })
    }
  })
  const world: ContentWorld = { init, api, styles: new Map() }
  if (ownPage) {
    // The frame is one of the extension's own pages (uBlock's element
    // picker): `browser` belongs in its main world, as in the extension's
    // other pages, and no content script runs here.
    const browser = api.build()
    decorateExtensionPage(browser)
    contextBridge.exposeInMainWorld(BRIDGE_STAGING_KEY, browser)
    contextBridge.executeInMainWorld({ func: adoptBridge })
    return world
  }
  // Chromium checks a <script> a content script inserts against the policy
  // of the world that inserted it, and falls back to the page's only when
  // the world has none of its own. Chrome gives MV2 content-script worlds
  // an empty policy, which is what this is: neither the page's CSP nor its
  // Trusted Types requirement applies to what the extension injects, as
  // in Firefox. YouTube's page forbids both, and uBlock's scriptlets, the
  // part of it that removes video ads, reach the page only this way. Set
  // before the world exists; the origin is the extension's, as in Chrome,
  // because the entry is per world and per process, not per frame.
  webFrame.setIsolatedWorldInfo(init.worldId, {
    securityOrigin: `${EXTENSION_SCHEME}://${init.host}`,
    csp: "",
    name: init.id
  })
  contextBridge.exposeInIsolatedWorld(init.worldId, BRIDGE_STAGING_KEY, api.build())
  contextBridge.exposeInIsolatedWorld(init.worldId, MAIN_WORLD_STAGING_KEY, mainWorldAccess())
  // Runs before any content script: calls into the same world are executed
  // in the order they were made.
  void webFrame.executeJavaScriptInIsolatedWorld(init.worldId, [
    { code: ADOPT_BRIDGE_SOURCE },
    { code: DEFINE_WRAPPED_JS_OBJECT }
  ])
  return world
}

const inits = ipcRenderer.sendSync(EXTENSION_IPC.contentInit) as ContentFrameInit[] | null
if (Array.isArray(inits) && inits.length > 0) {
  for (const init of inits) worlds.set(init.host, createWorld(init))
  ipcRenderer.on(EXTENSION_IPC.event, (_ipcEvent, message: ExtensionEvent) => {
    const world = message.host ? worlds.get(message.host) : undefined
    if (!world) return
    if (message.api === INTERNAL_API.content) handleInjection(world, message)
    else world.api.handleEvent(message)
  })
  for (const world of worlds.values()) {
    for (const batch of world.init.scripts) schedule(world, batch)
  }
}
