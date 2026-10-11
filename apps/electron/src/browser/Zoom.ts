// Page zoom for the shell and for tabs, from the keyboard and Ctrl+wheel.
//
// Electron's default menu has zoom accelerators, but its zoom-in is
// "CmdOrCtrl+Plus", which Electron reads as Shift plus the US "=" key. On a
// German layout "+" has its own unshifted key, so Ctrl and "+" never matched
// while Ctrl+- and Ctrl+0 did. Matching on the character the key produced
// covers every layout and the numpad alike. Ctrl+wheel is not applied by
// Electron at all: it only reports the request as "zoom-changed".

// Chromium's own zoom steps, so the levels match what a browser offers.
const ZOOM_FACTORS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

export type ZoomStep = "in" | "out" | "reset"

/** Within the range the keys step through; Chromium itself goes no further. */
export function isZoomFactor(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= ZOOM_FACTORS[0] && value <= ZOOM_FACTORS[ZOOM_FACTORS.length - 1]
}

/** The zoom step a key press asks for, or null when it is not a zoom key. */
export function zoomStepFor(input: Electron.Input): ZoomStep | null {
  if (input.type !== "keyDown" || input.alt) return null
  if (!(process.platform === "darwin" ? input.meta : input.control)) return null
  // "=" is the unshifted "+" key on US layouts, where browsers zoom on it too.
  if (input.key === "+" || input.key === "=") return "in"
  if (input.key === "-") return "out"
  if (input.key === "0" && !input.shift) return "reset"
  return null
}

export function applyZoomStep(contents: Electron.WebContents, step: ZoomStep): void {
  if (contents.isDestroyed()) return
  if (step === "reset") {
    contents.setZoomFactor(1)
    return
  }
  const current = contents.getZoomFactor()
  // A small tolerance, so a factor stored as 0.33333 still counts as 1/3.
  const next = step === "in"
    ? ZOOM_FACTORS.find((factor) => factor > current + 0.001)
    : [...ZOOM_FACTORS].reverse().find((factor) => factor < current - 0.001)
  if (next !== undefined) contents.setZoomFactor(next)
}

/** Handles a zoom key; true when the key was one and must not go further. */
export function handleZoomKey(
  contents: Electron.WebContents,
  event: Electron.Event,
  input: Electron.Input
): boolean {
  const step = zoomStepFor(input)
  if (!step) return false
  event.preventDefault()
  applyZoomStep(contents, step)
  return true
}

// The shell reports rects and points in its own CSS pixels, while views, menus
// and popups are placed in window pixels. They differ by the shell's zoom.
// Anything malformed is passed through for the caller's validation to reject.

/** A point from the shell, in window pixels. */
export function shellPoint<T>(shell: Electron.WebContents, point: T): T {
  if (!point || typeof point !== "object") return point
  const factor = shell.getZoomFactor()
  const { x, y } = point as { x: number; y: number }
  return { ...point, x: Math.round(x * factor), y: Math.round(y * factor) }
}

/**
 * A rect from the shell, in window pixels. The edges are rounded rather than
 * the size, so a view laid against the window's edge still reaches it.
 */
export function shellRect<T>(shell: Electron.WebContents, rect: T): T {
  if (!rect || typeof rect !== "object") return rect
  const factor = shell.getZoomFactor()
  const { x, y, width, height } = rect as { x: number; y: number; width: number; height: number }
  const left = Math.round(x * factor)
  const top = Math.round(y * factor)
  return {
    ...rect,
    x: left,
    y: top,
    width: Math.round((x + width) * factor) - left,
    height: Math.round((y + height) * factor) - top
  }
}

/** Ctrl+wheel, which Electron reports but leaves to the app to apply. */
export function bindWheelZoom(contents: Electron.WebContents): void {
  contents.on("zoom-changed", (_event, direction) => {
    applyZoomStep(contents, direction === "in" ? "in" : "out")
  })
}
