import { requireElement } from "../dom"

export function scrollTextareaSelectionIntoView(
  textarea: HTMLTextAreaElement,
  startIndex: number
): void {
  const lineIndex = textarea.value.slice(0, startIndex).split("\n").length - 1
  requestAnimationFrame(() => {
    textarea.closest(".settings_block")?.scrollIntoView({
      block: "nearest"
    })
    const highlights = textarea
      .closest(".input_container")
      ?.querySelector<HTMLElement>(".highlights")
    const mirroredLine = highlights?.children.item(lineIndex) as
      | HTMLElement
      | null
    const style = getComputedStyle(textarea)
    const lineHeight =
      parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
    const targetTop = mirroredLine
      ? mirroredLine.offsetTop
      : (parseFloat(style.paddingTop) || 0) + lineIndex * lineHeight
    const targetHeight = mirroredLine?.offsetHeight || lineHeight
    const centeredTop =
      targetTop - Math.max(0, (textarea.clientHeight - targetHeight) / 2)

    textarea.scrollTop = Math.max(
      0,
      Math.min(centeredTop, textarea.scrollHeight - textarea.clientHeight)
    )
    textarea.dispatchEvent(new Event("scroll"))
  })
}

export function highlightTextareaContent(
  textareaId: string,
  searchText: string,
  shouldOpenPanel: boolean,
  triggerInputEvent: boolean,
  openSettingsPanel: () => void
): void {
  if (shouldOpenPanel) openSettingsPanel()
  const textarea = requireElement<HTMLTextAreaElement>(`#${textareaId}`)
  if (triggerInputEvent) textarea.dispatchEvent(new Event("input"))
  if (!shouldOpenPanel) return

  const text = textarea.value
  const lines = text.split("\n")
  let startIndex = -1
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== searchText.trim()) continue
    startIndex = index === 0
      ? 0
      : lines.slice(0, index).join("\n").length + 1
    break
  }
  if (startIndex === -1) startIndex = text.indexOf(searchText)
  if (startIndex === -1) {
    console.warn(
      `SettingsPanel: could not find text in ${textareaId}`,
      searchText
    )
    return
  }
  console.log(`SettingsPanel: scrolling to ${textareaId}`, searchText)
  textarea.focus({ preventScroll: true })
  textarea.setSelectionRange(startIndex, startIndex + searchText.length)
  scrollTextareaSelectionIntoView(textarea, startIndex)
}
