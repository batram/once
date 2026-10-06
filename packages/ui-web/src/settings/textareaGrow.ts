/**
 * Lets a text area grow with its lines instead of scrolling inside a small
 * box: touch browsers offer no corner to drag it taller.
 */
export function growWithContent(textarea: HTMLTextAreaElement): () => void {
  const fit = () => {
    textarea.style.height = "auto"
    textarea.style.height = `${textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight}px`
  }
  textarea.addEventListener("input", fit)
  // Shown at last, or given another width, its lines wrap anew. Height
  // changes are its own and need no second pass.
  let width = 0
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width)
      if (next === width) return
      width = next
      if (next) fit()
    }).observe(textarea)
  }
  return fit
}
