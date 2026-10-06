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
  /**
   * The shell's own Back/Forward availability. Given, the browser sheet shows
   * these and reports its Back/Forward as historyRequested instead of moving
   * the page itself: Reader-mode entries are not pages the engine holds.
   */
  history?: { back: boolean; forward: boolean }
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
  /** The engine's whole history list and its current position, where reported. */
  historyUrls?: string[]
  historyIndex?: number
}

/** The browser sheet's Back or Forward, for the shell to carry out. */
export interface BrowserHistoryRequestedEvent {
  tabId?: string
  generation?: string
  direction: "back" | "forward"
}

/** An item the shell adds to a native long-press menu, such as an add-on's page action. */
export interface ContextMenuItem {
  id: string
  label: string
}

/** A long-press in the shell's Reader frame; the native menu offers what applies. */
export interface ReaderContextMenuTarget {
  link?: string
  linkText?: string
  image?: string
  /** The article's address, sent as the image request's referrer. */
  referrer?: string
  /** The shell's own items for the link, shown after the built-in ones. */
  items?: ContextMenuItem[]
}

/**
 * A native long-press menu is opening on a link; the shell answers with its
 * items through setContextMenuItems. Unanswered, the menu opens without them.
 */
export interface ContextMenuRequestedEvent {
  tabId?: string
  generation?: string
  requestId: string
  link?: string
  linkText?: string
}

/** One of the shell's items was chosen from a long-press menu. */
export interface ContextMenuActionEvent {
  tabId?: string
  generation?: string
  id: string
  link?: string
  linkText?: string
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

/** A page-opened tab's script called window.close(); the shell closes the tab. */
export interface BrowserCloseRequestedEvent {
  tabId?: string
  generation?: string
}

/** The page started or stopped playing media; drives the tab's audio indicator. */
export interface BrowserMediaStateEvent {
  tabId?: string
  generation?: string
  playing: boolean
}

/** The page's long-press menu asked for a link in another tab. */
export interface BrowserOpenLinkRequestedEvent {
  tabId?: string
  generation?: string
  url: string
  /** Leave the current tab selected. */
  background: boolean
  /** Open it in the current tab instead, as a tap on the link would. */
  current?: boolean
}

export interface InAppBrowserSurfaceEvents {
  newTabRequested: BrowserNavigationEvent & BrowserTabIdentity
  navigationStarted: BrowserNavigationEvent
  navigationCommitted: BrowserNavigationEvent
  navigationFinished: BrowserNavigationEvent
  navigationFailed: BrowserNavigationFailedEvent
  historyChanged: BrowserHistoryEvent
  edgeSwipe: BrowserEdgeSwipeEvent
  closeRequested: BrowserCloseRequestedEvent
  openLinkRequested: BrowserOpenLinkRequestedEvent
  historyRequested: BrowserHistoryRequestedEvent
  contextMenuRequested: ContextMenuRequestedEvent
  contextMenuAction: ContextMenuActionEvent
  mediaStateChanged: BrowserMediaStateEvent
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
  /** Captures the visible content only; thumbnails are never persisted. */
  capturePreview?(options: { reader: boolean; bounds: BrowserSurfaceBounds }): Promise<string | null>
  readonly available: boolean
  forTab?(identity: BrowserTabIdentity): InAppBrowserSurface
  selectTab?(identity: BrowserTabIdentity | null): Promise<void>
  open(options: BrowserSurfaceOpenOptions): Promise<void>
  navigate(url: string): Promise<void>
  reload(): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  /** Moves to a position of the engine's history list (see historyChanged). */
  goToHistoryIndex?(index: number): Promise<void>
  /** Which directions the engine's own swipe may take (iOS); the shell takes the rest. */
  setHistoryGestures?(gestures: { back: boolean; forward: boolean }): Promise<void>
  /** Shows the native long-press menu for the Reader frame (Android). */
  showContextMenu?(target: ReaderContextMenuTarget): Promise<void>
  /** Answers contextMenuRequested with the shell's items for that menu. */
  setContextMenuItems?(requestId: string, items: ContextMenuItem[]): Promise<void>
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
  capturePreview(options: { reader: boolean; bounds: BrowserSurfaceBounds }): Promise<{ dataUrl?: string }>
  selectTab(options: { tabId: string | null; generation?: string }): Promise<void>
  open(options: BrowserSurfaceOpenOptions): Promise<void>
  navigate(options: { url: string }): Promise<void>
  reload(): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  goToHistoryIndex(options: { index: number }): Promise<void>
  setHistoryGestures(options: { back: boolean; forward: boolean }): Promise<void>
  showContextMenu(options: ReaderContextMenuTarget): Promise<void>
  setContextMenuItems(options: { requestId: string; items: ContextMenuItem[] }): Promise<void>
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
        const global = ["selectTab", "extensionPage", "applyExtensionSettings", "showContextMenu", "setContextMenuItems"].includes(property)
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
    capturePreview: async options => (await plugin.capturePreview(options)).dataUrl ?? null,
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
    goToHistoryIndex: (index) => plugin.goToHistoryIndex({ index }),
    async setHistoryGestures(gestures) {
      // Only iOS has engine swipes to hand over; elsewhere there is no method.
      try { await plugin.setHistoryGestures(gestures) } catch { /* nothing to configure */ }
    },
    showContextMenu: (target) => plugin.showContextMenu(target),
    setContextMenuItems: (requestId, items) => plugin.setContextMenuItems({ requestId, items }),
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
