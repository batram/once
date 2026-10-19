// The main-world helper Java installs at document start on every tab target
// (`Page.addScriptToEvaluateOnNewDocument` without a world, wrapped as
// `(function (ONCE_LITE_TOKEN) { ... })(token)`). Three things live here
// because they need the page's own prototypes or globals: the standard
// Picture-in-Picture polyfill over Once's native presentation (the Gecko
// `pictureInPicture.js` without xray wrappers), the YouTube outer-size shim
// from `media.js`, and the answerer for content worlds' `wrappedJSObject`.
// It talks to the bridge world only through token-scoped CustomEvents.

declare const ONCE_LITE_TOKEN: string | undefined

const token = typeof ONCE_LITE_TOKEN === "string" ? ONCE_LITE_TOKEN : "once-lite"
const TO_MAIN = `once-lite:${token}:to-main`
const FROM_MAIN = `once-lite:${token}:from-main`
const ACCESS = `once-lite:${token}:access`
const ACCESS_ATTRIBUTE = `data-once-lite-${token.slice(0, 16)}`

function post(message: unknown): void {
  document.dispatchEvent(new CustomEvent(FROM_MAIN, { detail: JSON.stringify(message) }))
}

/** `wrappedJSObject.get/has/delete` from a content world, answered synchronously. */
function installAccess(): void {
  document.addEventListener(ACCESS, (event) => {
    const root = document.documentElement
    if (!root) return
    let request: { op?: string; name?: string }
    try { request = JSON.parse((event as CustomEvent<string>).detail) } catch { return }
    if (typeof request.name !== "string") return
    const scope = globalThis as unknown as Record<string, unknown>
    let answer: unknown
    if (request.op === "get") answer = scope[request.name]
    else if (request.op === "has") answer = request.name in scope
    else if (request.op === "delete") {
      try { Reflect.deleteProperty(scope, request.name) } catch { /* not deletable */ }
      answer = true
    }
    let encoded: string | undefined
    try { encoded = JSON.stringify(serializable(answer, 0)) } catch { encoded = undefined }
    if (encoded !== undefined) root.setAttribute(ACCESS_ATTRIBUTE, encoded)
  })
}

/**
 * The value as JSON can carry it: primitives and plain data as they are.
 * Anything else (the window, nodes, functions, or data holding them) reads as
 * `undefined`: a content script probing a page global it set to live objects
 * (Violentmonkey's `parent[key] = [this, 0]` vault) must see the probe fail
 * and take its event-bridge path, since no cross-world object can cross here.
 */
class NotSerializable extends Error {}

function serializable(value: unknown, depth: number): unknown {
  try {
    return serialize(value, depth)
  } catch (error) {
    if (error instanceof NotSerializable) return undefined
    throw error
  }
}

function serialize(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") throw new NotSerializable()
    return value
  }
  if (depth >= 8) throw new NotSerializable()
  if (Array.isArray(value)) return value.map((entry) => serialize(entry, depth + 1))
  const proto = Object.getPrototypeOf(value) as unknown
  if (proto !== Object.prototype && proto !== null) throw new NotSerializable()
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) out[key] = serialize((value as Record<string, unknown>)[key], depth + 1)
  return out
}

/** Keep the original video attached: moving it can restart a site's player. */
export function presentPipVideo(video: HTMLVideoElement): () => void {
  const ancestor = "data-once-pip-ancestor"
  const target = "data-once-pip-video"
  const previous: [Element, string, string | null][] = []
  for (let node: Element | null = video; node; node = node.parentElement) {
    const name = node === video ? target : ancestor
    previous.push([node, name, node.getAttribute(name)])
    node.setAttribute(name, "")
  }
  const style = document.createElement("style")
  style.textContent = `
    html { background: black !important; }
    body * { visibility: hidden !important; }
    [${ancestor}] { transform: none !important; perspective: none !important;
      filter: none !important; contain: none !important; will-change: auto !important;
      overflow: visible !important; clip-path: none !important; }
    video[${target}] { visibility: visible !important; display: block !important;
      position: fixed !important; inset: 0 !important; width: 100vw !important;
      height: 100vh !important; min-width: 0 !important; min-height: 0 !important;
      max-width: none !important; max-height: none !important; margin: 0 !important;
      padding: 0 !important; border: 0 !important; border-radius: 0 !important;
      object-fit: contain !important; transform: none !important;
      z-index: 2147483647 !important; background: black !important; }
  `
  document.documentElement.append(style)
  const controls = video.controls
  video.controls = false
  return () => {
    style.remove()
    video.controls = controls
    for (const [node, name, value] of previous) {
      if (value === null) node.removeAttribute(name)
      else node.setAttribute(name, value)
    }
  }
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  video: HTMLVideoElement
  action: "enter" | "exit"
}

/** The standard PiP interface over Once's native presentation. */
export class PictureInPicturePolyfill {
  available = false
  active: HTMLVideoElement | null = null
  private sequence = 0
  private readonly pending = new Map<number, Pending>()
  private readonly restores: (() => void)[] = []
  private restorePresentation: (() => void) | null = null
  readonly pipWindow = new EventTarget()
  private size = { width: 0, height: 0 }

  constructor() {
    const request = (video: HTMLVideoElement): Promise<unknown> => this.request(video)
    for (const key of ["width", "height"] as const) this.define(this.pipWindow, key, { get: () => this.size[key] })
    this.define(Document.prototype, "pictureInPictureEnabled", { get: () => this.available })
    this.define(Document.prototype, "pictureInPictureElement", { get: () => this.active })
    this.define(Document.prototype, "exitPictureInPicture", { value: () => this.exit() })
    this.define(HTMLVideoElement.prototype, "requestPictureInPicture", {
      value: function (this: HTMLVideoElement) { return request(this) }
    })
    this.define(HTMLVideoElement.prototype, "disablePictureInPicture", {
      get: function (this: HTMLVideoElement) { return this.hasAttribute("disablepictureinpicture") },
      set: function (this: HTMLVideoElement, value: unknown) { this.toggleAttribute("disablepictureinpicture", Boolean(value)) }
    })
    for (const name of ["enterpictureinpicture", "leavepictureinpicture"]) this.handler(HTMLVideoElement.prototype, name)
    this.handler(this.pipWindow, "resize")
  }

  private define(owner: object, key: string, descriptor: PropertyDescriptor): void {
    const old = Object.getOwnPropertyDescriptor(owner, key)
    const next: PropertyDescriptor = { configurable: true, enumerable: true, ...descriptor }
    if ("value" in next) next.writable = true
    Object.defineProperty(owner, key, next)
    this.restores.push(() => {
      if (old) Object.defineProperty(owner, key, old)
      else Reflect.deleteProperty(owner, key)
    })
  }

  private handler(owner: object, name: string): void {
    const handlers = new WeakMap<object, EventListener>()
    this.define(owner, `on${name}`, {
      get: function (this: EventTarget) { return handlers.get(this) ?? null },
      set: function (this: EventTarget, next: unknown) {
        const previous = handlers.get(this)
        if (previous) this.removeEventListener(name, previous)
        if (typeof next === "function") { handlers.set(this, next as EventListener); this.addEventListener(name, next as EventListener) }
        else handlers.delete(this)
      }
    })
  }

  private reject(name: string, message: string): Promise<never> {
    return Promise.reject(new DOMException(message, name))
  }

  request(video: HTMLVideoElement): Promise<unknown> {
    if (!(video instanceof HTMLVideoElement) || video.ownerDocument !== document) {
      return this.reject("TypeError", "PiP requires a video in this document")
    }
    if (!this.available) return this.reject("NotSupportedError", "Native PiP is unavailable")
    if (!video.isConnected || video.readyState === 0 || !video.videoWidth || video.hasAttribute("disablepictureinpicture")) {
      return this.reject("InvalidStateError", "The video is not ready for PiP")
    }
    const policy = (document as Document & { featurePolicy?: { features(): string[]; allowsFeature(name: string): boolean } }).featurePolicy
    if (policy?.features().includes("picture-in-picture") && !policy.allowsFeature("picture-in-picture")) {
      return this.reject("SecurityError", "PiP is disabled by this document's policy")
    }
    if (!this.active && !navigator.userActivation.isActive) return this.reject("NotAllowedError", "PiP requires a user gesture")
    if (this.pending.size) return this.reject("InvalidStateError", "A PiP transition is already pending")
    if (this.active === video) return Promise.resolve(this.pipWindow)
    const rect = video.getBoundingClientRect()
    return this.command("enter", video, { width: video.videoWidth, height: video.videoHeight,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight } })
  }

  exit(): Promise<unknown> {
    if (!this.active) return this.reject("InvalidStateError", "This document is not in PiP")
    if (this.pending.size) return this.reject("InvalidStateError", "A PiP transition is already pending")
    return this.command("exit", this.active)
  }

  private command(action: "enter" | "exit", video: HTMLVideoElement, data: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      if (action === "enter" && !this.active) this.restorePresentation = presentPipVideo(video)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.clearPreparedPresentation()
        reject(new DOMException("Native PiP did not respond", "AbortError"))
      }, 12000)
      this.pending.set(id, { resolve, reject, timer, video, action })
      post({ type: "pip-request", id, action, ...data })
    })
  }

  message(message: Record<string, unknown>): void {
    if (message.type === "pip-capability") {
      this.available = message.enabled === true
      window.dispatchEvent(new Event("once-pip-ready"))
    } else if (message.type === "pip-state") {
      this.state(message as { enabled?: boolean; width: number; height: number; direct?: boolean })
    } else if (message.type === "pip-result") {
      const pending = this.pending.get(message.id as number)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id as number)
      if (message.error) {
        this.clearPreparedPresentation()
        pending.reject(new DOMException(String(message.error), typeof message.name === "string" ? message.name : "AbortError"))
      } else pending.resolve(pending.action === "enter" ? this.pipWindow : undefined)
    }
  }

  private state(message: { enabled?: boolean; width: number; height: number; direct?: boolean }): void {
    const resized = this.size.width !== message.width || this.size.height !== message.height
    this.size = { width: message.width, height: message.height }
    const pending = [...this.pending.values()].find((request) => request.action === "enter")
    const next = message.enabled ? pending?.video ?? this.active ?? document.querySelector("video") : null
    if (!next) this.clearPreparedPresentation()
    if (this.active !== next) {
      const previous = this.active
      if (previous) {
        this.restorePresentation?.()
        this.restorePresentation = null
      }
      this.active = next
      if (previous) this.event(previous, "leavepictureinpicture")
      if (next) this.event(next, "enterpictureinpicture")
    }
    if (next && message.direct && !this.restorePresentation) this.restorePresentation = presentPipVideo(next)
    if (resized) this.pipWindow.dispatchEvent(new Event("resize"))
  }

  private event(video: HTMLVideoElement, name: string): void {
    const event = new Event(name)
    Object.defineProperty(event, "pictureInPictureWindow", { value: this.pipWindow })
    video.dispatchEvent(event)
  }

  private clearPreparedPresentation(): void {
    if (this.active) return
    this.restorePresentation?.()
    this.restorePresentation = null
  }
}

/** YouTube guesses PiP from the outer window area; report the screen's while in PiP. */
function installYoutubeShim(): (pictureInPicture: boolean) => void {
  let pictureInPicture = false
  if (!/(^|\.)youtube(?:-nocookie)?\.com$/.test(location.hostname)) return () => undefined
  for (const [key, dimension] of [["outerWidth", "width"], ["outerHeight", "height"]] as const) {
    const original = Object.getOwnPropertyDescriptor(window, key)
    if (!original?.configurable) continue
    Object.defineProperty(window, key, {
      configurable: true, enumerable: original.enumerable, set: original.set,
      get: () => pictureInPicture ? window.screen[dimension] : original.get ? Reflect.apply(original.get, window, []) : original.value
    })
  }
  return (value) => { pictureInPicture = value }
}

export function installMainHelper(): void {
  if (window !== window.top) return
  installAccess()
  const youtube = installYoutubeShim()
  const polyfill = typeof HTMLVideoElement.prototype.requestPictureInPicture === "function" ? null : new PictureInPicturePolyfill()
  document.addEventListener(TO_MAIN, (event) => {
    let message: Record<string, unknown>
    try { message = JSON.parse((event as CustomEvent<string>).detail) } catch { return }
    if (message.type === "media-observe") youtube(message.pictureInPicture === true)
    else polyfill?.message(message)
  })
}

installMainHelper()
