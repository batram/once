import type { StoryPageContext } from "@once/core"
import { Capacitor, PluginListenerHandle, registerPlugin } from "@capacitor/core"
import type { FilterListsDocument, UserscriptsDocument } from "@once/core"
import { parseUserscript } from "@once/core"

export interface BrowserSurfaceBounds {
  /** CSS viewport pixels. Native implementations perform scale conversion. */
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserTabIdentity {
  tabId: string
  generation: string
}

export interface BrowserSurfaceOpenOptions {
  url: string
  bounds: BrowserSurfaceBounds
  visible: boolean
}

export type NativeOverlayAnchor = BrowserSurfaceBounds

export interface NativeOverlayMenuItem {
  iconDataUrl?: string
  id: string
  label: string
  enabled: boolean
  /** Resolves instead of `id` when the row's trailing settings control is chosen. */
  settingsId?: string
}

export interface NativeOverlayMenuOptions {
  browserControls?: boolean
  /**
   * Whether the shell is currently showing its dark theme, so the native
   * browser sheet can match it. Omitted, the sheet follows the system.
   */
  dark?: boolean
  title?: string
  items: NativeOverlayMenuItem[]
  anchor?: NativeOverlayAnchor
}

export interface NativeOverlayPromptOptions {
  title?: string
  message: string
  value?: string
  confirmLabel?: string
  cancelLabel?: string
}

export interface BrowserNavigationEvent extends StoryPageContext {
  tabId?: string
  generation?: string
  title?: string
  navigationId: number
  url: string
}

export interface BrowserNavigationFailedEvent extends BrowserNavigationEvent {
  code: number
  message: string
}

export interface BrowserHistoryEvent extends BrowserNavigationEvent {
  canGoBack: boolean
  canGoForward: boolean
}

/**
 * The native page swiped from a screen edge with no history in that
 * direction: iOS lets the web view consume edge swipes it can honour itself,
 * so only the ones it cannot reach the shell, which continues them through
 * its own back stack (back) or settings history (forward).
 */
export interface BrowserEdgeSwipeEvent {
  tabId?: string
  generation?: string
  direction: "back" | "forward"
}

/** The extension page the native host shows, if any; the shell frames it. */
export interface ExtensionPageState {
  open: boolean
  popup: boolean
  title: string
  status: string
  count: number
}

export interface ExtensionPageCommand {
  action: "close" | "reload" | "bounds"
  bounds?: BrowserSurfaceBounds
}

export interface InAppBrowserSurfaceEvents {
  newTabRequested: BrowserNavigationEvent & BrowserTabIdentity
  navigationStarted: BrowserNavigationEvent
  navigationCommitted: BrowserNavigationEvent
  navigationFinished: BrowserNavigationEvent
  navigationFailed: BrowserNavigationFailedEvent
  historyChanged: BrowserHistoryEvent
  edgeSwipe: BrowserEdgeSwipeEvent
  extensionPageChanged: ExtensionPageState
}

export type BrowserSurfaceEventName = keyof InAppBrowserSurfaceEvents

export interface PageFindOptions {
  /** Search towards the end of the page; false walks back. */
  forward?: boolean
}

/** What the engine reports after one find step. */
export interface PageFindResult {
  found: boolean
  /** The step ran off the end and continued from the other end. */
  wrapped: boolean
  /** 1-based index of the selected match, 0 when there is none. */
  current: number
  total: number
}

export interface InAppBrowserSurface {
  readonly available: boolean
  forTab?(identity: BrowserTabIdentity): InAppBrowserSurface
  selectTab?(identity: BrowserTabIdentity | null): Promise<void>
  open(options: BrowserSurfaceOpenOptions): Promise<void>
  navigate(url: string): Promise<void>
  reload(): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  setBounds(bounds: BrowserSurfaceBounds): Promise<void>
  setVisible(visible: boolean): Promise<void>
  showMenu(options: NativeOverlayMenuOptions): Promise<string | null>
  showPrompt(options: NativeOverlayPromptOptions): Promise<string | null>
  evaluateJavaScript(script: string): Promise<string | null>
  /**
   * Selects the next (or previous) occurrence of `query` in the open page and
   * says how many there are. Null when the surface cannot search.
   */
  findInPage(query: string, options?: PageFindOptions): Promise<PageFindResult | null>
  /** Drops the find highlights and selection. */
  clearFind(): Promise<void>
  /**
   * Opens the platform's own find panel over the page, which can search
   * documents the shell cannot reach, such as PDFs in the native viewer.
   * False when the platform has none, so the caller shows its own bar.
   */
  presentFind(): Promise<boolean>
  applyExtensionSettings(
    filterLists: FilterListsDocument,
    userscripts: UserscriptsDocument
  ): Promise<void>
  extensionPage(command: ExtensionPageCommand): Promise<void>
  close(): Promise<void>
  addListener<K extends BrowserSurfaceEventName>(
    event: K,
    listener: (payload: InAppBrowserSurfaceEvents[K]) => void
  ): Promise<() => void>
}

interface NativeInAppBrowserPlugin {
  selectTab(options: { tabId: string | null; generation?: string }): Promise<void>
  open(options: BrowserSurfaceOpenOptions): Promise<void>
  navigate(options: { url: string }): Promise<void>
  reload(): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  setBounds(options: BrowserSurfaceBounds): Promise<void>
  setVisible(options: { visible: boolean }): Promise<void>
  showMenu(options: NativeOverlayMenuOptions): Promise<{ id?: string }>
  showPrompt(
    options: NativeOverlayPromptOptions
  ): Promise<{ value?: string }>
  evaluateJavaScript(options: { script: string }): Promise<{ value?: string }>
  findInPage(options: { query: string; forward: boolean }): Promise<PageFindResult>
  clearFind(): Promise<void>
  presentFind(): Promise<{ presented?: boolean }>
  applyExtensionSettings(options: NativeExtensionSettings): Promise<void>
  extensionPage(options: ExtensionPageCommand): Promise<void>
  close(): Promise<void>
  addListener(
    event: BrowserSurfaceEventName,
    listener: (payload: unknown) => void
  ): Promise<PluginListenerHandle>
}

interface NativeExtensionSettings {
  filterLists: FilterListsDocument
  userscripts: {
    version: number
    scripts: Array<{
      id: string
      name: string
      body: string
      enabled: boolean
      matches: readonly string[]
      includes: readonly string[]
      excludes: readonly string[]
      runAt: string
      noFrames: boolean
    }>
  }
}

function nativeExtensionSettings(
  filterLists: FilterListsDocument,
  userscripts: UserscriptsDocument
): NativeExtensionSettings {
  return {
    filterLists,
    userscripts: {
      version: userscripts.version,
      scripts: userscripts.scripts.map((script) => {
        const parsed = parseUserscript(script.source)
        return {
          id: script.id,
          name: script.name,
          body: parsed.body,
          enabled: script.enabled,
          matches: parsed.metadata.matches,
          includes: parsed.metadata.includes,
          excludes: parsed.metadata.excludes,
          runAt: parsed.metadata.runAt,
          noFrames: parsed.metadata.noFrames
        }
      })
    }
  }
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

/** Each scoped adapter owns one native page, including all asynchronous commands. */
export function createNativeInAppBrowserSurface(identity?: BrowserTabIdentity): InAppBrowserSurface {
  let selectedIdentity: BrowserTabIdentity | undefined
  const plugin = new Proxy(NativeInAppBrowser, {
    get(target, property: keyof NativeInAppBrowserPlugin) {
      if (property === "addListener") return target.addListener.bind(target)
      return (options: object = {}) => {
        const global = ["selectTab", "extensionPage", "applyExtensionSettings"].includes(property)
        return (target[property] as (options: object) => Promise<unknown>)({ ...options, ...(global ? {} : identity ?? selectedIdentity) })
      }
    }
  })
  return {
    forTab: createNativeInAppBrowserSurface,
    selectTab: (tab) => {
      selectedIdentity = tab ?? undefined
      return NativeInAppBrowser.selectTab(tab ?? { tabId: null })
    },
    available: true,
    async open(options) {
      assertUrl(options.url)
      await plugin.open({
        ...options,
        bounds: normalizeBounds(options.bounds)
      })
    },
    async navigate(url) {
      assertUrl(url)
      await plugin.navigate({ url })
    },
    reload: () => plugin.reload(),
    goBack: () => plugin.goBack(),
    goForward: () => plugin.goForward(),
    setBounds: (bounds) => plugin.setBounds(normalizeBounds(bounds)),
    setVisible: (visible) => plugin.setVisible({ visible }),
    async showMenu(options) {
      const result = await plugin.showMenu({
        ...options,
        anchor: options.anchor ? normalizeBounds(options.anchor) : undefined
      })
      return result?.id ?? null
    },
    async showPrompt(options) {
      const result = await plugin.showPrompt(options)
      return result?.value ?? null
    },
    async evaluateJavaScript(script) {
      const result = await plugin.evaluateJavaScript({ script })
      return result?.value ?? null
    },
    async findInPage(query, options) {
      const result = await plugin.findInPage({
        query,
        forward: options?.forward !== false
      })
      return {
        found: result.found === true,
        wrapped: result.wrapped === true,
        current: Number(result.current) || 0,
        total: Number(result.total) || 0
      }
    },
    clearFind: () => plugin.clearFind(),
    async presentFind() {
      // Platforms without the method reject the call; that is a plain "no".
      try {
        return (await plugin.presentFind()).presented === true
      } catch {
        return false
      }
    },
    applyExtensionSettings: (filterLists, userscripts) =>
      plugin.applyExtensionSettings(
        nativeExtensionSettings(filterLists, userscripts)
      ),
    extensionPage: (command) => plugin.extensionPage(
      command.bounds ? { ...command, bounds: normalizeBounds(command.bounds) } : command
    ),
    close: () => plugin.close(),
    async addListener(event, listener) {
      const handle = await plugin.addListener(
        event,
        (payload: unknown) => {
          const event = payload as BrowserNavigationEvent
          if (identity && (event.tabId !== identity.tabId || event.generation !== identity.generation)) return
          listener(payload as never)
        }
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
  openExternal: (url: string) => Promise<void>,
  identity?: BrowserTabIdentity,
  forwardEvent?: (event: BrowserSurfaceEventName, payload: never) => void
): InAppBrowserSurface {
  let currentUrl = ""
  const listeners = new Map<BrowserSurfaceEventName, Set<(payload: never) => void>>()
  const emit = <K extends BrowserSurfaceEventName>(
    event: K,
    payload: InAppBrowserSurfaceEvents[K]
  ): void => {
    forwardEvent?.(event, payload as never)
    listeners.get(event)?.forEach((listener) => listener(payload as never))
  }
  let navigationId = 0

  const open = async (url: string): Promise<void> => {
    assertUrl(url)
    currentUrl = url
    navigationId += 1
    const payload = { navigationId, url, ...identity }
    emit("navigationStarted", payload)
    await openExternal(url)
    emit("navigationCommitted", payload)
    emit("historyChanged", { ...payload, canGoBack: false, canGoForward: false })
    emit("navigationFinished", payload)
  }

  return {
    available: false,
    forTab: (tab) => createFallbackInAppBrowserSurface(openExternal, tab, emit),
    selectTab: async () => undefined,
    open: ({ url }) => open(url),
    navigate: open,
    reload: () => currentUrl ? open(currentUrl) : Promise.resolve(),
    goBack: async () => undefined,
    goForward: async () => undefined,
    setBounds: async () => undefined,
    setVisible: async () => undefined,
    showMenu: async () => null,
    showPrompt: async () => null,
    evaluateJavaScript: async () => null,
    findInPage: async () => null,
    clearFind: async () => undefined,
    presentFind: async () => false,
    applyExtensionSettings: async () => undefined,
    extensionPage: async () => undefined,
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
