import { startSourcePicker } from "@once/ui-web/picker/sourcePicker"

// Injected into browser tabs by the main process (see TabManager). Browser
// tabs intentionally have no preload, so the picker is delivered on demand
// through executeJavaScript: this bundle registers a starter that runs the
// overlay and resolves with the picked geny_match configuration JSON.

declare global {
  interface Window {
    __onceSourcePicker?: () => Promise<string | null>
  }
}

window.__onceSourcePicker ??= async () => {
  const result = await startSourcePicker()
  return result ? result.conf : null
}
