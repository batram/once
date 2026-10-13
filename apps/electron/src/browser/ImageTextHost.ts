import { ipcMain, type WebContents, type WebFrameMain } from "electron"
import { randomUUID } from "node:crypto"
import type { ImageTextAnchorState, ImageTextInView, ImageTextRevealed } from "@once/ui-web/imageText/imageTextAnchor"
import type { ImageTextViewMessage } from "@once/ui-web/imageText/imageTextTypes"
import { IMAGE_TEXT_IPC } from "./imageTextIpc"
import { captureInView, type ImageTextPicture, readFrameResource } from "./ImageTextPicture"

/**
 * The image text selection's host in the page (imageTextAnchor.ts), run by
 * the frame preload in an isolated world of the image's frame: the page's
 * own scripts never see it. It hangs the app's words frame and bar on the
 * image, anchored so the page's compositor moves them with it; the app
 * talks to it over IPC addressed to that one frame.
 */
export interface ImageTextHost {
  /** Called once the selection closed in the page: Done, Escape, or the image went away. */
  onClose(handler: () => void): void
  send(message: ImageTextViewMessage): void
  /** Brings the image into the tab's view, for find in page's match in the words (see the anchor's `reveal`). */
  reveal(): void
  /** The picture the page shows, from the renderer's own copy (see ImageTextPicture.ts). */
  picture(signal: AbortSignal): Promise<ImageTextPicture | null>
  /** For the app's tests. */
  state(): Promise<ImageTextAnchorState | null>
  close(): void
}

/** Only a reply from the selected WebFrameMain can satisfy a request. Nothing is exported to page JavaScript. */
function request(frame: WebFrameMain, token: string, method: string, values: unknown[] = [], signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  if (frame.isDestroyed()) return Promise.reject(new Error("Image text frame unavailable"))
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer)
      ipcMain.removeListener(IMAGE_TEXT_IPC.reply, reply)
      signal?.removeEventListener("abort", abort)
      if (error) reject(error); else resolve(value)
    }
    const reply = (event: Electron.IpcMainEvent, result: { id?: string; value?: unknown; error?: string }) => {
      if (event.senderFrame !== frame || result?.id !== id) return
      finish(result.error ? new Error("Image text frame unavailable") : undefined, result.value)
    }
    const abort = () => finish(new Error("Image text cancelled"))
    const timer = setTimeout(() => finish(new Error("Image text frame timed out")), 5_000)
    ipcMain.on(IMAGE_TEXT_IPC.reply, reply)
    signal?.addEventListener("abort", abort, { once: true })
    try { frame.send(IMAGE_TEXT_IPC.command, { id, token, method, values }) } catch { finish(new Error("Image text frame unavailable")) }
  })
}

/**
 * Hangs the selection on the image the menu was opened on, in `frame`;
 * resolves null when the image is not found there. The main frame's picture
 * is captured as the tab shows it, before anything is hung on it, when
 * another protocol client holds the tab's debugger (no renderer hands over
 * its bytes then) or when its bytes are markup: an SVG, which the native
 * helper's decoder cannot read. A subframe's cannot be, and the selection
 * reports that.
 */
export async function openImageTextHost(tab: WebContents, frame: WebFrameMain, src: string, x: number, y: number,
  token: string, frameUrl: string, signal: AbortSignal): Promise<ImageTextHost | null> {
  let shot: ImageTextPicture | null = null
  let read: Read | null = null
  if (frame === tab.mainFrame) {
    if (!src.startsWith("data:")) {
      const bytes = await readFrameResource(tab, frame, src, signal).catch((error: unknown) => { if (signal.aborted) throw error; return null })
      read = { url: src, bytes }
    }
    if (tab.debugger.isAttached() || src.startsWith("data:image/svg+xml") || isMarkup(read?.bytes)) {
      const shown = await request(frame, token, "locate", [src, x, y], signal) as ImageTextInView | null
      shot = shown ? await captureInView(tab, shown).catch(() => null) : null
    }
  }
  const host = new FrameHost(tab, frame, token, shot, read)
  try {
    const found = await request(frame, token, "start", [src, x, y, frameUrl], signal)
    signal.throwIfAborted()
    if (found === true) return host
    host.close()
    return null
  } catch (error) { host.close(); throw error }
}

/** The image's bytes as read before the selection was hung on it. */
interface Read { url: string; bytes: Buffer | null }

/** A tag first, past whitespace (\s covers a byte order mark): SVG or other XML, never a raster. */
function isMarkup(bytes: Buffer | null | undefined): boolean {
  return !!bytes && /^\s*</.test(bytes.subarray(0, 64).toString("utf8"))
}

class FrameHost implements ImageTextHost {
  private closed = false
  private handler: () => void = () => undefined

  constructor(private readonly tab: WebContents, private readonly frame: WebFrameMain, private readonly token: string,
    private readonly shot: ImageTextPicture | null, private readonly read: Read | null) {
    ipcMain.on(IMAGE_TEXT_IPC.closed, this.report)
  }

  onClose(handler: () => void): void {
    this.handler = handler
    if (this.closed) handler()
  }

  private readonly report = (event: Electron.IpcMainEvent, payload: unknown) => {
    if (this.closed || event.sender !== this.tab || event.senderFrame !== this.frame || typeof payload !== "string" || payload.length > 256) return
    try {
      const report = JSON.parse(payload) as { token?: string; closed?: boolean }
      if (report.token === this.token && report.closed === true) { this.close(); this.handler() }
    } catch { /* Ignore malformed reports from a renderer. */ }
  }

  send(message: ImageTextViewMessage): void {
    if (!this.closed) void request(this.frame, this.token, "message", [message]).catch(() => this.handler())
  }

  async picture(signal: AbortSignal): Promise<ImageTextPicture | null> {
    if (this.shot) return this.shot
    const url = await request(this.frame, this.token, "source", [], signal)
    if (typeof url !== "string" || !url || this.closed) return null
    const bytes = this.read?.url === url && this.read.bytes ? this.read.bytes : await readFrameResource(this.tab, this.frame, url, signal)
    return bytes && !this.closed ? { bytes } : null
  }

  reveal(): void {
    void (async () => {
      const shown = await request(this.frame, this.token, "reveal") as ImageTextRevealed | null
      if (!shown || this.closed) return
      // An image can be visible in its own frame while an ancestor iframe is offscreen.
      for (let child = this.frame, parent = child.parent; parent && !this.closed; child = parent, parent = parent.parent) {
        const index = parent.frames.indexOf(child)
        if (index < 0) return
        await request(parent, this.token, "reveal-child", [index])
      }
    })().catch(() => undefined)
  }

  async state(): Promise<ImageTextAnchorState | null> {
    if (this.closed) return null
    return await request(this.frame, this.token, "state").catch(() => null) as ImageTextAnchorState | null
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    ipcMain.removeListener(IMAGE_TEXT_IPC.closed, this.report)
    void request(this.frame, this.token, "stop").catch(() => undefined)
  }
}
