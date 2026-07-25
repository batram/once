import { Capacitor, PluginListenerHandle, registerPlugin } from "@capacitor/core"

export interface BrowserSurfaceBounds {
  /** CSS viewport pixels. Native implementations perform scale conversion. */
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserSurfaceOpenOptions {
  url: string
  bounds: BrowserSurfaceBounds
  visible: boolean
}

export interface BrowserNavigationEvent {
  navigationId: number
  url: string
}

export interface BrowserNavigationFailedEvent extends BrowserNavigationEvent {
  code: number
  message: string
}

export interface BrowserHistoryEvent extends BrowserNavigationEvent {
  canGoBack: boolean
}

export interface InAppBrowserSurfaceEvents {
  navigationStarted: BrowserNavigationEvent
  navigationCommitted: BrowserNavigationEvent
  navigationFinished: BrowserNavigationEvent
  navigationFailed: BrowserNavigationFailedEvent
  historyChanged: BrowserHistoryEvent
}

export type BrowserSurfaceEventName = keyof InAppBrowserSurfaceEvents

export interface InAppBrowserSurface {
  readonly available: boolean
  open(options: BrowserSurfaceOpenOptions): Promise<void>
  navigate(url: string): Promise<void>
  reload(): Promise<void>
  goBack(): Promise<void>
  setBounds(bounds: BrowserSurfaceBounds): Promise<void>
  setVisible(visible: boolean): Promise<void>
  close(): Promise<void>
  addListener<K extends BrowserSurfaceEventName>(
    event: K,
    listener: (payload: InAppBrowserSurfaceEvents[K]) => void
  ): Promise<() => void>
}

interface NativeInAppBrowserPlugin {
  open(options: BrowserSurfaceOpenOptions): Promise<void>
  navigate(options: { url: string }): Promise<void>
  reload(): Promise<void>
  goBack(): Promise<void>
  setBounds(options: BrowserSurfaceBounds): Promise<void>
  setVisible(options: { visible: boolean }): Promise<void>
  close(): Promise<void>
  addListener(
    event: BrowserSurfaceEventName,
    listener: (payload: unknown) => void
  ): Promise<PluginListenerHandle>
}

const NativeInAppBrowser =
  registerPlugin<NativeInAppBrowserPlugin>("InAppBrowserSurface")

export function isEmbeddableUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

function assertUrl(url: string): void {
  if (!isEmbeddableUrl(url)) {
    throw new TypeError("Embedded browsing only supports http and https URLs")
  }
}

function normalizeBounds(bounds: BrowserSurfaceBounds): BrowserSurfaceBounds {
  const finite = (value: number): number =>
    Number.isFinite(value) ? Math.max(0, value) : 0
  return {
    x: finite(bounds.x),
    y: finite(bounds.y),
    width: finite(bounds.width),
    height: finite(bounds.height)
  }
}

/** Native adapter. One plugin-owned view is reused until close(). */
export function createNativeInAppBrowserSurface(): InAppBrowserSurface {
  return {
    available: true,
    async open(options) {
      assertUrl(options.url)
      await NativeInAppBrowser.open({
        ...options,
        bounds: normalizeBounds(options.bounds)
      })
    },
    async navigate(url) {
      assertUrl(url)
      await NativeInAppBrowser.navigate({ url })
    },
    reload: () => NativeInAppBrowser.reload(),
    goBack: () => NativeInAppBrowser.goBack(),
    setBounds: (bounds) => NativeInAppBrowser.setBounds(normalizeBounds(bounds)),
    setVisible: (visible) => NativeInAppBrowser.setVisible({ visible }),
    close: () => NativeInAppBrowser.close(),
    async addListener(event, listener) {
      const handle = await NativeInAppBrowser.addListener(
        event,
        listener as (payload: unknown) => void
      )
      return () => {
        void handle.remove()
      }
    }
  }
}

/**
 * Browser harness fallback. It preserves the API contract, but intentionally
 * exits to a normal browser instead of pretending an iframe proves embedding.
 */
export function createFallbackInAppBrowserSurface(
  openExternal: (url: string) => Promise<void>
): InAppBrowserSurface {
  let currentUrl = ""
  const listeners = new Map<BrowserSurfaceEventName, Set<(payload: never) => void>>()
  const emit = <K extends BrowserSurfaceEventName>(
    event: K,
    payload: InAppBrowserSurfaceEvents[K]
  ): void => {
    listeners.get(event)?.forEach((listener) => listener(payload as never))
  }
  let navigationId = 0

  const open = async (url: string): Promise<void> => {
    assertUrl(url)
    currentUrl = url
    navigationId += 1
    const payload = { navigationId, url }
    emit("navigationStarted", payload)
    await openExternal(url)
    emit("navigationCommitted", payload)
    emit("historyChanged", { ...payload, canGoBack: false })
    emit("navigationFinished", payload)
  }

  return {
    available: false,
    open: ({ url }) => open(url),
    navigate: open,
    reload: () => currentUrl ? open(currentUrl) : Promise.resolve(),
    goBack: async () => undefined,
    setBounds: async () => undefined,
    setVisible: async () => undefined,
    close: async () => {
      currentUrl = ""
    },
    async addListener(event, listener) {
      const bucket = listeners.get(event) ?? new Set()
      bucket.add(listener as (payload: never) => void)
      listeners.set(event, bucket)
      return () => bucket.delete(listener as (payload: never) => void)
    }
  }
}

export function createInAppBrowserSurface(
  openExternal: (url: string) => Promise<void>
): InAppBrowserSurface {
  return Capacitor.isNativePlatform()
    ? createNativeInAppBrowserSurface()
    : createFallbackInAppBrowserSurface(openExternal)
}
