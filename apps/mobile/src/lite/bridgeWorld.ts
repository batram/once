// Once's own world (`once-bridge`) in every tab target: what the Gecko
// bridge extension's content script did, over the `onceLiteBridge` DevTools
// binding instead of a native-messaging port, with the same Java-facing
// message names (PageScriptCalls, ReadingPip, BackgroundMedia,
// ImageTextOverlays reuse their handlers). Java wraps the bundle as
// `(function (ONCE_LITE_TOKEN) { ... })(token)` so the main-world helper
// and this world share the event channel's token.
//
// `{id, code}` evaluations run in this world (the page's DOM, not its
// scripts) and answer `{id, value}` with `value` JSON-encoded as the WebView
// would. Media snapshots are read from the shared DOM here; the YouTube
// outer-size shim and the PiP polyfill need the page's own prototypes, so
// they live in the main-world helper and are relayed through token-scoped
// CustomEvents on `document`.

import { BRIDGE_BINDING, BRIDGE_DELIVER } from "./protocol"

declare const ONCE_LITE_TOKEN: string | undefined

type Message = Record<string, unknown> & { type?: string; id?: number; code?: string }

const token = typeof ONCE_LITE_TOKEN === "string" ? ONCE_LITE_TOKEN : "once-lite"
/** Bridge world → main helper. */
const TO_MAIN = `once-lite:${token}:to-main`
/** Main helper → bridge world. */
const FROM_MAIN = `once-lite:${token}:from-main`

const MEDIA_EVENTS = ["play", "playing", "pause", "ended", "emptied", "seeked", "durationchange", "loadedmetadata", "ratechange", "yt-navigate-finish"]

/** The HTML-media fallback of the Gecko bridge, reading the shared DOM. */
export function installMediaBridge(post: (message: unknown) => void): { receive(message: Message): void; cleanup(): void } {
  const youtube = /(^|\.)youtube(?:-nocookie)?\.com$/.test(location.hostname)
  let enabled = false
  let lastSent = 0
  let selected: HTMLMediaElement | null = null
  const video = (): HTMLMediaElement | null => selected?.isConnected ? selected :
    (youtube && document.querySelector<HTMLMediaElement>("video.html5-main-video")) || document.querySelector<HTMLMediaElement>("video, audio")
  const seekable = (media: HTMLMediaElement): boolean => Number.isFinite(media.duration) && media.duration > 0 &&
    media.seekable.length > 0 && !(youtube && document.querySelector(".ad-showing, .ad-interrupting"))
  const text = (selector: string): string => (document.querySelector(selector)?.textContent || "").trim().slice(0, 300)
  const send = (force = false): void => {
    if (!enabled || (!force && Date.now() - lastSent < 1000)) return
    const media = video()
    if (!media) return
    lastSent = Date.now()
    const title = youtube ? text("ytm-slim-video-metadata-section-renderer h1, ytd-watch-metadata h1, h1.title") ||
      document.title.replace(/\s*-\s*YouTube\s*$/, "").slice(0, 300) : document.title.slice(0, 300)
    const artist = youtube ? text("ytm-slim-owner-renderer .slim-owner-channel-name, ytd-video-owner-renderer #channel-name a, ytm-video-owner-renderer .yt-core-attributed-string") : ""
    const frame = media as HTMLVideoElement
    post({ type: "media-snapshot", url: location.href, title, artist,
      playing: !media.paused && !media.ended,
      duration: Number.isFinite(media.duration) ? media.duration : null,
      position: media.currentTime, rate: media.playbackRate, seekable: seekable(media),
      videoWidth: frame.videoWidth || 0, videoHeight: frame.videoHeight || 0 })
  }
  const changed = (event: Event): void => {
    const target = event.target as HTMLElement | null
    if (target && ["AUDIO", "VIDEO"].includes(target.tagName) && (!selected || event.type === "play" || event.type === "playing")) {
      selected = target as HTMLMediaElement
    }
    send(true)
  }
  const pagehide = (): void => {
    if (enabled) post({ type: "media-snapshot", url: location.href, title: "", artist: "", playing: false, duration: null, position: 0, rate: 1, seekable: false, videoWidth: 0, videoHeight: 0 })
  }
  window.addEventListener("pagehide", pagehide)
  const progress = (): void => send()
  for (const name of MEDIA_EVENTS) document.addEventListener(name, changed, true)
  document.addEventListener("timeupdate", progress, true)
  return {
    receive(message) {
      if (message.type === "media-observe") {
        enabled = message.enabled === true
        document.dispatchEvent(new CustomEvent(TO_MAIN, { detail: JSON.stringify({ type: "media-observe", pictureInPicture: message.pictureInPicture === true }) }))
        send(true)
      } else if (message.type === "media-command" && (message.url === undefined || message.url === location.href)) {
        const media = video()
        if (!media) return
        if (message.action === "play") {
          const started = media.play()
          if (started && typeof started.catch === "function") started.catch(() => undefined)
        } else if (message.action === "pause") {
          media.pause()
        } else if (message.action === "seek" && seekable(media) && typeof message.position === "number" && Number.isFinite(message.position)) {
          media.currentTime = Math.max(0, Math.min(message.position, media.duration))
        }
        send(true)
      }
    },
    cleanup() {
      enabled = false
      for (const name of MEDIA_EVENTS) document.removeEventListener(name, changed, true)
      document.removeEventListener("timeupdate", progress, true)
      window.removeEventListener("pagehide", pagehide)
    }
  }
}

function encode(value: unknown): string {
  try {
    const encoded = JSON.stringify(value === undefined ? null : value)
    return typeof encoded === "string" ? encoded : "null"
  } catch {
    return "null"
  }
}

export function installBridgeWorld(scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  if (window !== window.top) return
  const binding = scope[BRIDGE_BINDING] as ((payload: string) => void) | undefined
  if (typeof binding !== "function") return
  const post = (message: unknown): void => binding(JSON.stringify(message))
  let restored = false
  let media = installMediaBridge(post)
  // The PiP polyfill lives in the main world; its requests and the app's
  // answers pass through here unchanged.
  document.addEventListener(FROM_MAIN, (event) => {
    const detail = (event as CustomEvent<string>).detail
    try { post(JSON.parse(detail)) } catch { /* not ours */ }
  })
  ;(scope as Record<string, unknown>).__onceImageTextPush = (payload: unknown) => post({ type: "image-text", payload: String(payload) })
  let lastTap: { image: Element; at: number; x: number; y: number } | null = null
  window.addEventListener("click", (event) => {
    const image = event.target
    const tap = image instanceof HTMLImageElement ? { image, at: event.timeStamp, x: event.clientX, y: event.clientY } : null
    const previous = lastTap
    lastTap = event.isTrusted && tap ? tap : null
    if (!lastTap || !tap || previous?.image !== tap.image || tap.at - previous.at > 400 ||
      Math.hypot(tap.x - previous.x, tap.y - previous.y) > 40) return
    lastTap = null
    const src = tap.image.currentSrc || tap.image.src
    if (src) post({ type: "image-text-request", image: src, referrer: document.baseURI })
  }, true)
  scope[BRIDGE_DELIVER] = (json: string) => {
    let message: Message
    try { message = JSON.parse(json) } catch { return }
    if (!message || typeof message !== "object") return
    if (message.type === "health") {
      post({ type: "health", id: message.id, url: location.href, readyState: document.readyState, restored, context: null })
      return
    }
    if (message.type === "media-observe" || message.type === "media-command") {
      media.receive(message)
      return
    }
    if (typeof message.type === "string" && message.type.startsWith("pip-")) {
      document.dispatchEvent(new CustomEvent(TO_MAIN, { detail: json }))
      return
    }
    if (typeof message.id !== "number" || typeof message.code !== "string") return
    let value: unknown
    try {
      value = (0, eval)(message.code)
    } catch (error) {
      post({ id: message.id, error: String(error) })
      return
    }
    post({ id: message.id, value: encode(value) })
  }
  window.addEventListener("pagehide", () => {
    (scope.__onceImageText as { close?(): void } | undefined)?.close?.()
    media.cleanup()
  })
  window.addEventListener("pageshow", (event) => {
    restored = event.persisted === true
    media = installMediaBridge(post)
    post({ type: "health", id: 0, url: location.href, readyState: document.readyState, restored, context: null })
  })
  post({ type: "health", id: 0, url: location.href, readyState: document.readyState, restored, context: null })
}

installBridgeWorld()
