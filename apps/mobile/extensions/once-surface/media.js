/* global exportFunction */
// Small HTML-media fallback; YouTube adds title/channel selectors. Native Gecko data wins.
globalThis.installOnceMediaBridge = function (port) {
  const host = location.hostname
  const youtube = /(^|\.)youtube(?:-nocookie)?\.com$/.test(host)
  let enabled = false
  let lastSent = 0
  let selected = null
  let pictureInPicture = false
  const restoreWindow = []
  // Mobile YouTube guesses PiP from outer-window area, then exits fullscreen
  // and pauses. Native PiP owns that transition; preserve the reported outer
  // screen bounds while leaving the actual video viewport responsive.
  if (youtube && typeof window !== "undefined" && window.wrappedJSObject && typeof exportFunction === "function") {
    const page = window.wrappedJSObject
    for (const [key, dimension] of [["outerWidth", "width"], ["outerHeight", "height"]]) {
      const original = Object.getOwnPropertyDescriptor(page, key)
      if (!original?.configurable) continue
      const getter = exportFunction(() => pictureInPicture ? window.screen[dimension] :
        original.get ? Reflect.apply(original.get, page, []) : original.value, page)
      Object.defineProperty(page, key, { configurable: true, enumerable: original.enumerable, get: getter, set: original.set })
      restoreWindow.push(() => {
        if (Object.getOwnPropertyDescriptor(page, key)?.get === getter) Object.defineProperty(page, key, original)
      })
    }
  }
  const video = () => selected?.isConnected ? selected :
    (youtube && document.querySelector("video.html5-main-video")) || document.querySelector("video, audio")
  const seekable = media => Number.isFinite(media.duration) && media.duration > 0 &&
    media.seekable.length > 0 && !(youtube && document.querySelector(".ad-showing, .ad-interrupting"))
  const text = selector => (document.querySelector(selector)?.textContent || "").trim().slice(0, 300)

  const send = (force = false) => {
    if (!enabled || (!force && Date.now() - lastSent < 1000)) return
    const media = video()
    if (!media) return
    lastSent = Date.now()
    const title = youtube ? text("ytm-slim-video-metadata-section-renderer h1, ytd-watch-metadata h1, h1.title") ||
      document.title.replace(/\s*-\s*YouTube\s*$/, "").slice(0, 300) : document.title.slice(0, 300)
    const artist = youtube ? text("ytm-slim-owner-renderer .slim-owner-channel-name, ytd-video-owner-renderer #channel-name a, ytm-video-owner-renderer .yt-core-attributed-string") : ""
    port.postMessage({ type: "media-snapshot", url: location.href, title, artist,
      duration: Number.isFinite(media.duration) ? media.duration : null,
      position: media.currentTime, rate: media.playbackRate, seekable: seekable(media) })
  }

  const changed = event => {
    if (["AUDIO", "VIDEO"].includes(event?.target?.tagName) && (!selected || event.type === "play")) selected = event.target
    send(true)
  }
  const progress = () => send()
  for (const name of ["play", "pause", "seeked", "durationchange", "loadedmetadata", "ratechange", "yt-navigate-finish"]) {
    document.addEventListener(name, changed, true)
  }
  document.addEventListener("timeupdate", progress, true)
  port.onMessage.addListener(message => {
    if (message?.type === "media-observe") {
      enabled = message.enabled === true
      pictureInPicture = message.pictureInPicture === true
      send(true)
    } else if (enabled && message?.type === "media-command" && message.url === location.href) {
      const media = video()
      if (message.action === "seek" && media && seekable(media) && Number.isFinite(message.position)) {
        media.currentTime = Math.max(0, Math.min(message.position, media.duration))
        send(true)
      }
    }
  })
  const cleanup = () => {
    enabled = false
    pictureInPicture = false
    for (const restore of restoreWindow) restore()
    for (const name of ["play", "pause", "seeked", "durationchange", "loadedmetadata", "ratechange", "yt-navigate-finish"]) {
      document.removeEventListener(name, changed, true)
    }
    document.removeEventListener("timeupdate", progress, true)
  }
  port.onDisconnect.addListener(cleanup)
  return cleanup
}
