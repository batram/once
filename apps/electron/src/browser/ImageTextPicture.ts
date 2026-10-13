import type { Debugger, WebContents, WebFrameMain } from "electron"
import type { ImageTextInView } from "@once/ui-web/imageText/imageTextAnchor"
import { abortable } from "./OcrTask"

/** An image's bytes; `part` says where in its picture they lie, when they show only part of it. */
export interface ImageTextPicture { bytes: Buffer; part?: ImageTextInView["part"] }

interface Frame { id: string; session: string; url: string }
type Send = <T>(method: string, params: object, session: string) => Promise<T>

/**
 * The bytes the image's frame loaded, out of its renderer's memory: the
 * picture the page decoded, whatever its scheme (blob: too), format or
 * cache state, and never a request of the app's, which a site's hotlink
 * rules, cookies or content negotiation could answer differently than the
 * page's own load. The tab's debugger is held only for this read. Null when
 * another protocol client holds it (see `captureInView`).
 */
export async function readFrameResource(tab: WebContents, frame: WebFrameMain, url: string, signal: AbortSignal): Promise<Buffer | null> {
  signal.throwIfAborted()
  const debug = tab.debugger
  if (debug.isAttached()) return null
  debug.attach("1.3")
  const send: Send = (method, params, session) => abortable(debug.sendCommand(method, params, session || undefined), signal)
  try {
    // The main frame needs no other session; a subframe may live in another process, reached through its own.
    const frames = frame === tab.mainFrame ? await rootFrame(send) : await frameTree(debug, send)
    const root = frames.find((candidate) => !candidate.session)
    const exact = frame === tab.mainFrame ? frames.filter((candidate) => candidate === root)
      : frames.filter((candidate) => candidate !== root && candidate.url === frame.url)
    // Any frame that loaded the URL holds its bytes; the image's own frame is asked first.
    const candidates = [...exact, ...frames.filter((candidate) => !exact.includes(candidate))]
    for (const candidate of candidates) {
      // The resource is only served while the session's Page domain is enabled.
      await send("Page.enable", {}, candidate.session)
      try {
        const { content, base64Encoded } = await send<{ content: string; base64Encoded: boolean }>("Page.getResourceContent",
          { frameId: candidate.id, url }, candidate.session)
        const bytes = Buffer.from(content, base64Encoded ? "base64" : "utf8")
        if (bytes.length) return bytes
      } catch (error) {
        if (signal.aborted) throw error
      } finally {
        await send("Page.disable", {}, candidate.session).catch(() => undefined)
      }
    }
    return null
  } finally {
    if (!tab.isDestroyed() && debug.isAttached()) debug.detach()
  }
}

async function rootFrame(send: Send): Promise<Frame[]> {
  const { frameTree: tree } = await send<{ frameTree: { frame: { id: string; url: string } } }>("Page.getFrameTree", {}, "")
  return [{ id: tree.frame.id, session: "", url: tree.frame.url }]
}

/** Every frame of the tab, across the sessions of out-of-process frames, which auto-attach. */
async function frameTree(debug: Debugger, send: Send): Promise<Frame[]> {
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
  interface Tree { frame: { id: string; url: string }; childFrames?: Tree[] }
  const frames: Frame[] = []
  for (const session of sessions) {
    const { frameTree: tree } = await send<{ frameTree: Tree }>("Page.getFrameTree", {}, session)
    const walk = (node: Tree) => {
      if (!frames.some((known) => known.id === node.frame.id)) frames.push({ id: node.frame.id, session, url: node.frame.url })
      node.childFrames?.forEach(walk)
    }
    walk(tree)
  }
  return frames
}

/**
 * Without the protocol (another client holds the tab's debugger), the
 * picture is captured as the tab shows it, before the selection hangs
 * anything on it: the main frame's CSS pixels are the view's at its zoom;
 * the capture is in device pixels.
 */
export async function captureInView(tab: WebContents, shown: ImageTextInView): Promise<ImageTextPicture | null> {
  const zoom = tab.getZoomFactor()
  const left = Math.floor(shown.left * zoom), top = Math.floor(shown.top * zoom)
  const image = await tab.capturePage({ x: left, y: top,
    width: Math.ceil((shown.left + shown.width) * zoom) - left, height: Math.ceil((shown.top + shown.height) * zoom) - top })
  return image.isEmpty() ? null : { bytes: image.toPNG(), part: shown.part }
}
