/* global exportFunction, XPCNativeWrapper, presentOncePipVideo */
// GeckoView disables its unfinished Android web PiP API. Supply the standard
// video interface using Once's native presentation, without DOM fullscreen.
class OncePictureInPicture {
  constructor(port) {
    this.port = port
    this.page = window.wrappedJSObject
    this.available = false
    this.active = null
    this.sequence = 0
    this.pending = new Map()
    this.restores = []
    this.window = new this.page.EventTarget()
    this.size = { width: 0, height: 0 }
    for (const key of ["width", "height"]) this.define(this.window, key, { get: () => this.size[key] })
    this.define(this.page.Document.prototype, "pictureInPictureEnabled", { get: () => this.available })
    this.define(this.page.Document.prototype, "pictureInPictureElement", { get: () => this.active?.wrappedJSObject ?? null })
    this.define(this.page.Document.prototype, "exitPictureInPicture", { value: () => this.exit() })
    const request = this.request.bind(this)
    this.define(this.page.HTMLVideoElement.prototype, "requestPictureInPicture", {
      value: function () { return request(new XPCNativeWrapper(this)) }
    })
    this.define(this.page.HTMLVideoElement.prototype, "disablePictureInPicture", {
      get: function () { return this.hasAttribute("disablepictureinpicture") },
      set: function (value) { this.toggleAttribute("disablepictureinpicture", Boolean(value)) }
    })
    for (const name of ["enterpictureinpicture", "leavepictureinpicture"]) this.handler(this.page.HTMLVideoElement.prototype, name)
    this.handler(this.window, "resize")
    this.receive = message => this.message(message)
    port.onMessage.addListener(this.receive)
  }

  define(owner, key, descriptor) {
    const old = Object.getOwnPropertyDescriptor(owner, key)
    const next = { configurable: true, enumerable: true }
    for (const [name, value] of Object.entries(descriptor)) next[name] = exportFunction(value, this.page)
    if ("value" in next) next.writable = true
    Object.defineProperty(owner, key, next)
    this.restores.push(() => {
      if (old) Object.defineProperty(owner, key, old)
      else Reflect.deleteProperty(owner, key)
    })
  }

  handler(owner, name) {
    const handlers = new WeakMap()
    this.define(owner, `on${name}`, {
      get: function () { return handlers.get(this) ?? null },
      set: function (next) {
        const previous = handlers.get(this)
        if (previous) this.removeEventListener(name, previous)
        if (typeof next === "function") { handlers.set(this, next); this.addEventListener(name, next) }
        else handlers.delete(this)
      }
    })
  }

  reject(name, message) { return this.page.Promise.reject(new this.page.DOMException(message, name)) }

  request(video) {
    if (!(video instanceof HTMLVideoElement) || video.ownerDocument !== document) {
      return this.reject("TypeError", "PiP requires a video in this document")
    }
    if (!this.available) return this.reject("NotSupportedError", "Native PiP is unavailable")
    if (!video.isConnected || video.readyState === 0 || !video.videoWidth || video.hasAttribute("disablepictureinpicture")) {
      return this.reject("InvalidStateError", "The video is not ready for PiP")
    }
    const policy = document.featurePolicy
    if (policy?.features().includes("picture-in-picture") && !policy.allowsFeature("picture-in-picture")) {
      return this.reject("SecurityError", "PiP is disabled by this document's policy")
    }
    if (!this.active && !navigator.userActivation.isActive) return this.reject("NotAllowedError", "PiP requires a user gesture")
    if (this.pending.size) return this.reject("InvalidStateError", "A PiP transition is already pending")
    if (this.active === video) return this.page.Promise.resolve(this.window)
    const rect = video.getBoundingClientRect()
    return this.command("enter", video, { width: video.videoWidth, height: video.videoHeight,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight } })
  }

  exit() {
    if (!this.active) return this.reject("InvalidStateError", "This document is not in PiP")
    if (this.pending.size) return this.reject("InvalidStateError", "A PiP transition is already pending")
    return this.command("exit", this.active)
  }

  command(action, video, data = {}) {
    const id = ++this.sequence
    return new this.page.Promise(exportFunction((resolve, reject) => {
      // Prepare the same video before Android captures its entry animation.
      // Waiting for pip-state briefly shrinks the entire browser page instead.
      if (action === "enter" && !this.active) this.restorePresentation = presentOncePipVideo(video)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.clearPreparedPresentation()
        reject(new this.page.DOMException("Native PiP did not respond", "AbortError"))
      }, 12000)
      this.pending.set(id, { resolve, reject, timer, video, action })
      try { this.port.postMessage({ type: "pip-request", id, action, ...data }) }
      catch {
        clearTimeout(timer)
        this.pending.delete(id)
        this.clearPreparedPresentation()
        reject(new this.page.DOMException("The page disconnected", "AbortError"))
      }
    }, this.page))
  }

  message(message) {
    if (message?.type === "pip-capability") {
      this.available = message.enabled === true
      window.dispatchEvent(new Event("once-pip-ready"))
    } else if (message?.type === "pip-state") {
      this.state(message)
    } else if (message?.type === "pip-result") {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) {
        this.clearPreparedPresentation()
        pending.reject(new this.page.DOMException(message.error, message.name || "AbortError"))
      }
      else pending.resolve(pending.action === "enter" ? this.window : undefined)
    }
  }

  state(message) {
    const resized = this.size.width !== message.width || this.size.height !== message.height
    this.size = { width: message.width, height: message.height }
    const pending = [...this.pending.values()].find(request => request.action === "enter")
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
      if (next) {
        this.event(next, "enterpictureinpicture")
      }
    }
    if (next && message.direct && !this.restorePresentation) this.restorePresentation = presentOncePipVideo(next)
    if (resized) this.window.dispatchEvent(new this.page.Event("resize"))
  }

  event(video, name) {
    const event = new this.page.Event(name)
    Object.defineProperty(event, "pictureInPictureWindow", { value: this.window })
    video.dispatchEvent(event)
  }

  clearPreparedPresentation() {
    if (this.active) return
    this.restorePresentation?.()
    this.restorePresentation = null
  }

  disconnect() {
    this.state({ enabled: false, width: 0, height: 0 })
    this.available = false
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new this.page.DOMException("The page disconnected", "AbortError"))
    }
    this.pending.clear()
    this.port.onMessage.removeListener(this.receive)
    for (const restore of this.restores.reverse()) restore()
  }
}

globalThis.installOncePictureInPicture = function (port) {
  if (!window.wrappedJSObject || typeof exportFunction !== "function" ||
      typeof window.wrappedJSObject.HTMLVideoElement.prototype.requestPictureInPicture === "function") return () => {}
  const api = new OncePictureInPicture(port)
  return () => api.disconnect()
}
