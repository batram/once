import { startSourcePicker } from "@once/ui-web/picker/sourcePicker"

declare global {
  interface Window {
    __onceSourcePicker?: () => Promise<string | null>
  }
}

window.__onceSourcePicker ??= async () => {
  const result = await startSourcePicker()
  return result ? result.conf : null
}
