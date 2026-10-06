import { attachEdgeSwipe, showEdgeSwipeProgress, type EdgeSwipeDirection } from "./edgeSwipe"

/**
 * Edge swipes over the sandboxed Reader frame. Its touches never reach the
 * shell document, and the native page view, which has edge gestures of its
 * own, is hidden while Reader mode shows. The frame detects the swipe and the
 * shell draws it and moves through history, as for any other edge swipe.
 */
export const READER_EDGE_SWIPE_CHANNEL = "once-reader-edge-swipe"

interface ReaderEdgeSwipeMessage {
  channel: typeof READER_EDGE_SWIPE_CHANNEL
  direction: EdgeSwipeDirection | null
  progress: number
  commit: boolean
}

/** Frame half. Android has a system Back gesture, so only iOS needs it. */
export function installReaderEdgeSwipe(target: Window): void {
  if (/Android/i.test(target.navigator.userAgent)) return
  const post = (direction: EdgeSwipeDirection | null, progress: number, commit = false): void => {
    const message: ReaderEdgeSwipeMessage = { channel: READER_EDGE_SWIPE_CHANNEL, direction, progress, commit }
    target.parent.postMessage(message, "*")
  }
  attachEdgeSwipe({
    onBack: () => post("back", 1, true),
    onForward: () => post("forward", 1, true),
    onProgress: (direction, progress) => post(direction, progress)
  })
}

/** Host half: draws the frame's swipe and carries out a committed one. */
export function installReaderEdgeSwipeHost(
  isReaderWindow: (source: MessageEventSource | null) => boolean,
  step: (direction: EdgeSwipeDirection) => void,
  host: Pick<Window, "addEventListener"> = window
): void {
  host.addEventListener("message", (event) => {
    const data = event.data as Partial<ReaderEdgeSwipeMessage> | null
    if (data?.channel !== READER_EDGE_SWIPE_CHANNEL || !isReaderWindow(event.source)) return
    const direction = data.direction === "back" || data.direction === "forward" ? data.direction : null
    if (data.commit && direction) {
      showEdgeSwipeProgress(null, 0)
      step(direction)
      return
    }
    showEdgeSwipeProgress(direction, Number(data.progress) || 0)
  })
}
