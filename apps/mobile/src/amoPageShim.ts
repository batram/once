// "Add to Firefox" on addons.mozilla.org, made to add to Once on iOS. The
// surface plugin injects this bundle as a document-start user script in the
// page's own world; it stages the bridge the shared `amoShim` expects under
// `AMO_STAGING_KEY` and runs the shim, which rewrites AMO's server state to
// name Firefox and defines `navigator.mozAddonManager` over the bridge. The
// bridge's calls go to the native `onceAmo` reply handler (AmoInstallBridge.swift),
// which answers only this origin's top frame; the native review sheet still
// confirms every install.

import { AMO_ORIGIN, AMO_STAGING_KEY, type AmoPageBridge, amoShim } from "@once/webext-runtime/amo"

/** How the page reaches the native handler: a promise-returning post. */
export type AmoPagePost = (body: Record<string, unknown>) => Promise<unknown>

/** The global the native side calls when an extension changed. */
export const AMO_CHANGED_KEY = "__onceAmoChanged"

export function createAmoPageBridge(scope: Record<string, unknown>, post: AmoPagePost): AmoPageBridge {
  return {
    getAddon: (id) => post({ method: "addon", id }) as ReturnType<AmoPageBridge["getAddon"]>,
    install: () => post({ method: "install" }) as ReturnType<AmoPageBridge["install"]>,
    uninstall: (id) => post({ method: "uninstall", id }) as ReturnType<AmoPageBridge["uninstall"]>,
    setEnabled: (id, enabled) => post({ method: "enabled", id, enabled }).then(() => undefined),
    onChanged: (handler) => { scope[AMO_CHANGED_KEY] = handler }
  }
}

interface WebKitMessageHandlers {
  webkit?: { messageHandlers?: Record<string, { postMessage(body: unknown): Promise<unknown> }> }
}

/** Stages the bridge and runs the shim; a no-op anywhere but AMO's top frame. */
export function installAmoPageShim(scope: Window & WebKitMessageHandlers = window): boolean {
  if (scope.location.origin !== AMO_ORIGIN || scope !== scope.top) return false
  const handler = scope.webkit?.messageHandlers?.onceAmo
  if (!handler) return false
  const globals = scope as unknown as Record<string, unknown>
  globals[AMO_STAGING_KEY] = createAmoPageBridge(globals, (body) => handler.postMessage(body))
  amoShim()
  return true
}

if (typeof window !== "undefined") installAmoPageShim()
