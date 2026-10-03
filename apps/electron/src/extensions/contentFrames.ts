// Which extension worlds a tab frame gets: the manifest and registered
// content scripts that match it when its document starts, or an empty world
// created on demand when an injection aims at a frame none of them reached.

import { app, WebContents, WebFrameMain } from "electron"
import type { ExtensionHost } from "./ExtensionHost"
import { creatorUrl, frameContextId } from "./ExtensionContexts"
import { isWebAccessible } from "./ExtensionProtocol"
import { extensionUrl, parseExtensionUrl } from "./ExtensionScheme"
import { canInjectFrame } from "./apiTargets"
import { ContentScript, contentScriptsFor } from "./contentScripts"
import { frameIdsOf } from "./frameIds"
import { ContentFrameInit, ContentScriptBatch, EXTENSION_IPC, INTERNAL_API } from "./protocol"

// Chromium also creates internal viewer/plugin frames. In particular a blank
// plugin frame must not inherit the outer URL via match_about_blank.
function insidePdfViewer(frame: WebFrameMain): boolean {
  for (let ancestor: WebFrameMain | null = frame; ancestor; ancestor = ancestor.parent) {
    if (ancestor.url.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/")) return true
  }
  return false
}

/** Content scripts grouped by phase, in registration order, as code. */
function batches(host: ExtensionHost, scripts: ContentScript[]): ContentScriptBatch[] {
  const byPhase = new Map<string, ContentScriptBatch>()
  for (const { spec, inlineJs, inlineCss } of scripts) {
    const key = `${spec.runAt}:${spec.world ?? "ISOLATED"}`
    let batch = byPhase.get(key)
    if (!batch) {
      batch = { runAt: spec.runAt, world: spec.world, js: [], css: [] }
      byPhase.set(key, batch)
    }
    for (const file of spec.css) batch.css.push(host.files.read(file))
    batch.css.push(...inlineCss)
    for (const file of spec.js) {
      batch.js.push({ url: extensionUrl(host.extension.host, file), code: host.files.read(file) })
    }
    for (const code of inlineJs) {
      batch.js.push({ url: extensionUrl(host.extension.host, "_registered_content_script.js"), code })
    }
  }
  return [...byPhase.values()]
}

function frameInit(
  host: ExtensionHost,
  kind: ContentFrameInit["kind"],
  scripts: ContentScriptBatch[] = []
): ContentFrameInit {
  return {
    id: host.extension.id,
    host: host.extension.host,
    kind,
    manifest: host.extension.rawManifest,
    messages: host.extension.messages,
    uiLanguage: app.getLocale(),
    worldId: host.worldId,
    scripts
  }
}

export class ContentFrames {
  /** Frames whose current document is a PDF; only their preload knows the MIME type. */
  private readonly pdfFrames = new WeakSet<WebFrameMain>()

  /**
   * A frame of a tab is starting: every extension with matching content
   * scripts gets a context in it and its scripts as code. A frame showing
   * one of an extension's web-accessible pages is instead that extension's
   * page inside the tab (uBlock's element picker): it gets the page API,
   * tied to the tab, and no content scripts, as in Firefox.
   */
  init(
    hosts: ReadonlyMap<string, ExtensionHost>,
    contents: WebContents,
    frame: WebFrameMain,
    contentType: string
  ): ContentFrameInit[] {
    // A frame-tree node survives navigation. Remove its previous document's
    // contexts even when the new document accepts no content scripts; otherwise
    // tabs.executeScript/insertCSS can still target the old HTML registration.
    const contextId = frameContextId(contents, frame)
    for (const host of hosts.values()) host.contexts.remove(contextId)
    // Firefox extensions cannot inject into the native PDF viewer. Its outer
    // document still has the requested HTTP URL, including extensionless URLs.
    this.pdfFrames.delete(frame)
    if (contentType === "application/pdf") {
      this.pdfFrames.add(frame)
      return []
    }
    if (insidePdfViewer(frame)) return []
    const ids = frameIdsOf(frame)
    const ownPage = parseExtensionUrl(frame.url)
    if (ownPage) {
      const host = hosts.get(ownPage.host)
      if (!host || frame.parent === null || !isWebAccessible(host.extension, ownPage.path)) return []
      host.contexts.addFrame(contents, frame, host.extension.host, contents.id, ids.frameId, "page")
      return [frameInit(host, "page")]
    }
    const identity = {
      url: frame.url,
      topUrl: frame.top?.url ?? frame.url,
      isTop: frame.parent === null
    }
    const inits: ContentFrameInit[] = []
    for (const host of hosts.values()) {
      const specs = contentScriptsFor(host.contentScripts(), identity)
      if (specs.length === 0) continue
      host.contexts.addFrame(contents, frame, host.extension.host, contents.id, ids.frameId)
      inits.push(frameInit(host, "content", batches(host, specs)))
    }
    return inits
  }

  /** A gesture-granted extension may need a content world on a tab with no manifest script. */
  ensure(host: ExtensionHost, contents: WebContents, tabId: number, frameId?: number, allFrames = false): void {
    const init = frameInit(host, "content")
    const visit = (frame: WebFrameMain): void => {
      const id = frameIdsOf(frame).frameId
      if ((frameId !== undefined ? id === frameId : allFrames || id === 0) &&
          !frame.detached && !this.pdfFrames.has(frame) && !insidePdfViewer(frame) &&
          canInjectFrame(host, tabId, frame.url, creatorUrl(frame)) &&
          !host.contexts.get(frameContextId(contents, frame))) {
        host.contexts.addFrame(contents, frame, host.extension.host, tabId, id)
        frame.send(EXTENSION_IPC.event, {
          api: INTERNAL_API.content, event: "bootstrap", host: host.extension.host, args: [init]
        })
      }
      if (allFrames || frameId !== undefined) for (const child of frame.frames) visit(child)
    }
    visit(contents.mainFrame)
  }
}
