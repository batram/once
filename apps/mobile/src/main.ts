import { App } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"
import { createOnceApp } from "@once/app"
import {
  createDefaultMobileNativeBridge,
  createInAppBrowserSurface,
  createMobilePlatform
} from "@once/platform-mobile"
import {
  mountOnceUi,
  PanelNavigation,
  ReaderDocumentHost,
  ReaderView,
  SourcePickerView,
  UndoSnackbar
} from "@once/ui-web"
import { installStoryMenu } from "./storyMenu"
import { installReaderTtsHostBridge } from "./readerTtsHostBridge"
import { installReaderTtsControls } from "./readerTtsControls"
import { MobileReadingController } from "./readingController"
import {
  loadMobilePickerInjection,
  MobileSourcePicker
} from "./mobileSourcePicker"

declare const __ONCE_APP_VERSION__: string
declare const __ONCE_BUILD_CHANNEL__: "release" | "dev"
declare const __ONCE_BUILD_IDENTIFIER__: string
declare const __ONCE_MOBILE_E2E__: boolean

const MOBILE_SCROLLBAR_IDLE_DELAY_MS = 650

function showStartupState(
  message: string,
  state: "loading" | "error" | "ready" = "loading"
): void {
  document.querySelector<HTMLElement>("#left_panel")
    ?.setAttribute("active_panel", "stories")
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

async function startMobileApp(): Promise<void> {
  document.body.dataset.platform = "mobile"
  document.body.dataset.buildChannel = __ONCE_BUILD_CHANNEL__
  document.body.dataset.onceStage = "platform"
  showStartupState("Preparing the Android application…")
  installTransientScrollbars()

  const nativeBridge = createDefaultMobileNativeBridge()
  const platform = createMobilePlatform(nativeBridge)
  const app = createOnceApp(platform)
  const browserSurface = createInAppBrowserSurface((url) =>
    nativeBridge.openExternal(url)
  )
  installStoryMenu(browserSurface)
  const reader = new ReaderDocumentHost(
    document.querySelector<HTMLElement>("#reading_content") ?? document.body,
    new URL("reader-runtime.js", document.baseURI).href
  )
  const tts = installReaderTtsHostBridge((source) => reader.isReaderWindow(source))
  const ttsControls = installReaderTtsControls(tts)
  const reading = new MobileReadingController(browserSurface, reader, ttsControls)
  await reading.install()
  ReaderView.mount(app.client)
  const sourcePicker = new MobileSourcePicker({
    surface: browserSurface,
    openBrowserUrl: (url) => reading.openBrowserUrl(url),
    activateSurface: () => PanelNavigation.open_panel("reading"),
    loadInjection: loadMobilePickerInjection
  })
  await sourcePicker.install()
  SourcePickerView.mount(app.client, (url) => sourcePicker.pick(url))

  if (Capacitor.getPlatform() === "android") {
    await App.addListener("backButton", () => {
      void reading.handleBack().then((handled) => {
        if (!handled) void App.exitApp()
      })
    })
  }

  document.body.dataset.onceStage = "app-start"
  showStartupState("Opening saved stories and settings…")
  await app.start()
  document.body.dataset.onceStage = "ui-mount"
  showStartupState("Loading stories…")
  await mountOnceUi(app.client, {
    appVersion: __ONCE_APP_VERSION__,
    buildChannel: __ONCE_BUILD_CHANNEL__,
    buildIdentifier: __ONCE_BUILD_IDENTIFIER__,
    sourcePicker: true,
    initialStoryLoad: __ONCE_MOBILE_E2E__ ? "disabled" : "network",
    // Settings participates in the same back stack as the hardware key, so the
    // chevron stays live on the section index and leaves the panel from there.
    exitSettings: () => void reading.handleBack()
  })
  // Touch has no keyboard shortcut, no mouse back button and no room left on
  // the back gesture, so undo has to offer itself. Mounted here rather than in
  // mountOnceUi so the desktop shells keep their existing affordances only.
  UndoSnackbar.mount()
  // The mobile header suppresses the button's label, so the icon needs a name.
  document.querySelector<HTMLButtonElement>("#settings_section_back")
    ?.setAttribute("aria-label", "Back")
  if (__ONCE_MOBILE_E2E__) {
    // Lets the e2e suite await queued story saves instead of pausing blindly.
    ;(window as { __onceE2E__?: unknown }).__onceE2E__ = {
      settledStoryWrites: () => app.client.settledStoryWrites(),
      handleBack: () => reading.handleBack()
    }
  }
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
