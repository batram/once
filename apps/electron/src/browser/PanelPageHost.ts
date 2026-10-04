import { ElectronBridge, ElectronRect } from "@once/platform-electron/bridge"
import type { PanelPageHost } from "@once/ui-web"

/**
 * Pages inside the panel as main's native view over the panel's body, rather
 * than an iframe in the shell: the view shares the tabs' session, so the
 * reader is signed in and extensions apply. The body only keeps the room; its
 * rect follows every layout change, and an empty one (the panel hidden or
 * collapsed) hides the view.
 */
export function electronPanelPages(bridge: ElectronBridge): PanelPageHost {
  return {
    mount(body, url, events) {
      let disposed = false
      let frame = 0
      const rect = (): ElectronRect | null => {
        const box = body.getBoundingClientRect()
        return box.width > 0 && box.height > 0
          ? { x: box.left, y: box.top, width: box.width, height: box.height }
          : null
      }
      const report = (): void => {
        if (frame) return
        frame = requestAnimationFrame(() => {
          frame = 0
          if (!disposed) void bridge.panelPage.setBounds(rect())
        })
      }
      const observer = new ResizeObserver(report)
      observer.observe(body)
      observer.observe(document.body)
      window.addEventListener("resize", report)
      document.addEventListener("once-panel-changed", report)
      const stop = bridge.panelPage.onChanged((next) => {
        if (disposed) return
        if (next) events.navigated(next)
        else events.closed()
      })
      const release = (): void => {
        disposed = true
        cancelAnimationFrame(frame)
        observer.disconnect()
        window.removeEventListener("resize", report)
        document.removeEventListener("once-panel-changed", report)
        stop()
      }
      // Shown once the panel has laid out, so the page appears where the body is.
      requestAnimationFrame(() => {
        if (!disposed) void bridge.panelPage.show(url, rect()).catch((error: unknown) => {
          console.error("Could not show the page in the panel", error)
          if (!disposed) events.closed()
        })
      })
      return {
        navigate: (next) => { void bridge.panelPage.show(next, rect()) },
        dispose: () => {
          if (disposed) return
          release()
          void bridge.panelPage.close()
        }
      }
    }
  }
}
