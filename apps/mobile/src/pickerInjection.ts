import { startSourcePicker } from "@once/ui-web/picker/sourcePicker"

// Evaluated by the shell in the world it keeps apart from the page's scripts
// (see mobileSourcePicker). Always installs its own starter: one that was
// already there is never adopted.

declare global {
  interface Window {
    __onceSourcePicker?: () => Promise<string | null>
  }
}

window.__onceSourcePicker = async () => {
  const result = await startSourcePicker()
  return result ? result.conf : null
}
