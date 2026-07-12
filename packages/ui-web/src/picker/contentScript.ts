import "webextension-polyfill"
import { startSourcePicker } from "./sourcePicker"

// Browser-extension entrypoint for the source picker: injected into the
// active tab by the extension background (see webext-shell pickerBackground)
// and reports the picked selector configuration back with a runtime message.

declare global {
  interface Window {
    __oncePickerActive?: boolean
  }
}

async function run(): Promise<void> {
  const result = await startSourcePicker()
  await browser.runtime.sendMessage({
    onceCommand: "sourcePicked",
    conf: result ? result.conf : null,
    url: result ? result.url : null
  })
}

if (!window.__oncePickerActive) {
  window.__oncePickerActive = true
  void run()
    .catch((error) => {
      console.error("Once source picker failed", error)
    })
    .finally(() => {
      window.__oncePickerActive = false
    })
}
