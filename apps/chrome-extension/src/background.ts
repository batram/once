import browser from "webextension-polyfill"
import { installReaderBackground } from "@once/webext-shell/dist/readerBackground"
import { installPickerBackground } from "@once/webext-shell/dist/pickerBackground"
import { initChromeBackground } from "@once/webext-shell/dist/chromeBackground"

installReaderBackground(browser)
installPickerBackground(browser)
initChromeBackground((globalThis as typeof globalThis & { chrome?: Parameters<typeof initChromeBackground>[0] }).chrome)
