import type { Debugger, WebContents, WebFrameMain } from "electron"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { ImageTextProbeFit, ImageTextProbeReport } from "../imageTextProbe"

/**
 * Where the image whose text is being selected is, in the tab's top-level CSS
 * pixels, kept current for ImageTextOverlay. A read-only probe
 * (imageTextProbe.ts) runs in an isolated world of the image's frame and of
 * every frame above it, where it follows the iframe holding the next one;
 * the probes push each change through a DevTools protocol binding, and their
 * fits are chained into one. Frames in other processes (cross-site iframes)
 * are reached through their own protocol sessions.
 */
export interface ImageTextProbes {
  /** The latest fit; null once the image, or a frame holding it, is gone. */
  onChange(handler: (fit: ImageTextProbeFit | null) => void): void
  close(): void
}

const WORLD = "once-image-text"
const BINDING = "__onceImageTextPush"
let probeSource: string | undefined

function source(): string {
  probeSource ??= readFileSync(path.join(__dirname, "image-text-probe.js"), "utf8")
  return probeSource
}

/**
 * Starts probes on the image the menu was opened on. Resolves null when the
 * image is not found, or when the tab's debugger is taken (another protocol
 * client) and the image is in a subframe, which only the protocol reaches.
 */
export async function openImageTextProbes(tab: WebContents, frame: WebFrameMain, src: string, x: number, y: number,
  token: string): Promise<{ probes: ImageTextProbes; fit: ImageTextProbeFit } | null> {
  if (!tab.debugger.isAttached()) {
    try {
      return await ProtocolProbes.open(tab, frame, src, x, y, token)
    } catch (error) {
      console.warn("Image text probes could not use the DevTools protocol", error instanceof Error ? error.message : String(error))
      if (tab.debugger.isAttached()) tab.debugger.detach()
    }
  }
  return frame === tab.mainFrame ? PollingProbes.open(tab, src, x, y, token) : null
}

interface Frame { id: string; session: string; parentId?: string; url: string }
interface Level { session: string; context: number; fit: ImageTextProbeFit | null }

class ProtocolProbes implements ImageTextProbes {
  private handler: (fit: ImageTextProbeFit | null) => void = () => undefined
  private closed = false

  private constructor(private readonly tab: WebContents, private readonly debug: Debugger,
    private readonly token: string, private readonly levels: Level[]) {
    debug.on("message", this.message)
    debug.on("detach", this.detached)
  }

  static async open(tab: WebContents, frame: WebFrameMain, src: string, x: number, y: number, token: string) {
    const debug = tab.debugger
    debug.attach("1.3")
    const send = <T>(method: string, params: object, session: string) =>
      debug.sendCommand(method, params, session || undefined) as Promise<T>
    try {
      const frames = await frameTree(debug, send)
      const root = frames.find((candidate) => !candidate.parentId && !candidate.session)
      if (!root) throw new Error("No main frame")
      const world = async (target: Frame) => {
        const { executionContextId } = await send<{ executionContextId: number }>("Page.createIsolatedWorld",
          { frameId: target.id, worldName: WORLD, grantUniveralAccess: false }, target.session)
        // Bound to this context only: the page's own world never sees it.
        await send("Runtime.addBinding", { name: BINDING, executionContextId }, target.session)
        await send("Runtime.evaluate", { expression: source(), contextId: executionContextId }, target.session)
        return executionContextId
      }
      const value = async (call: Promise<{ result?: { value?: unknown } }>) => (await call).result?.value as ImageTextProbeFit | null
      // The menu names its frame by URL; the probe that finds the image decides between equals.
      let image: { frame: Frame; level: Level } | null = null
      const candidates = frame === tab.mainFrame ? [root] : frames.filter((candidate) => candidate !== root && candidate.url === frame.url)
      for (const candidate of candidates) {
        const context = await world(candidate)
        const fit = await value(send("Runtime.evaluate", { contextId: context, returnByValue: true,
          expression: `window.__onceImageTextProbe.start(${JSON.stringify(src)}, ${Number(x)}, ${Number(y)}, ${JSON.stringify(token)})` }, candidate.session))
        if (fit) { image = { frame: candidate, level: { session: candidate.session, context, fit } }; break }
      }
      if (!image) throw new NotFound()
      // Up the frame chain: each parent follows the iframe holding its child.
      const levels = [image.level]
      for (let child = image.frame; child.parentId;) {
        const parent = frames.find((candidate) => candidate.id === child.parentId)
        if (!parent) throw new Error("Missing parent frame")
        const context = await world(parent)
        const { backendNodeId } = await send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: child.id }, parent.session)
        const { object } = await send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId, executionContextId: context }, parent.session)
        const fit = await value(send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true,
          functionDeclaration: "function (token) { return window.__onceImageTextProbe.frame(this, token) }",
          arguments: [{ value: token }] }, parent.session))
        if (!fit) throw new NotFound()
        levels.unshift({ session: parent.session, context, fit })
        child = parent
      }
      const probes = new ProtocolProbes(tab, debug, token, levels)
      return { probes, fit: composeFits(levels.map((level) => level.fit as ImageTextProbeFit)) }
    } catch (error) {
      if (debug.isAttached()) debug.detach()
      if (error instanceof NotFound) return null
      throw error
    }
  }

  onChange(handler: (fit: ImageTextProbeFit | null) => void): void {
    this.handler = handler
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.debug.removeListener("message", this.message)
    this.debug.removeListener("detach", this.detached)
    if (this.tab.isDestroyed() || !this.debug.isAttached()) return
    for (const level of this.levels) {
      void this.debug.sendCommand("Runtime.evaluate", { contextId: level.context,
        expression: `window.__onceImageTextProbe?.stop(${JSON.stringify(this.token)})` }, level.session || undefined).catch(() => undefined)
    }
    this.debug.detach()
  }

  private readonly message = (_event: Electron.Event, method: string, params: { name?: string; payload?: string; executionContextId?: number }, session?: string) => {
    if (this.closed || method !== "Runtime.bindingCalled" || params.name !== BINDING) return
    const level = this.levels.find((candidate) => candidate.context === params.executionContextId && candidate.session === (session ?? ""))
    if (!level) return
    let report: ImageTextProbeReport
    try { report = JSON.parse(String(params.payload)) as ImageTextProbeReport } catch { return }
    if (report.token !== this.token) return
    level.fit = report.fit
    this.handler(this.levels.every((candidate) => candidate.fit) ? composeFits(this.levels.map((candidate) => candidate.fit as ImageTextProbeFit)) : null)
  }

  private readonly detached = () => {
    if (!this.closed) this.handler(null)
  }
}

class NotFound extends Error {}

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

type Box = ImageTextProbeFit["visibleBox"]

/**
 * One fit in the top frame's CSS pixels from a chain of them: each frame's
 * iframe fit places the next frame (its content box, scaled from that frame's
 * layout width) and clips it to what is visible of the iframe.
 */
function composeFits(levels: ImageTextProbeFit[]): ImageTextProbeFit {
  const image = levels[levels.length - 1]
  let x = 0, y = 0, scale = 1
  let clip: Box | null = null
  let visible = true
  const map = (box: Box): Box => ({ left: x + box.left * scale, top: y + box.top * scale, right: x + box.right * scale, bottom: y + box.bottom * scale })
  for (let index = 0; index < levels.length - 1; index++) {
    const owner = levels[index], child = levels[index + 1]
    const box = map(owner.visibleBox)
    clip = clip ? intersect(clip, box) : box
    visible &&= owner.visible
    x += owner.left * scale
    y += owner.top * scale
    scale *= owner.width / (child.innerWidth || owner.width)
  }
  const box = clip ? intersect(map(image.visibleBox), clip) : map(image.visibleBox)
  const top = levels[0]
  return {
    ...image,
    left: x + image.left * scale, top: y + image.top * scale, width: image.width * scale, height: image.height * scale,
    imageLeft: image.imageLeft * scale, imageTop: image.imageTop * scale,
    imageWidth: image.imageWidth * scale, imageHeight: image.imageHeight * scale,
    visibleBox: box, visible: visible && image.visible && box.right > box.left && box.bottom > box.top,
    viewportWidth: top.viewportWidth, viewportHeight: top.viewportHeight, innerWidth: top.innerWidth
  }
}

function intersect(a: Box, b: Box): Box {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) }
}

/** Without the protocol (another client holds the tab's debugger): the main frame's probe, asked each frame. */
class PollingProbes implements ImageTextProbes {
  private static readonly WORLD_ID = 917
  private handler: (fit: ImageTextProbeFit | null) => void = () => undefined
  private closed = false

  private constructor(private readonly tab: WebContents, private readonly token: string) {
    void this.poll()
  }

  static async open(tab: WebContents, src: string, x: number, y: number, token: string) {
    await tab.executeJavaScriptInIsolatedWorld(PollingProbes.WORLD_ID, [{ code: source() }])
    const fit = await tab.executeJavaScriptInIsolatedWorld(PollingProbes.WORLD_ID, [{
      code: `window.__onceImageTextProbe.start(${JSON.stringify(src)}, ${Number(x)}, ${Number(y)}, ${JSON.stringify(token)})`
    }]) as ImageTextProbeFit | null
    return fit ? { probes: new PollingProbes(tab, token), fit } : null
  }

  onChange(handler: (fit: ImageTextProbeFit | null) => void): void {
    this.handler = handler
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (!this.tab.isDestroyed()) {
      void this.tab.executeJavaScriptInIsolatedWorld(PollingProbes.WORLD_ID, [{
        code: `window.__onceImageTextProbe?.stop(${JSON.stringify(this.token)})`
      }]).catch(() => undefined)
    }
  }

  private async poll(): Promise<void> {
    while (!this.closed) {
      await new Promise((resolve) => setTimeout(resolve, 16))
      if (this.closed || this.tab.isDestroyed()) return
      const fit = await this.tab.executeJavaScriptInIsolatedWorld(PollingProbes.WORLD_ID, [{
        code: `window.__onceImageTextProbe?.measure(${JSON.stringify(this.token)}) ?? null`
      }]).catch(() => null) as ImageTextProbeFit | null
      if (!this.closed) this.handler(fit)
    }
  }
}
