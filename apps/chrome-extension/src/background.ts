import browser from "webextension-polyfill"
import { installReaderBackground } from "@once/webext-shell/dist/readerBackground"
import { initChromeBackground } from "@once/webext-shell/dist/chromeBackground"

installReaderBackground(browser)
initChromeBackground((globalThis as typeof globalThis & { chrome?: Parameters<typeof initChromeBackground>[0] }).chrome)
