import { App } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"
import { createOnceApp } from "@once/app"
import {
  createDefaultMobileNativeBridge,
  createInAppBrowserSurface,
  createMobilePlatform
} from "@once/platform-mobile"
import { mountOnceUi, ReaderDocumentHost, ReaderView } from "@once/ui-web"
import { installStoryMenu } from "./storyMenu"
import { installReaderTtsHostBridge } from "./readerTtsHostBridge"
import { installReaderTtsControls } from "./readerTtsControls"
import { MobileReadingController } from "./readingController"

declare const __ONCE_APP_VERSION__: string
declare const __ONCE_BUILD_CHANNEL__: "release" | "dev"
declare const __ONCE_BUILD_IDENTIFIER__: string
declare const __ONCE_MOBILE_E2E__: boolean

async function startMobileApp(): Promise<void> {
  document.body.dataset.platform = "mobile"
  document.body.dataset.buildChannel = __ONCE_BUILD_CHANNEL__
  document.body.dataset.onceStage = "platform"

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

  if (Capacitor.getPlatform() === "android") {
    await App.addListener("backButton", () => {
      void reading.handleBack().then((handled) => {
        if (!handled) void App.exitApp()
      })
    })
  }

  document.body.dataset.onceStage = "app-start"
  await app.start()
  document.body.dataset.onceStage = "ui-mount"
  await mountOnceUi(app.client, {
    appVersion: __ONCE_APP_VERSION__,
    buildChannel: __ONCE_BUILD_CHANNEL__,
    buildIdentifier: __ONCE_BUILD_IDENTIFIER__,
    sourcePicker: false,
    initialStoryLoad: __ONCE_MOBILE_E2E__ ? "disabled" : "network"
  })
  if (__ONCE_MOBILE_E2E__) {
    // Lets the e2e suite await queued story saves instead of pausing blindly.
    ;(window as { __onceE2E__?: unknown }).__onceE2E__ = {
      settledStoryWrites: () => app.client.settledStoryWrites(),
      handleBack: () => reading.handleBack()
    }
  }
  document.body.dataset.onceStage = "ready"
  document.body.dataset.onceReady = "true"
}

document.addEventListener("DOMContentLoaded", () => {
  void startMobileApp().catch((error) => {
    document.body.dataset.onceStage = "error"
    document.body.dataset.onceError = error instanceof Error ? error.message : String(error)
    console.error("Failed to start Once mobile", error)
  })
})
