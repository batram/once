import type { ElectronBridge, ElectronTabState } from "@once/platform-electron/bridge"
import type { ReaderRequests } from "../ReaderRequests"
import { isReadableUrl, readerErrorMessage, sourceUrlFromReaderUrl } from "./reader-url"

export interface ReaderButtonShell {
  bridge: ElectronBridge
  requests: ReaderRequests
  active(): ElectronTabState | null
  setError(message: string): void
}

/**
 * The toolbar's Reader mode button. A plain click switches the active tab
 * between its page and the reader. Ctrl+click (Cmd on macOS) and a middle
 * click open the other side in a background tab instead, as they do for a link,
 * so the page on screen stays where it is.
 */
export function bindReaderButton(button: HTMLButtonElement, shell: ReaderButtonShell): void {
  const press = (beside: boolean) => {
    const active = shell.active()
    if (!active) return
    shell.setError("")
    const readerSource = sourceUrlFromReaderUrl(active.url)
    if (readerSource) {
      if (beside) { void shell.bridge.tabs.openUrl(readerSource, "middle"); return }
      shell.requests.cancel(active.id)
      void shell.bridge.tabs.navigate(active.id, readerSource).catch((error) => shell.setError(readerErrorMessage(error)))
      return
    }
    if (!isReadableUrl(active.url)) return
    if (beside) shell.requests.openBeside(active.url)
    else shell.requests.start(active.id, active.url)
  }
  button.onclick = (event) => press(event.ctrlKey || event.metaKey)
  // A middle press would otherwise start autoscrolling the shell.
  button.onmousedown = (event) => { if (event.button === 1) event.preventDefault() }
  button.onauxclick = (event) => {
    if (event.button !== 1 || button.disabled) return
    event.preventDefault()
    press(true)
  }
}
