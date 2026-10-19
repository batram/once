// "Add to Firefox" on addons.mozilla.org, made to add to Once. AMO decides
// what its install button does from two things: the browser its
// server-rendered state names, and whether `navigator.mozAddonManager`
// exists. Both are supplied from the tab's frame preload: the shared
// `amoShim` rewrites the state script to say Firefox before AMO's bundle
// boots and defines an add-on manager over this bridge, a small shim over
// IPC to the extension manager. AMO then renders its own button and its own
// installed/enabled states; the only cosmetic change is the label and a Once
// badge. The request header stays honest, so this reaches nothing but the
// one page.

import { contextBridge, ipcRenderer, webFrame } from "electron"
import { ELECTRON_IPC } from "@once/platform-electron/bridge"
import { AMO_ORIGIN, AMO_STAGING_KEY, AmoPageBridge, amoShim } from "@once/webext-runtime/preload"

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
