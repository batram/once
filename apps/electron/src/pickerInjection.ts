import { startSourcePicker } from "@once/ui-web/picker/sourcePicker"

// Injected into browser tabs by the main process (see browser/SourcePicker).
// Browser tabs intentionally have no preload, so the picker is delivered on
// demand: this bundle registers a starter that runs the overlay and resolves
// with the picked geny_match configuration JSON. It runs in an isolated world
// the page's scripts cannot see into, and it always installs its own starter:
// a starter that was already there is never adopted.

declare global {
  interface Window {
    __onceSourcePicker?: () => Promise<string | null>
  }
}

window.__onceSourcePicker = async () => {
  const result = await startSourcePicker()
  return result ? result.conf : null
}
