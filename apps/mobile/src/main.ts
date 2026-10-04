import { App } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"
import { createOnceApp } from "@once/app"
import { bindMobileExtensionSettings } from "./mobileExtensionSettings"
import {
  type BrowserNavigationEvent,
  createDefaultMobileNativeBridge,
  createInAppBrowserSurface,
  createMobileBrowserExtensions,
  createMobilePlatform
} from "@once/platform-mobile"
import {
  mountOnceUi,
  type BundledAddonFiles,
  PanelNavigation,
  ReaderDocumentHost,
  ReaderView,
  SourcePickerView,
  UndoButton
} from "@once/ui-web"
import { installStoryMenu } from "./storyMenu"
import { bindMobileBrowserExtensionSettings } from "./browserExtensionSettings"
import { bindMobileExtensionToolbar } from "./browserExtensionToolbar"
import { bindExtensionPageFrame } from "./extensionPageFrame"
import { attachEdgeSwipe } from "./edgeSwipe"
import { mobileAddonConversations } from "./addonConversations"
import { installReaderTtsHostBridge } from "./readerTtsHostBridge"
import { installReaderTtsControls } from "./readerTtsControls"
import { installReaderLinkHost } from "./readerLinks"
import { MobileReadingController } from "./readingController"
import { readingPageActions } from "./readingPageActions"
import { bindReloadStatus, RELOAD_SPIN_TIMEOUT_MS } from "./reloadStatus"
import {
  loadMobilePickerInjection,
  MobileSourcePicker
} from "./mobileSourcePicker"

declare const __ONCE_APP_VERSION__: string
declare const __ONCE_BUILD_CHANNEL__: "release" | "dev"
declare const __ONCE_BUILD_IDENTIFIER__: string
declare const __ONCE_BUNDLED_ADDONS__: BundledAddonFiles[]
declare const __ONCE_MOBILE_E2E__: boolean

const MOBILE_SCROLLBAR_IDLE_DELAY_MS = 650

// The touch-only navigation affordances, mounted here rather than in
// mountOnceUi so the desktop shells keep their existing ones only.
function mountTouchNavigation(reading: MobileReadingController): void {
  // Touch has no keyboard shortcut, no mouse back button and no room left on
  // the back gesture, so undo needs a control of its own.
  UndoButton.mount()
  // The mobile header suppresses the button's label, so the icon needs a name.
  document.querySelector<HTMLButtonElement>("#settings_section_back")
    ?.setAttribute("aria-label", "Back")
  // Edge swipes continue the same back stack as the hardware key and add the
  // forward half. Android's system gesture already owns the screen edges and
  // arrives as backButton, so the shell gesture is for iOS and the web harness.
  // The story list is the root of that stack, so it does not arm the gesture.
  if (Capacitor.getPlatform() === "android") return
  attachEdgeSwipe({
    onBack: () => void reading.handleBack(),
    onForward: () => void reading.handleForward(),
    enabled: () =>
      document.querySelector("#left_panel")?.getAttribute("active_panel") !== "stories"
  })
}

// "done" is a plain notice: shown like "loading" but without the spinner.
function showStartupState(
  message: string,
  state: "loading" | "error" | "ready" | "done" = "loading"
): void {
  // Default only before navigation has selected a panel. Startup can finish
  // after a tab switch; status updates must not navigate the user back.
  const panel = document.querySelector<HTMLElement>("#left_panel")
  if (panel && !panel.hasAttribute("active_panel")) {
    panel.setAttribute("active_panel", "stories")
  }
  const status = document.querySelector<HTMLElement>("#startup_status")
  const text = document.querySelector<HTMLElement>("#startup_status_text")
  const retry = document.querySelector<HTMLButtonElement>("#startup_retry")
  if (!status || !text || !retry) return
  status.dataset.state = state
  status.hidden = state === "ready"
  text.textContent = message
  retry.hidden = state !== "error"
  retry.onclick = state === "error" ? () => location.reload() : null
}

// The story-loading stage of startup. Bound before the UI mounts so the first,
// background story load reports through the pill the same way a later reload
// does. A startup failure owns the pill for good.
function beginStoryLoading(client: Parameters<typeof bindReloadStatus>[0]): void {
  showStartupState("Loading stories…")
  bindReloadStatus(client, (message, state) => {
    if (document.body.dataset.onceStage === "error") return
    showStartupState(message, state)
  })
}

function installTransientScrollbars(): void {
  const idleTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
  const indicators = new WeakMap<Element, HTMLElement>()

  document.addEventListener("scroll", (event) => {
    const scroller = event.target
    if (!(scroller instanceof HTMLElement)) return
    if (scroller.scrollHeight <= scroller.clientHeight) return

    scroller.classList.add("mobile_scrollbar_active")
    let indicator = indicators.get(scroller)
    if (!indicator) {
      indicator = document.createElement("div")
      indicator.className = "mobile_scroll_indicator"
      indicator.setAttribute("aria-hidden", "true")
      const owner = scroller.dataset.testid || scroller.id
      if (owner) indicator.dataset.scrollOwner = owner
      document.body.append(indicator)
      indicators.set(scroller, indicator)
    }

    const bounds = scroller.getBoundingClientRect()
    const visibleRatio = scroller.clientHeight / scroller.scrollHeight
    const indicatorHeight = Math.max(24, bounds.height * visibleRatio)
    const scrollRange = scroller.scrollHeight - scroller.clientHeight
    const travel = Math.max(0, bounds.height - indicatorHeight)
    const progress = scrollRange > 0 ? scroller.scrollTop / scrollRange : 0
    indicator.style.height = `${indicatorHeight}px`
    indicator.style.top = `${bounds.top + travel * progress}px`
    indicator.style.left = `${bounds.right - 5}px`
    indicator.style.opacity = "1"

    const previousTimer = idleTimers.get(scroller)
    if (previousTimer) clearTimeout(previousTimer)
    idleTimers.set(scroller, setTimeout(() => {
      scroller.classList.remove("mobile_scrollbar_active")
      indicator.style.opacity = "0"
      idleTimers.delete(scroller)
    }, MOBILE_SCROLLBAR_IDLE_DELAY_MS))
  }, true)
}

function captureNavigationListeners(browserSurface: ReturnType<typeof createInAppBrowserSurface>) {
  const navigationListeners = new Map<string, (event: BrowserNavigationEvent) => void>()
  if (__ONCE_MOBILE_E2E__) {
    const forTab = browserSurface.forTab?.bind(browserSurface)
    if (forTab) browserSurface.forTab = identity => {
      const scoped = forTab(identity)
      const addListener = scoped.addListener.bind(scoped)
      scoped.addListener = async (name, listener) => {
        if (name === "navigationCommitted" || name === "navigationFinished") {
          const key = `${identity.tabId}:${name}`
          navigationListeners.set(key, listener as (event: BrowserNavigationEvent) => void)
          const remove = await addListener(name, listener)
          return () => { navigationListeners.delete(key); remove() }
        }
        return addListener(name, listener)
      }
      return scoped
    }
  }
  return navigationListeners
}

function installMobileTestHooks(
  app: ReturnType<typeof createOnceApp>,
  reading: MobileReadingController,
  browserSurface: ReturnType<typeof createInAppBrowserSurface>,
  navigationListeners: Map<string, (event: BrowserNavigationEvent) => void>
): void {
  // Lets the e2e suite await queued story saves instead of pausing blindly.
  ;(window as { __onceE2E__?: unknown }).__onceE2E__ = {
    setTabPreview: (id: string, preview: string) => {
      const tab = reading.tabs.tabs.find(tab => tab.id === id)
      if (tab) reading.tabs.setPreview(id, tab.generation, tab.session.snapshot().currentUrl, preview)
    },
    settledStoryWrites: () => app.client.settledStoryWrites(),
    handleBack: () => reading.handleBack(),
    handleForward: () => reading.handleForward(),
    finishReading: (url: string, statusCode = 200) => {
      const state = reading.session.snapshot()
      const event = { navigationId: state.navigationId, url, statusCode, sourceUrl: state.pageContext?.sourceUrl }
      navigationListeners.get(`${reading.tabs.activeId}:navigationCommitted`)?.(event)
      navigationListeners.get(`${reading.tabs.activeId}:navigationFinished`)?.(event)
    },
    failReading: (message: string) => {
      const state = reading.session.snapshot()
      reading.session.navigationFailed(state.navigationId, state.currentUrl, message)
    },
    evaluateSurface: (script: string) => browserSurface.evaluateJavaScript(script),
    applyExtensionSettings: async () => browserSurface.applyExtensionSettings(
      await app.client.getFilterLists(),
      await app.client.getUserscripts()
    )
  }
}

async function startMobileApp(): Promise<void> {
  document.body.dataset.platform = "mobile"
  document.body.dataset.buildChannel = __ONCE_BUILD_CHANNEL__
  document.body.dataset.onceStage = "platform"
  showStartupState("Preparing the Android application…")
  installTransientScrollbars()

  const nativeBridge = createDefaultMobileNativeBridge()
  // The reading controller is built below; the closure only runs on a tap.
  const platform = createMobilePlatform(nativeBridge, undefined, {
    openInApp: (url) => reading.openBrowserUrl(url)
  })
  const app = createOnceApp(platform)
  const browserSurface = createInAppBrowserSurface((url) =>
    nativeBridge.openExternal(url)
  )
  const navigationListeners = captureNavigationListeners(browserSurface)
  installStoryMenu(browserSurface)
  const reader = new ReaderDocumentHost(
    document.querySelector<HTMLElement>("#reading_content") ?? document.body,
    new URL("reader-runtime.js", document.baseURI).href
  )
  const tts = installReaderTtsHostBridge((source) => reading.reader.isReaderWindow(source))
  const ttsControls = installReaderTtsControls(tts)
  const reading = new MobileReadingController(browserSurface, reader, ttsControls)
  await reading.install()
  // A tab owns its saved story even when the feed removes it. Refresh its
  // metadata from the working set whenever new evidence becomes available.
  const refreshTabStories = () => reading.tabs.refreshStories(app.client.getStorySnapshot())
  app.client.subscribe("storiesChanged", refreshTabStories)
  app.client.subscribe("storyChanged", refreshTabStories)
  refreshTabStories()
  // Web links leave the reader for the browser surface; mail goes to the system.
  installReaderLinkHost((source) => reading.reader.isReaderWindow(source), (url) => {
    if (url.startsWith("mailto:")) void nativeBridge.openExternal(url)
    else reading.openBrowserUrl(url)
  })
  ReaderView.mount(app.client)
  const sourcePicker = new MobileSourcePicker({
    surface: browserSurface,
    currentSurface: () => reading.prepareBrowserSurface(),
    currentUrl: () => reading.session.snapshot().currentUrl,
    openBrowserUrl: (url) => reading.openBrowserUrl(url),
    activateSurface: () => PanelNavigation.open_panel("reading"),
    loadInjection: loadMobilePickerInjection
  })
  await sourcePicker.install()
  SourcePickerView.mount(app.client, (url) => sourcePicker.pick(url))

  const extensionPages = bindExtensionPageFrame(browserSurface, open => reading.setExtensionPageOpen(open))
  if (Capacitor.getPlatform() === "android") {
    await App.addListener("backButton", () => {
      void extensionPages.close().then((closed) => closed || reading.handleBack()).then(async (handled) => {
        if (!handled) await app.client.settledStoryWrites().then(() => App.exitApp())
      })
    })
  }

  document.body.dataset.onceStage = "app-start"
  showStartupState("Opening saved stories and settings…")
  await app.start()
  if (Capacitor.isNativePlatform()) await bindMobileExtensionSettings(app.client, browserSurface)
  document.body.dataset.onceStage = "ui-mount"
  beginStoryLoading(app.client)
  await mountOnceUi(app.client, {
    reloadSpinTimeout: RELOAD_SPIN_TIMEOUT_MS,
    shell: "mobile",
    // A static asset beside the app: Capacitor's local server answers for
    // any frame, and the sandboxed frame's opaque origin keeps it apart.
    addonSandboxUrl: new URL("addon-sandbox.html", window.location.href).toString(),
    // The e2e build starts with no add-ons unless a spec asks for the shipped ones.
    bundledAddons: __ONCE_MOBILE_E2E__ && !new URL(window.location.href).searchParams.has("bundled-addons")
      ? [] : __ONCE_BUNDLED_ADDONS__,
    addonConversations: mobileAddonConversations,
    appVersion: __ONCE_APP_VERSION__,
    buildChannel: __ONCE_BUILD_CHANNEL__,
    buildIdentifier: __ONCE_BUILD_IDENTIFIER__,
    sourcePicker: true,
    // Only the native surface applies them; the browser build of the mobile
    // shell has no page of its own to run them in.
    extensionSettings: Capacitor.isNativePlatform() || __ONCE_MOBILE_E2E__,
    initialStoryLoad: __ONCE_MOBILE_E2E__ ? "disabled" : "cache",
    backgroundInitialStoryLoad: true,
    // Settings participates in the same back stack as the hardware key, so the
    // chevron stays live on the section index and leaves the panel from there.
    exitSettings: () => void reading.handleBack()
  })
  const browserExtensions = createMobileBrowserExtensions()
  if (browserExtensions) {
    bindMobileBrowserExtensionSettings(browserExtensions, url => reading.openBrowserUrl(url))
  }
  bindMobileExtensionToolbar(browserExtensions, browserSurface, readingPageActions(() => reading.session.snapshot().currentUrl))
  mountTouchNavigation(reading)
  if (__ONCE_MOBILE_E2E__) installMobileTestHooks(app, reading, browserSurface, navigationListeners)
  document.body.dataset.onceStage = "ready"
  document.body.dataset.onceReady = "true"
  showStartupState("Ready", "ready")
}

document.addEventListener("DOMContentLoaded", () => {
  void startMobileApp().catch((error) => {
    document.body.dataset.onceStage = "error"
    document.body.dataset.onceError = error instanceof Error ? error.message : String(error)
    showStartupState("Once could not finish starting.", "error")
    console.error("Failed to start Once mobile", error)
  })
})
