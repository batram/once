import { Capacitor, registerPlugin } from "@capacitor/core"

interface TouchSelectionPlugin {
  longPressAt(options: { x: number; y: number }): Promise<void>
}

let plugin: TouchSelectionPlugin | null | undefined

/**
 * Selects the word under a double tap the way GeckoView pages do. The shell's
 * WebView only selects on a long press, and a selection made by script gets
 * no handles or copy menu, so the native side replays the tap as a long press.
 * `allowed` says where a double tap is about text rather than a control.
 */
export function selectOnDoubleTap(root: HTMLElement, allowed: (target: Element) => boolean): void {
  plugin ??= Capacitor.getPlatform() === "android" ? registerPlugin<TouchSelectionPlugin>("TouchSelection") : null
  if (!plugin) return
  const native = plugin
  // Both taps must land on text: a first tap that opened a collapsed comment
  // leaves text under the second, but that double tap was about opening it.
  let touch = false
  let taps = [false, false]
  root.addEventListener("pointerdown", event => {
    touch = event.pointerType === "touch"
    taps = [taps[1], event.target instanceof Element && allowed(event.target)]
  })
  root.addEventListener("dblclick", event => {
    if (!touch || !taps[0] || !taps[1]) return
    // The long press needs the system's timeout (half a second) before Chromium
    // selects; the word lights up now, and the native selection replaces this
    // one, handles and copy menu included, when it lands.
    selectWordAt(event.clientX, event.clientY)
    const scale = window.devicePixelRatio
    void native.longPressAt({ x: event.clientX * scale, y: event.clientY * scale })
      .catch(error => console.warn("Double-tap selection unavailable", error))
  })
}

function selectWordAt(x: number, y: number): void {
  const caret = document.caretPositionFromPoint?.(x, y)
  const selection = window.getSelection()
  if (!caret || !selection) return
  selection.collapse(caret.offsetNode, caret.offset)
  selection.modify("move", "backward", "word")
  selection.modify("extend", "forward", "word")
}
