/** Copy an error report, including on WebViews that reject clipboard writes. */
export async function copyErrorText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Older embedded WebViews can expose the API but reject writes.
    }
  }

  const textarea = document.createElement("textarea")
  try {
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.className = "clipboard_textarea"
    document.body.append(textarea)
    textarea.select()
    return document.execCommand?.("copy") ?? false
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
