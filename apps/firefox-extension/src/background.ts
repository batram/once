import browser from "webextension-polyfill"
import { installReaderBackground } from "@once/webext-shell/dist/readerBackground"
import { initFirefoxBackground } from "@once/webext-shell/dist/firefoxBackground"

installReaderBackground(browser)
initFirefoxBackground(browser).catch((error: unknown) => {
  console.error("Unable to initialize the Firefox background page", error)
})
