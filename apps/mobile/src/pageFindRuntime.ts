import { createFindEngine, FindEngine } from "./readerFind"

/**
 * Find in page for the native iOS browser surface. The WKWebView has no
 * finder with a match count, so the plugin evaluates this bundle in the page
 * once and then calls `__onceFind` for every step (see InAppBrowserSurfacePlugin.swift).
 * The engine is the reader frame's; only the transport differs.
 */
declare global {
  interface Window {
    __onceFind?: FindEngine
  }
}

window.__onceFind ??= createFindEngine(window)
