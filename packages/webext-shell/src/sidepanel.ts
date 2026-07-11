import browser = require("webextension-polyfill")

import { createOnceApp } from "@once/app"
import { mountOnceUi } from "@once/ui-web"
import { createWebExtPlatform } from "@once/platform-webext"

declare const __ONCE_WEBEXT_TARGET__: "chrome" | "firefox"
declare const __ONCE_BUILD_CHANNEL__: "release" | "dev"

document.addEventListener("DOMContentLoaded", async () => {
  const platform = createWebExtPlatform(browser)
  const testMode = new URLSearchParams(window.location.search).has("once-e2e")
  if (testMode) {
    const state = await browser.storage.local.get("onceE2ESeeded")
    if (!state.onceE2ESeeded) {
      await platform.listStore.set("story_sources", [])
      await browser.storage.local.set({ onceE2ESeeded: true })
    }
  }
  const app = createOnceApp(platform)
  const client = app.client

  await app.start()
  await mountOnceUi(client, {
    appVersion: browser.runtime.getManifest().version,
    buildChannel: __ONCE_BUILD_CHANNEL__,
    showHoveredLinks: __ONCE_WEBEXT_TARGET__ === "chrome",
    initialStoryLoad: testMode ? "disabled" : "network"
  })
  document.body.dataset.onceReady = "true"
})
