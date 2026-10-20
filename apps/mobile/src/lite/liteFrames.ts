// Frames of one DevTools target, from the events Java forwards:
// `Page.frameAttached`/`frameNavigated`/`frameDetached`, the `Page.getFrameTree`
// snapshot taken at attach, and `Runtime.executionContextCreated`/`Destroyed`
// for the main world and the extension worlds in each frame. Chromium frame
// ids stay strings here; WebExtensions see 0 for the top frame and a stable
// positive integer for every other frame the broker has met.

import { FrameFacts, NO_FRAME, isBlankFrameUrl } from "@once/webext-runtime"
import { CdpFrameTree } from "./protocol"

interface FrameRecord {
  id: string
  parentId: string | null
  url: string
  webextId: number
  /** The main world's execution context, when known. */
  mainContextId: number | null
}

export interface WorldContext {
  contextId: number
  frameId: string
  name: string
}

let nextWebextFrameId = 1

export class TargetFrames {
  private readonly frames = new Map<string, FrameRecord>()
  /** Execution contexts of named worlds, by context id. */
  private readonly worlds = new Map<number, WorldContext>()

  snapshot(tree: CdpFrameTree): void {
    const visit = (node: CdpFrameTree, parentId: string | null): void => {
      this.upsert(node.frame.id, parentId ?? node.frame.parentId ?? null, node.frame.url)
      for (const child of node.childFrames ?? []) visit(child, node.frame.id)
    }
    visit(tree, null)
  }

  attached(frameId: string, parentFrameId: string | null): void {
    this.upsert(frameId, parentFrameId, "")
  }

  navigated(frameId: string, parentFrameId: string | null | undefined, url: string): void {
    const existing = this.frames.get(frameId)
    this.upsert(frameId, parentFrameId ?? existing?.parentId ?? null, url)
    // The old document's contexts go with `Runtime.executionContextDestroyed`
    // (or `…Cleared`); the new document's may already have been reported, as
    // Chromium can create them before it reports the navigation, so none are
    // dropped here.
  }

  /** A same-document navigation (`pushState`, a fragment): the URL changes, the document and its contexts stay. */
  navigatedWithinDocument(frameId: string, url: string): void {
    const frame = this.frames.get(frameId)
    if (frame && url) frame.url = url
  }

  detached(frameId: string): WorldContext[] {
    const removed = new Set([frameId])
    // Child frames need cleanup even when Chromium reports only their parent's removal.
    let changed = true
    while (changed) {
      changed = false
      for (const frame of this.frames.values()) {
        if (frame.parentId && removed.has(frame.parentId) && !removed.has(frame.id)) {
          removed.add(frame.id)
          changed = true
        }
      }
    }
    for (const id of removed) this.frames.delete(id)
    const gone: WorldContext[] = []
    for (const [contextId, world] of this.worlds) {
      if (!removed.has(world.frameId)) continue
      gone.push(world)
      this.worlds.delete(contextId)
    }
    return gone
  }

  contextCreated(context: { id: number; name?: string; auxData?: { frameId?: string; isDefault?: boolean } }): void {
    const frameId = context.auxData?.frameId
    if (!frameId) return
    const frame = this.frames.get(frameId) ?? this.upsert(frameId, this.frames.size === 0 ? null : undefined, "")
    if (context.auxData?.isDefault) {
      frame.mainContextId = context.id
      return
    }
    this.worlds.set(context.id, { contextId: context.id, frameId, name: context.name ?? "" })
  }

  /** The world the destroyed context belonged to, if it was one of ours. */
  contextDestroyed(contextId: number): WorldContext | undefined {
    const world = this.worlds.get(contextId)
    this.worlds.delete(contextId)
    for (const frame of this.frames.values()) {
      if (frame.mainContextId === contextId) frame.mainContextId = null
    }
    return world
  }

  /** Every world context, as `Runtime.executionContextsCleared` drops them. */
  contextsCleared(): WorldContext[] {
    const worlds = [...this.worlds.values()]
    this.worlds.clear()
    for (const frame of this.frames.values()) frame.mainContextId = null
    return worlds
  }

  world(contextId: number): WorldContext | undefined {
    return this.worlds.get(contextId)
  }

  allWorlds(): WorldContext[] {
    return [...this.worlds.values()]
  }

  worldsOf(frameId: string): WorldContext[] {
    return [...this.worlds.values()].filter((world) => world.frameId === frameId)
  }

  mainContextId(frameId: string): number | null {
    return this.frames.get(frameId)?.mainContextId ?? null
  }

  isTop(frameId: string): boolean {
    const frame = this.frames.get(frameId)
    return frame === undefined || frame.parentId === null
  }

  topUrl(): string | null {
    for (const frame of this.frames.values()) if (frame.parentId === null) return frame.url || null
    return null
  }

  webextFrameId(frameId: string): number {
    const frame = this.frames.get(frameId)
    return !frame || frame.parentId === null ? 0 : frame.webextId
  }

  /** The Chromium frame id behind a WebExtension frame id; `0` is the top frame. */
  frameIdFor(webextId: number): string | null {
    for (const frame of this.frames.values()) {
      if (webextId === 0 ? frame.parentId === null : frame.webextId === webextId) return frame.id
    }
    return null
  }

  url(frameId: string): string {
    return this.frames.get(frameId)?.url ?? ""
  }

  /** The frame's parent; null for the top frame or a frame the broker never met. */
  parentOf(frameId: string): string | null {
    return this.frames.get(frameId)?.parentId ?? null
  }

  /** The frame's own URL when it is not blank, else what it inherits its origin from. */
  creatorUrlOf(frameId: string): string {
    const url = this.frames.get(frameId)?.url ?? ""
    return url && !isBlankFrameUrl(url) && url !== "about:srcdoc" ? url : this.creatorUrl(frameId)
  }

  /** The nearest non-blank ancestor URL: what a blank frame inherits its origin from. */
  creatorUrl(frameId: string): string {
    let current = this.frames.get(frameId)?.parentId ?? null
    while (current !== null) {
      const frame = this.frames.get(current)
      if (!frame) break
      if (!isBlankFrameUrl(frame.url)) return frame.url
      current = frame.parentId
    }
    return ""
  }

  /** What the webRequest router needs to know about the requesting frame. */
  facts(frameId: string | undefined): FrameFacts {
    if (!frameId) return NO_FRAME
    const frame = this.frames.get(frameId)
    if (!frame) return NO_FRAME
    const parent = frame.parentId === null ? null : this.frames.get(frame.parentId) ?? null
    return {
      frameId: frame.parentId === null ? 0 : frame.webextId,
      parentFrameId: frame.parentId === null ? -1 : parent === null || parent.parentId === null ? 0 : parent.webextId,
      documentUrl: frame.url || null,
      topUrl: this.topUrl()
    }
  }

  private upsert(frameId: string, parentId: string | null | undefined, url: string): FrameRecord {
    let frame = this.frames.get(frameId)
    if (!frame) {
      frame = { id: frameId, parentId: parentId ?? null, url, webextId: nextWebextFrameId++, mainContextId: null }
      this.frames.set(frameId, frame)
      return frame
    }
    if (parentId !== undefined) frame.parentId = parentId
    if (url) frame.url = url
    return frame
  }
}
