import { App } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"
import { createOnceApp } from "@once/app"
import { createMobilePlatform } from "@once/platform-mobile"
import { mountOnceUi, ReaderDocumentHost, ReaderView } from "@once/ui-web"
import { installStoryActionSheet } from "./actionSheet"
import "./mobile.css"

declare const __ONCE_APP_VERSION__: string
declare const __ONCE_BUILD_CHANNEL__: "release" | "dev"
declare const __ONCE_MOBILE_E2E__: boolean

async function startMobileApp(): Promise<void> {
  document.body.dataset.platform = "mobile"
  document.body.dataset.buildChannel = __ONCE_BUILD_CHANNEL__
  document.body.dataset.onceStage = "platform"

  installStoryActionSheet()
  const platform = createMobilePlatform()
  const app = createOnceApp(platform)
  const readerRuntime = "reader-runtime.js"
  const reader = new ReaderDocumentHost(
    document.body,
    new URL(readerRuntime, document.baseURI).href
  )
  ReaderView.mount(app.client, (html) => reader.open(html))

  if (Capacitor.getPlatform() === "android") {
    await App.addListener("backButton", () => {
      if (reader.isOpen()) reader.close()
      else void App.exitApp()
    })
  }

  document.body.dataset.onceStage = "app-start"
  await app.start()
  document.body.dataset.onceStage = "ui-mount"
  await mountOnceUi(app.client, {
    appVersion: __ONCE_APP_VERSION__,
    buildChannel: __ONCE_BUILD_CHANNEL__,
    sourcePicker: false,
    initialStoryLoad: __ONCE_MOBILE_E2E__ ? "disabled" : "network"
  })
  if (__ONCE_MOBILE_E2E__) {
    // Lets the e2e suite await queued story saves instead of pausing blindly.
    ;(window as { __onceE2E__?: unknown }).__onceE2E__ = {
      settledStoryWrites: () => app.client.settledStoryWrites()
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
