// Keep the original video attached: moving it can restart a site's player.
globalThis.presentOncePipVideo = function (video) {
  const ancestor = "data-once-pip-ancestor"
  const target = "data-once-pip-video"
  const previous = []
  for (let node = video; node; node = node.parentElement) {
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
