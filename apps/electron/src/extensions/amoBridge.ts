// "Add to Firefox" on addons.mozilla.org, made to add to Once. AMO decides
// what its install button does from two things: the browser its
// server-rendered state names, and whether `navigator.mozAddonManager`
// exists. Both are supplied here from the tab's frame preload: the state
// script is rewritten to say Firefox before AMO's bundle boots, and the
// add-on manager is a small shim over IPC to the extension manager. AMO
// then renders its own button and its own installed/enabled states; the
// only cosmetic change is the label and a Once badge. The request header
// stays honest, so this reaches nothing but the one page.

import { contextBridge, ipcRenderer, webFrame } from "electron"
import { ELECTRON_IPC } from "@once/platform-electron/bridge"

export const AMO_ORIGIN = "https://addons.mozilla.org"
const AMO_STAGING_KEY = "__onceAddonManager"

/** What the shim may ask main; the page URL identifies what to install. */
export interface AmoPageBridge {
  getAddon(id: string): Promise<AmoAddonState | null>
  install(): Promise<AmoInstallOutcome>
  uninstall(id: string): Promise<boolean>
  setEnabled(id: string, enabled: boolean): Promise<void>
  onChanged(handler: () => void): void
}

export interface AmoAddonState {
  id: string
  version: string
  isEnabled: boolean
  isActive: boolean
  canUninstall: boolean
}

export interface AmoInstallOutcome {
  status: "installed" | "cancelled" | "failed"
  error?: string
}

/**
 * Runs in the page's main world before any of AMO's scripts, from its own
 * source text: it must not reach anything outside itself.
 */
function amoShim(): void {
  const scope = globalThis as unknown as Record<string, unknown>
  const bridge = scope.__onceAddonManager as AmoPageBridge | undefined
  if (!bridge) return
  delete scope.__onceAddonManager

  // AMO's client trusts the user agent its server saw. Both the raw string
  // and the parsed browser live in the serialized store; patched once the
  // parser has moved past the script, before the bundle reads it.
  const FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0"
  const observer = new MutationObserver(() => {
    const script = document.getElementById("redux-store-state")
    if (!script || !script.nextSibling) return
    observer.disconnect()
    script.textContent = script.textContent
      .replace(/"userAgent":"[^"]*"/, () => `"userAgent":${JSON.stringify(FIREFOX_UA)}`)
      .replace(/"userAgentInfo":\{"browser":\{[^}]*\}/, '"userAgentInfo":{"browser":{"name":"Firefox","version":"143.0","major":"143"}')
  })
  observer.observe(document, { childList: true, subtree: true })

  type Listener = (event: Record<string, unknown>) => void
  const listeners = new Map<string, Listener[]>()
  const known = new Map<string, AmoAddonState | null>()
  const emit = (name: string, id: string, extra: Record<string, unknown> = {}) => {
    const event = { type: name, id, addon: { id }, needsRestart: false, ...extra }
    for (const listener of listeners.get(name) ?? []) listener(event)
  }
  const addon = (state: AmoAddonState) => ({
    id: state.id,
    type: "extension",
    version: state.version,
    isActive: state.isActive,
    isEnabled: state.isEnabled,
    canUninstall: state.canUninstall,
    uninstall: () => bridge.uninstall(state.id),
    setEnabled: (enabled: boolean) => bridge.setEnabled(state.id, enabled)
  })
  const lookup = async (id: string) => {
    const state = await bridge.getAddon(id)
    known.set(id, state)
    return state
  }
  // Once changed something: tell AMO what happened to the add-ons this page asked about.
  bridge.onChanged(async () => {
    for (const [id, previous] of [...known]) {
      const state = await lookup(id)
      if (!previous && state) emit("onInstalled", id)
      else if (previous && !state) emit("onUninstalled", id)
      else if (previous && state && previous.isEnabled !== state.isEnabled) emit(state.isEnabled ? "onEnabled" : "onDisabled", id)
    }
  })

  const manager = {
    permissionPromptsEnabled: true,
    abuseReportPanelEnabled: false,
    addEventListener: (name: string, listener: Listener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
    },
    removeEventListener: (name: string, listener: Listener) => {
      listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== listener))
    },
    getAddonByID: async (id: string) => {
      const state = await lookup(id)
      return state ? addon(state) : null
    },
    createInstall: async () => {
      const own = new Map<string, Listener[]>()
      const fire = (name: string, extra: Record<string, unknown> = {}) => {
        const event = { type: name, ...extra }
        for (const listener of own.get(name) ?? []) listener(event)
      }
      return {
        addEventListener: (name: string, listener: Listener) => {
          own.set(name, [...(own.get(name) ?? []), listener])
        },
        removeEventListener: () => undefined,
        cancel: async () => undefined,
        // The review happens in Once's own dialog; AMO shows its download
        // spinner meanwhile and learns the outcome as the events Firefox
        // would send.
        install: async () => {
          fire("onDownloadStarted", { progress: 0, maxProgress: 1 })
          const outcome = await bridge.install().catch((error) => ({ status: "failed" as const, error: String(error) }))
          if (outcome.status !== "installed") {
            fire(outcome.status === "cancelled" ? "onInstallCancelled" : "onInstallFailed", { error: outcome.error })
            if (outcome.status === "failed") throw new Error(outcome.error ?? "Install failed")
            return
          }
          fire("onDownloadProgress", { progress: 1, maxProgress: 1 })
          fire("onDownloadEnded")
          fire("onInstallStarted")
          fire("onInstallEnded")
        }
      }
    }
  }
  Object.defineProperty(navigator, "mozAddonManager", { value: manager, configurable: true })

  // AMO's label is its own; only the words change here (the badge is a
  // style the preload inserts, past the page's CSP).
  const relabel = () => {
    for (const button of document.querySelectorAll(".AMInstallButton-button")) {
      for (const node of button.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent === "Add to Firefox") node.textContent = "Add to Once"
      }
    }
  }
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(relabel).observe(document.body, { childList: true, subtree: true, characterData: true })
    relabel()
  })
}

// The app icon, inlined by the build (webpack.main.config.js); absent when
// the module is loaded outside the bundle, as in unit tests.
declare const __ONCE_APP_ICON_SVG__: string | undefined

// The Once icon in front of the install label; user-origin, so the page's
// Content Security Policy does not apply to it.
function badgeCss(): string {
  const icon = typeof __ONCE_APP_ICON_SVG__ === "string" ? __ONCE_APP_ICON_SVG__ : ""
  if (!icon) return ""
  return [
    ".AMInstallButton-button{display:inline-flex!important;align-items:center;justify-content:center;gap:10px}",
    ".AMInstallButton-button:not(.AMInstallButton-button--uninstall)::before{content:\"\";width:22px;height:22px;flex:none;",
    `background:url("data:image/svg+xml;utf8,${encodeURIComponent(icon)}") center/contain no-repeat}`
  ].join("")
}

/** Called from the tab frame preload; does nothing outside AMO's top frame. */
export function installAmoBridge(): void {
  if (!process.isMainFrame || location.origin !== AMO_ORIGIN) return
  const bridge: AmoPageBridge = {
    getAddon: (id) => ipcRenderer.invoke(ELECTRON_IPC.amoManage, "addon", id),
    install: () => ipcRenderer.invoke(ELECTRON_IPC.amoManage, "install"),
    uninstall: (id) => ipcRenderer.invoke(ELECTRON_IPC.amoManage, "uninstall", id),
    setEnabled: (id, enabled) => ipcRenderer.invoke(ELECTRON_IPC.amoManage, "enabled", id, enabled),
    onChanged: (handler) => {
      ipcRenderer.on(ELECTRON_IPC.amoChanged, () => handler())
    }
  }
  contextBridge.exposeInMainWorld(AMO_STAGING_KEY, bridge)
  contextBridge.executeInMainWorld({ func: amoShim })
  const badge = badgeCss()
  if (badge) webFrame.insertCSS(badge, { cssOrigin: "user" })
}
