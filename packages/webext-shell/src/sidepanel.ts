import "webextension-polyfill"

import { createOnceApp } from "@once/app"
import { mountOnceUi } from "@once/ui-web"
import { createWebExtPlatform } from "@once/platform-webext"

declare const __ONCE_WEBEXT_TARGET__: "chrome" | "firefox"

document.addEventListener("DOMContentLoaded", async () => {
  const platform = createWebExtPlatform()
  const app = createOnceApp(platform)
  const client = app.client

  await app.start()
  await mountOnceUi(client, {
    showHoveredLinks: __ONCE_WEBEXT_TARGET__ === "chrome",
  })
})
