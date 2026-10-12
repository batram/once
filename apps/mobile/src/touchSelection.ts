import { Capacitor, registerPlugin } from "@capacitor/core"

interface TouchSelectionPlugin {
  tapAt(options: { x: number; y: number }): Promise<void>
}

let plugin: TouchSelectionPlugin | null | undefined

/**
 * Selects the word under a double tap the way GeckoView pages do. The shell's
 * WebView selects text only on a long press, and a selection made by script
 * gets no handles or copy menu; but Chromium shows both for a touch tap
 * inside a selection that has none. So the word is selected here, and the
 * native side taps it. `allowed` says where a double tap is about text
 * rather than a control.
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
    if (!touch || !taps[0] || !taps[1] || !selectWordAt(event.clientX, event.clientY)) return
    const scale = window.devicePixelRatio
    void native.tapAt({ x: event.clientX * scale, y: event.clientY * scale })
      .catch(error => console.warn("Double-tap selection unavailable", error))
  })
}

/** Whether a word was selected: a tap on nothing selected would only set the caret. */
function selectWordAt(x: number, y: number): boolean {
  const caret = document.caretPositionFromPoint?.(x, y)
  const selection = window.getSelection()
  if (!caret || !selection) return false
  selection.collapse(caret.offsetNode, caret.offset)
  selection.modify("move", "backward", "word")
  selection.modify("extend", "forward", "word")
  return !selection.isCollapsed
}
