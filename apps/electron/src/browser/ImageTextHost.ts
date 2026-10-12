import type { Debugger, WebContents, WebFrameMain } from "electron"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { ImageTextAnchorReport, ImageTextAnchorState, ImageTextRevealed } from "@once/ui-web/imageText/imageTextAnchor"
import type { ImageTextViewMessage } from "@once/ui-web/imageText/imageTextTypes"

/**
 * The image text selection's host in the page (imageTextAnchor.ts), run in
 * an isolated world of the image's frame: the page's own scripts never see
 * it. It hangs the app's words frame and bar on the image, anchored so the
 * page's compositor moves them with it; the app talks to it through this.
 * Frames in other processes (cross-site iframes) are reached through their
 * own DevTools protocol sessions.
 */
export interface ImageTextHost {
  /** Called once the selection closed in the page: Done, Escape, or the image went away. */
  onClose(handler: () => void): void
  send(message: ImageTextViewMessage): void
  /** Brings the image into the tab's view, for find in page's match in the words (see the anchor's `reveal`). */
  reveal(): void
  /** For the app's tests. */
  state(): Promise<ImageTextAnchorState | null>
  close(): void
}

const WORLD = "once-image-text"
const BINDING = "__onceImageTextPush"
let anchorSource: string | undefined

function source(): string {
  anchorSource ??= readFileSync(path.join(__dirname, "image-text-anchor.js"), "utf8")
  return anchorSource
}

const call = (method: string, token: string, ...values: unknown[]) =>
  `window.__onceImageTextAnchor?.${method}(${[token, ...values].map((value) => JSON.stringify(value)).join(", ")})`

/**
 * Hangs the selection on the image the menu was opened on, in `frame`.
 * Resolves null when the image is not found there, or when the tab's
 * debugger is taken (another protocol client) and the image is in a
 * subframe, which only the protocol reaches.
 */
export async function openImageTextHost(tab: WebContents, frame: WebFrameMain, src: string, x: number, y: number,
  token: string, frameUrl: string): Promise<ImageTextHost | null> {
  if (!tab.debugger.isAttached()) {
    try {
      return await ProtocolHost.open(tab, frame, [src, x, y, frameUrl], token)
    } catch (error) {
      console.warn("Image text could not use the DevTools protocol", error instanceof Error ? error.message : String(error))
      if (tab.debugger.isAttached()) tab.debugger.detach()
    }
  }
  return frame === tab.mainFrame ? IsolatedWorldHost.open(tab, [src, x, y, frameUrl], token) : null
}

interface Frame { id: string; session: string; parentId?: string; url: string }

class ProtocolHost implements ImageTextHost {
  private handler: () => void = () => undefined
  private closed = false
  /** The host's world went away with its frame. */
  private lost = false

  /**
   * `owner` is the image's frame as its parent sees it, for a subframe: the
   * frame's id and the parent's session, which holds its iframe element.
   */
  private constructor(private readonly tab: WebContents, private readonly debug: Debugger,
    private readonly token: string, private readonly session: string, private readonly context: number,
    private readonly owner: { frame: string; session: string } | null) {
    debug.on("message", this.message)
    debug.on("detach", this.detached)
  }

  static async open(tab: WebContents, frame: WebFrameMain, start: unknown[], token: string) {
    const debug = tab.debugger
    debug.attach("1.3")
    const send = <T>(method: string, params: object, session: string) =>
      debug.sendCommand(method, params, session || undefined) as Promise<T>
    try {
      const frames = await frameTree(debug, send)
      const root = frames.find((candidate) => !candidate.parentId && !candidate.session)
      if (!root) throw new Error("No main frame")
      // The menu names its frame by URL; the host that finds the image decides between equals.
      const candidates = frame === tab.mainFrame ? [root] : frames.filter((candidate) => candidate !== root && candidate.url === frame.url)
      for (const candidate of candidates) {
        const { executionContextId: context } = await send<{ executionContextId: number }>("Page.createIsolatedWorld",
          { frameId: candidate.id, worldName: WORLD, grantUniveralAccess: false }, candidate.session)
        // Bound to this context only: the page's own world never sees it.
        await send("Runtime.addBinding", { name: BINDING, executionContextId: context }, candidate.session)
        await send("Runtime.evaluate", { expression: source(), contextId: context }, candidate.session)
        const { result } = await send<{ result?: { value?: unknown } }>("Runtime.evaluate",
          { contextId: context, returnByValue: true, expression: call("start", token, ...start) }, candidate.session)
        if (result?.value !== true) continue
        const parent = frames.find((known) => known.id === candidate.parentId)
        const host = new ProtocolHost(tab, debug, token, candidate.session, context,
          parent ? { frame: candidate.id, session: parent.session } : null)
        // Reports the world going away with its frame (an iframe removed, a navigation), which it cannot report itself.
        await send("Runtime.enable", {}, candidate.session)
        return host
      }
      debug.detach()
      return null
    } catch (error) {
      if (debug.isAttached()) debug.detach()
      throw error
    }
  }

  onClose(handler: () => void): void {
    this.handler = handler
  }

  send(message: ImageTextViewMessage): void {
    void this.evaluate(call("message", this.token, message)).catch(() => undefined)
  }

  /**
   * The image's frame brings it into its own view, and Chromium carries that
   * scroll up through the frames. An image already in its frame's view, in
   * an iframe the page has scrolled away, is brought in by its iframe
   * element, through the parent: its frame, out of sight and cross-origin,
   * runs no find scroll of its own (see the anchor's `reveal`).
   */
  reveal(): void {
    void (async () => {
      const shown = (await this.evaluate(call("reveal", this.token))) as ImageTextRevealed | null
      if (!shown || !this.owner || this.closed || !this.debug.isAttached()) return
      const send = <T>(method: string, params: object) => this.debug.sendCommand(method, params, this.owner?.session || undefined) as Promise<T>
      const { backendNodeId } = await send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: this.owner.frame })
      // The image's place in its frame's viewport is relative to the iframe's content box; the rect wants its border box.
      const { model } = await send<{ model: { content: number[]; border: number[] } }>("DOM.getBoxModel", { backendNodeId })
      await send("DOM.scrollIntoViewIfNeeded", { backendNodeId, rect: { x: model.content[0] - model.border[0] + shown.left,
        y: model.content[1] - model.border[1] + shown.top, width: shown.width, height: shown.height } })
    })().catch(() => undefined)
  }

  async state(): Promise<ImageTextAnchorState | null> {
    return (await this.evaluate(call("state", this.token))) as ImageTextAnchorState | null
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.debug.removeListener("message", this.message)
    this.debug.removeListener("detach", this.detached)
    if (this.tab.isDestroyed() || !this.debug.isAttached()) return
    const detach = () => { if (!this.tab.isDestroyed() && this.debug.isAttached()) this.debug.detach() }
    if (this.lost) setTimeout(detach, 0)
    else void this.evaluate(call("stop", this.token)).catch(() => undefined).finally(detach)
  }

  private async evaluate(expression: string): Promise<unknown> {
    if (this.tab.isDestroyed() || !this.debug.isAttached()) return null
    const { result } = await this.debug.sendCommand("Runtime.evaluate", { contextId: this.context, returnByValue: true, expression },
      this.session || undefined) as { result?: { value?: unknown } }
    return result?.value ?? null
  }

  private readonly message = (_event: Electron.Event, method: string,
    params: { name?: string; payload?: string; executionContextId?: number; sessionId?: string }, session?: string) => {
    if (this.closed) return
    const ours = (session ?? "") === this.session
    if ((method === "Runtime.executionContextDestroyed" && ours && params.executionContextId === this.context) ||
      (method === "Runtime.executionContextsCleared" && ours) ||
      (method === "Target.detachedFromTarget" && this.session && params.sessionId === this.session)) {
      // The world is gone with its frame: nothing to stop there. Answered
      // after this dispatch: sending to or detaching from a session while the
      // protocol reports its end took the whole app down (Electron 45).
      this.lost = true
      setTimeout(() => { if (!this.closed) this.handler() }, 0)
      return
    }
    if (method !== "Runtime.bindingCalled" || params.name !== BINDING) return
    if (params.executionContextId !== this.context || !ours) return
    let report: ImageTextAnchorReport
    try { report = JSON.parse(String(params.payload)) as ImageTextAnchorReport } catch { return }
    if (report.token === this.token && report.closed) this.handler()
  }

  private readonly detached = () => {
    this.lost = true
    setTimeout(() => { if (!this.closed) this.handler() }, 0)
  }
}

/** Every frame of the tab, across the sessions of out-of-process frames, which auto-attach. */
async function frameTree(debug: Debugger, send: <T>(method: string, params: object, session: string) => Promise<T>): Promise<Frame[]> {
  const sessions: string[] = [""]
  const pending: Promise<unknown>[] = []
  const attached = (_event: Electron.Event, method: string, params: { sessionId?: string; targetInfo?: { type?: string } }) => {
    if (method !== "Target.attachedToTarget" || params.targetInfo?.type !== "iframe" || !params.sessionId) return
    sessions.push(params.sessionId)
    // Frames in other processes may hold more of them.
    pending.push(send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, params.sessionId).catch(() => undefined))
  }
  debug.on("message", attached)
  try {
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, "")
    for (let settled = 0; settled < pending.length;) {
      const batch = pending.slice(settled)
      settled = pending.length
      await Promise.all(batch)
    }
  } finally {
    debug.removeListener("message", attached)
  }
  interface Tree { frame: { id: string; parentId?: string; url: string }; childFrames?: Tree[] }
  const frames: Frame[] = []
  for (const session of sessions) {
    const { frameTree: tree } = await send<{ frameTree: Tree }>("Page.getFrameTree", {}, session)
    const walk = (node: Tree) => {
      if (!frames.some((known) => known.id === node.frame.id)) {
        frames.push({ id: node.frame.id, session, parentId: node.frame.parentId, url: node.frame.url })
      }
      node.childFrames?.forEach(walk)
    }
    walk(tree)
  }
  return frames
}

/**
 * Without the protocol (another client holds the tab's debugger): the main
 * frame's isolated world, reached through Electron, which has no binding
 * back, so the app asks now and then whether the selection is still open.
 */
class IsolatedWorldHost implements ImageTextHost {
  private static readonly WORLD_ID = 917
  private handler: () => void = () => undefined
  private closed = false
  private readonly poll: ReturnType<typeof setInterval>

  private constructor(private readonly tab: WebContents, private readonly token: string) {
    this.poll = setInterval(() => {
      void this.evaluate(call("alive", token)).then((alive) => { if (alive === false && !this.closed) this.handler() })
    }, 250)
  }

  static async open(tab: WebContents, start: unknown[], token: string) {
    await tab.executeJavaScriptInIsolatedWorld(IsolatedWorldHost.WORLD_ID, [{ code: source() }])
    const found = await tab.executeJavaScriptInIsolatedWorld(IsolatedWorldHost.WORLD_ID, [{ code: call("start", token, ...start) }])
    return found === true ? new IsolatedWorldHost(tab, token) : null
  }

  onClose(handler: () => void): void {
    this.handler = handler
  }

  send(message: ImageTextViewMessage): void {
    void this.evaluate(call("message", this.token, message))
  }

  /** In the main frame, the image's own scroll is all it takes. */
  reveal(): void {
    void this.evaluate(call("reveal", this.token))
  }

  async state(): Promise<ImageTextAnchorState | null> {
    return (await this.evaluate(call("state", this.token))) as ImageTextAnchorState | null
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.poll)
    void this.evaluate(call("stop", this.token))
  }

  private async evaluate(code: string): Promise<unknown> {
    if (this.tab.isDestroyed()) return null
    return this.tab.executeJavaScriptInIsolatedWorld(IsolatedWorldHost.WORLD_ID, [{ code }]).catch(() => null)
  }
}
