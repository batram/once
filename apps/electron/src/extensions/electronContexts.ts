// Extension contexts over Electron transports: an extension page is a
// `WebContents`, a frame of a tab or of an extension page a `WebFrameMain`.
// Each entry sends `EXTENSION_IPC.event` to its own target.

import { WebContents, WebFrameMain } from "electron"
import {
  ContextEntry,
  EXTENSION_IPC,
  ExtensionContextKind,
  ExtensionContexts,
  isBlankFrameUrl
} from "@once/webext-runtime"

export function pageContextId(contents: WebContents): string {
  return String(contents.id)
}

// The frame-tree node id survives navigations of the same frame, so a new
// document replaces the previous document's context instead of joining it.
export function frameContextId(contents: WebContents, frame: WebFrameMain): string {
  return `${contents.id}:${frame.frameTreeNodeId}`
}

/** A blank frame takes its parent's origin, which may differ from the top document's. */
export function creatorUrl(frame: WebFrameMain): string {
  for (let ancestor = frame.parent; ancestor; ancestor = ancestor.parent) {
    if (!isBlankFrameUrl(ancestor.url)) return ancestor.url
  }
  return ""
}

export class ElectronExtensionContexts extends ExtensionContexts {
  /** An extension page in its own webContents. */
  add(contents: WebContents, kind: ExtensionContextKind): ContextEntry {
    const entry = this.addEntry({
      id: pageContextId(contents),
      kind,
      tabId: -1,
      frameId: 0,
      listeners: new Map(),
      url: () => (contents.isDestroyed() ? "" : contents.getURL()),
      isDestroyed: () => contents.isDestroyed(),
      send: (message) => {
        if (!contents.isDestroyed()) contents.send(EXTENSION_IPC.event, message)
      }
    })
    contents.once("destroyed", () => this.remove(entry.id))
    return entry
  }

  /**
   * An iframe of an extension page that shows another page of the same
   * extension (uBlock's dashboard loads each pane that way). It has its own
   * `browser` object, so events and port traffic must target the frame:
   * `contents.send` only reaches the main frame.
   */
  addPageFrame(contents: WebContents, frame: WebFrameMain, kind: ExtensionContextKind): ContextEntry {
    const id = frameContextId(contents, frame)
    const alive = () => !contents.isDestroyed() && !frame.detached
    const entry = this.addEntry({
      id,
      kind,
      tabId: -1,
      frameId: frame.frameTreeNodeId,
      listeners: new Map(),
      url: () => (alive() ? frame.url : ""),
      isDestroyed: () => !alive(),
      send: (message) => {
        if (alive()) frame.send(EXTENSION_IPC.event, message)
      }
    })
    contents.once("destroyed", () => this.remove(id))
    return entry
  }

  /**
   * This extension's content-script world inside one frame of a tab, or,
   * as a `page`, a frame of the tab that shows one of the extension's own
   * web-accessible pages (uBlock's element picker). Either way the frame
   * shares the tab's process with other extensions, so messages carry the
   * host they are for.
   */
  addFrame(
    contents: WebContents,
    frame: WebFrameMain,
    host: string,
    tabId: number,
    frameId: number,
    kind: ExtensionContextKind = "content"
  ): ContextEntry {
    const id = frameContextId(contents, frame)
    const alive = () => !contents.isDestroyed() && !frame.detached
    return this.addEntry({
      id,
      kind,
      tabId,
      frameId,
      listeners: new Map(),
      url: () => (alive() ? frame.url : ""),
      creatorUrl: () => (alive() ? creatorUrl(frame) : ""),
      isDestroyed: () => !alive(),
      send: (message) => {
        if (alive()) frame.send(EXTENSION_IPC.event, { ...message, host })
      }
    })
  }
}
